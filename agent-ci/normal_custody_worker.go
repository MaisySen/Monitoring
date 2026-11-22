package main

import (
	"context"
	"time"
)

// One owner per store, one request in flight. Constructor takes the exclusive
// mode explicitly, verifies the store's fixed destination/key binding, and does
// not start anything. An integration must not construct multiple workers/store.
type normalWorker struct {
	s        *normalStore
	h        *normalHTTP
	clock    normalClock
	gate     chan struct{}
	last     normalStamp
	haveLast bool
	next     map[string]int64
}

func newNormalWorker(mode string, s *normalStore, h *normalHTTP) (*normalWorker, error) {
	if mode != "test-v1" || s == nil || h == nil {
		return nil, normalInvalid
	}
	b, e := normalBinding(h.origin, h.key)
	if e != nil || !sameNormalBinding(b, s.binding) {
		return nil, normalInvalid
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.workerClaimed || s.db == nil || s.poisoned {
		return nil, normalInvalid
	}
	s.workerClaimed = true
	return &normalWorker{s: s, h: h, clock: newNormalClock(), gate: make(chan struct{}, 1), next: map[string]int64{}}, nil
}
func (w *normalWorker) sample() normalStamp {
	n := w.clock()
	// Clock discontinuity or an unobserved session gap >=24h is receipt-only.
	if w.haveLast && !normalElapsed(w.last, n, 24*time.Hour) {
		w.s.distrust()
	}
	w.last = n
	w.haveLast = true
	return n
}

// step handles at most ONE record and at most capability+lease+DATA, or ONE
// receipt. No automatic DATA resend. Failures become receipt-only iff an
// original lease+mayHaveSent exists; a lost lease can use the second pre-DATA
// reservation in-session only. No request can allocate a replacement after DATA.
func (w *normalWorker) step(ctx context.Context) error {
	select {
	case w.gate <- struct{}{}:
		defer func() { <-w.gate }()
	default:
		return normalInvalid
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	n := w.sample()
	if e := w.s.sweep(n.wall); e != nil {
		return e
	}
	status, e := w.s.status()
	if e != nil {
		return e
	}
	live := map[string]bool{}
	for _, x := range status.Entries {
		live[x.ID] = true
	}
	for id := range w.next {
		if !live[id] {
			delete(w.next, id)
		}
	}
	for _, x := range status.Entries {
		if x.State != "custody" || n.wall < w.next[x.ID] {
			continue
		}
		r, e := w.s.lookup(x.ID, x.Epoch)
		if e != nil {
			return e
		}
		if r.Backend != nil && r.MayHaveSent {
			if r.ReceiptAttempts >= 6 || n.wall > r.BackendStartedAt+60000 {
				continue
			}
			r, e = w.s.reserveReceipt(r.InputID, n.wall)
			if e != nil {
				return e
			}
			w.next[r.InputID] = n.wall + 5000
			code, raw, e := w.h.call(ctx, "/receipt", normalMarshal(struct {
				ID         string `json:"id"`
				Credential string `json:"credential"`
			}{r.Backend.ID, r.Backend.Credential}), nil)
			if e != nil {
				return e
			}
			state, _, e := validateNormalReceipt(code, raw, *r.Backend)
			if e != nil {
				return e
			}
			if state == "stored" {
				_, e = w.s.confirm(r.InputID, code, raw, w.sample().wall)
				return e
			}
			// Unknown/unconfirmed/expired never trigger DATA, even explicit /recover.
			return nil
		}
		if w.s.isResumed(r.InputID) {
			left, ok := w.s.resumeBudget(r.InputID, n)
			if !ok {
				continue
			}
			bounded, cancel := context.WithTimeout(ctx, left)
			defer cancel()
			ctx = bounded
		}
		if r.Backend != nil && w.s.resumedLease(r.InputID) {
			return w.sendResumedFirst(ctx, r)
		}
		if _, ok := w.s.resumeBudget(r.InputID, n); !ok {
			continue
		}
		if r.Backend != nil || r.LeaseAttempts >= 2 || !w.s.canAllocate(r.InputID) || !n.trusted {
			continue
		}
		if _, e = w.s.reserveLease(r.InputID, n.wall); e != nil {
			return e
		}
		w.next[r.InputID] = n.wall + 5000
		code, raw, e := w.h.call(ctx, "/capabilities", nil, nil)
		if e != nil || validateNormalCapability(code, raw) != nil {
			return normalInvalid
		}
		start := w.sample()
		if _, ok := w.s.resumeBudget(r.InputID, start); !ok || ctx.Err() != nil {
			return normalInvalid
		}
		if !normalElapsed(n, start, 29*time.Second) || !w.s.canAllocate(r.InputID) {
			return normalInvalid
		}
		code, raw, e = w.h.call(ctx, "/lease", normalMarshal(struct {
			SHA      string `json:"sha"`
			Bytes    int64  `json:"bytes"`
			Contract string `json:"contract"`
		}{r.SHA, r.Bytes, r.Contract}), nil)
		end := w.sample()
		if !normalElapsed(start, end, 29*time.Second) {
			w.s.distrust()
			return normalInvalid
		}
		if e != nil {
			return e
		}
		lease, e := validateNormalLease(code, raw, r.SHA, r.Bytes, start.wall, end.wall)
		if e != nil {
			return e
		}
		if _, e = w.s.attachLease(r.InputID, lease, start.wall, end.wall); e != nil {
			return e
		}
		w.s.captureResumeLease(r.InputID, start)
		before := w.sample()
		if !normalElapsed(start, before, 29*time.Second) {
			w.s.distrust()
			return normalInvalid
		}
		if _, ok := w.s.resumeBudget(r.InputID, before); !ok {
			return normalInvalid
		}
		r, e = w.s.firstSend(r.InputID, before.wall)
		if e != nil {
			return e
		}
		after := w.sample()
		if ctx.Err() != nil || !normalElapsed(start, after, 29*time.Second) {
			w.s.distrust()
			return normalInvalid
		}
		// Deadline is additionally clipped to the original conservative runtime
		// admission window. The C server's own issuing-clock lock is final authority.
		left := 29*time.Second - (after.boot - start.boot)
		if budget, ok := w.s.resumeBudget(r.InputID, after); !ok {
			return normalInvalid
		} else if budget < left {
			left = budget
		}
		sendCtx, cancel := context.WithTimeout(ctx, left)
		code, raw, e = w.h.call(sendCtx, "/metrics", r.Body, r.Backend)
		cancel()
		if e != nil {
			return e
		}
		_, e = w.s.confirm(r.InputID, code, raw, w.sample().wall)
		return e
	}
	return nil
}

// Explicit lifecycle method only. No goroutine is spawned. Cancellation reaches
// the in-flight HTTP context, timer stops, and no new work starts after return.
// Caller's future integration owns join-before-store-close. Failed operations
// remain pending with durable attempts visible in status, not falsely stored.
// There is no error callback or raw error/body/key logging.
func (w *normalWorker) run(ctx context.Context) {
	timer := time.NewTicker(time.Second)
	defer timer.Stop()
	for {
		if ctx.Err() != nil {
			return
		}
		_ = w.step(ctx)
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}
	}
}

// First DATA of an ORIGINAL attached-but-never-sent lease only. Durable attempt
// transition still precedes transport. Reopen never restarts the29s clock.
func (w *normalWorker) sendResumedFirst(ctx context.Context, r normalCustodyRecord) error {
	before := w.sample()
	if _, ok := w.s.resumeBudget(r.InputID, before); !ok || ctx.Err() != nil {
		return normalInvalid
	}
	r, e := w.s.firstSend(r.InputID, before.wall)
	if e != nil {
		return e
	}
	after := w.sample()
	left, ok := w.s.resumeBudget(r.InputID, after)
	if !ok || ctx.Err() != nil || !normalElapsed(before, after, 29*time.Second) {
		w.s.distrust()
		return normalInvalid
	}
	sendCtx, cancel := context.WithTimeout(ctx, left)
	defer cancel()
	code, raw, e := w.h.call(sendCtx, "/metrics", r.Body, r.Backend)
	if e != nil {
		return e
	}
	_, e = w.s.confirm(r.InputID, code, raw, w.sample().wall)
	return e
}
