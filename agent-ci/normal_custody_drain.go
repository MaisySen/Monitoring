package main

// Prospective SAME-SESSION barrier only, not wired to SDK wire/Collector stop.
// Never calls worker.step, allocates leases, renews deadlines or replays DATA.
import (
	"context"
	"errors"
	"time"
)

const normalDrainMax = 25 * time.Second

var normalDrainIncomplete = errors.New("normal custody shutdown incomplete; journal retained")

type normalDrainIdentity struct {
	ID, Epoch  string
	Population normalPopulation
}
type normalDrainOutcome struct {
	ID, Epoch, State              string
	Stored                        bool
	DataAttempts, ReceiptAttempts int
	Accounting                    *normalAccounting
}
type normalDrainResult struct {
	Complete        bool
	Joined          bool
	JournalRetained bool
	Reason          string
	Outcomes        []normalDrainOutcome
}
type normalDrainDeps struct {
	freeze func(context.Context) error
	read   func(string, string) (normalCustodyRecord, error)
	stop   func(context.Context) error
	wait   func(context.Context) error
}

// Bounded test seam only; production chooses a fixed250ms LOCAL observation
// interval, no extra network calls. Existing worker alone owns transport/caps.
func normalDrainAndStop(ctx context.Context, ids []normalDrainIdentity, d normalDrainDeps) (out normalDrainResult, err error) {
	out.JournalRetained = true
	out.Reason = "incomplete"
	out.Outcomes = []normalDrainOutcome{}
	deadline, ok := ctx.Deadline()
	if !ok || time.Until(deadline) > normalDrainMax || len(ids) == 0 || len(ids) > normalEntryLimit {
		return out, normalInvalid
	}
	ids = append([]normalDrainIdentity(nil), ids...) // snapshot caller set before async observations
	seen := map[string]bool{}
	for _, id := range ids {
		if !normalID.MatchString(id.ID) || !normalID.MatchString(id.Epoch) || !id.Population.valid() || seen[id.ID] {
			return out, normalInvalid
		}
		seen[id.ID] = true
	}
	for _, id := range ids {
		out.Outcomes = append(out.Outcomes, normalDrainOutcome{ID: id.ID, Epoch: id.Epoch, State: "unconfirmed"})
	}
	var observation <-chan struct{}
	// Once a valid shutdown request starts, ALWAYS stop/join even if freeze,
	// observation, timeout or cancellation fails. Preserve journal on every path.
	defer func() {
		stopCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if e := d.stop(stopCtx); e != nil {
			out.Joined = false
			out.Complete = false
			out.Reason = "stop-not-joined"
			err = normalDrainIncomplete
			return
		}
		if observation != nil {
			select {
			case <-observation:
			case <-stopCtx.Done():
				out.Joined = false
				out.Complete = false
				out.Reason = "observation-not-joined"
				err = normalDrainIncomplete
				return
			}
		}
		out.Joined = true
	}()
	if e := d.freeze(ctx); e != nil {
		out.Reason = "freeze-incomplete"
		return out, normalDrainIncomplete
	}
	for {
		if ctx.Err() != nil {
			out.Reason = "deadline-or-canceled"
			return out, normalDrainIncomplete
		}
		ch := make(chan struct{})
		observation = ch
		// At most ONE local observer exists, never a new one before join. A closed
		// done channel cannot block a late completion. Store's own mutex prevents close
		// underneath this reader. Timeout explicitly preserves unjoined ownership.
		var batch normalDrainObservation
		go func() { defer close(ch); batch = normalObserveDrain(ids, d.read) }()
		select {
		case <-ch:
			observation = nil
		case <-ctx.Done():
			out.Reason = "deadline-or-canceled"
			return out, normalDrainIncomplete
		}
		all := batch.all
		out.Outcomes = batch.outcomes

		if ctx.Err() != nil {
			out.Reason = "deadline-or-canceled"
			return out, normalDrainIncomplete
		}
		if all {
			out.Complete = true
			out.Reason = "stored-exact-accounting"
			return out, nil
		}
		if e := d.wait(ctx); e != nil {
			out.Reason = "deadline-or-canceled"
			return out, normalDrainIncomplete
		}
	}
}

type normalDrainObservation struct {
	all      bool
	outcomes []normalDrainOutcome
}

func normalObserveDrain(ids []normalDrainIdentity, read func(string, string) (normalCustodyRecord, error)) normalDrainObservation {
	out := normalDrainObservation{all: true, outcomes: []normalDrainOutcome{}}
	for _, id := range ids {
		x := normalDrainOutcome{ID: id.ID, Epoch: id.Epoch, State: "unconfirmed"}
		r, e := read(id.ID, id.Epoch)
		if e == nil && r.InputID == id.ID && r.Epoch == id.Epoch && r.valid() && r.Population == id.Population {
			x.State = r.State
			x.DataAttempts = r.DataAttempts
			x.ReceiptAttempts = r.ReceiptAttempts
			x.Stored = r.State == "stored" && r.Stored != nil && r.Stored.Accounting.valid() && r.Stored.Accounting.population() == id.Population
			if x.Stored {
				a := r.Stored.Accounting
				x.Accounting = &a
			}
		}
		out.all = out.all && x.Stored
		out.outcomes = append(out.outcomes, x)
	}
	return out
}

// Explicit private owner operation for a FUTURE coordinated caller. Caller must
// finish SDK final collection first and supply original identity/population set.
// Success covers ONLY that set, not other rows/producers or a whole service.
func (a *normalListenerOwner) drainAndStop(ctx context.Context, ids []normalDrainIdentity) (normalDrainResult, error) {
	if !a.drainMu.TryLock() {
		return normalDrainResult{JournalRetained: true, Reason: "drain-already-owned"}, normalLifecycleFailure
	}
	defer a.drainMu.Unlock()
	a.mu.Lock()
	ingress, store := a.ingress, a.store
	ready := a.started && !a.stopping && ingress != nil && store != nil
	a.mu.Unlock()
	if !ready {
		return normalDrainResult{JournalRetained: true, Reason: "owner-unavailable"}, normalLifecycleFailure
	}
	return normalDrainAndStop(ctx, ids, normalDrainDeps{freeze: ingress.freeze, read: store.lookup, stop: a.stop, wait: func(ctx context.Context) error {
		timer := time.NewTimer(250 * time.Millisecond)
		defer timer.Stop()
		select {
		case <-timer.C:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}})
}
