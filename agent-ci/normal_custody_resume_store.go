package main

import (
	"sort"
	"time"

	bolt "go.etcd.io/bbolt"
)

// Called only AFTER accepted owner worker+handler join on explicit clean stop.
// Ordinary close/crash/failure never creates a checkpoint. Runtime eligibility
// of recovered rows is deliberately not handed off a second time.
func (s *normalStore) checkpointGraceful(start, end normalResumeAnchor) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.db == nil || s.poisoned {
		return normalStoreFailure
	}
	c := normalResumeCheckpoint{Version: 1, Binding: s.binding, Start: start, End: end, Entries: []normalResumeEntry{}}
	if !normalResumeDelta(start, end, 24*time.Hour) {
		return normalInvalid
	}
	return s.update(end.Wall, func(tx *bolt.Tx, m *normalJournalMeta) error {
		c.Epoch = m.Epoch
		if tx.Bucket(normalMetaBucket).Get(normalResumeKey) != nil {
			return normalStoreFailure
		}
		e := tx.Bucket(normalEntriesBucket).ForEach(func(_, raw []byte) error {
			var r normalCustodyRecord
			if normalDiskDecode(raw, &r) != nil {
				return normalStoreFailure
			}
			if s.current[r.InputID] && normalResumeNeverSent(r) {
				if _, recovered := s.resumed[r.InputID]; !recovered {
					issue, ok := s.resumeIssues[r.InputID]
					if !ok {
						return nil
					}
					entry := normalResumeEntry{ID: r.InputID, Epoch: r.Epoch, Digest: normalResumeDigest(r), Issue: issue}
					if r.Backend != nil {
						lease, ok := s.resumeLeases[r.InputID]
						if !ok {
							return nil
						}
						entry.Lease = &lease
					}
					c.Entries = append(c.Entries, entry)
				}
			}
			return nil
		})
		if e != nil {
			return e
		}
		raw, e := normalDiskEncode(c)
		if e != nil {
			return e
		}
		return tx.Bucket(normalMetaBucket).Put(normalResumeKey, raw)
	})
}

// Consume is a synchronous single transaction, even when no row is eligible.
// Any ambiguous/error result poisons and restores NOTHING. A prior checkpoint
// is never re-used after process death following its consumption.
func (s *normalStore) consumeGraceful(now normalResumeAnchor) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	var plan []normalResumeEligibility
	state := "no-clean-checkpoint"
	e := s.update(now.Wall, func(tx *bolt.Tx, _ *normalJournalMeta) error {
		raw := tx.Bucket(normalMetaBucket).Get(normalResumeKey)
		if raw == nil {
			return nil
		}
		var c normalResumeCheckpoint
		if normalDiskDecode(raw, &c) != nil || !c.valid(s.binding) {
			return normalStoreFailure
		}
		rows := map[string]normalCustodyRecord{}
		for _, x := range c.Entries {
			r, e := normalLoad(tx, x.ID)
			if e == nil {
				rows[x.ID] = r
			}
		}
		plan = normalPlanResume(c, now, rows)
		state = "checkpoint-consumed"
		return tx.Bucket(normalMetaBucket).Delete(normalResumeKey)
	})
	return s.finishResumeConsumption(plan, state, e)
}

// Called under store lock after durable transaction result, never before.
func (s *normalStore) finishResumeConsumption(plan []normalResumeEligibility, state string, e error) error {
	if e != nil {
		s.poisoned = true
		s.current = map[string]bool{}
		s.fresh = map[string]bool{}
		s.resumed = map[string]normalResumeEligibility{}
		s.resumeState = "persistence-uncertain-no-permission"
		return normalStoreFailure
	}
	s.publishResumePlan(plan)
	s.resumeState = state
	return nil
}

// Commit-success publication is isolated for pure inert tests. Not a grant to
// call without consumeGraceful's proven transaction success.
func (s *normalStore) publishResumePlan(plan []normalResumeEligibility) {
	s.resumed = map[string]normalResumeEligibility{}
	s.resumeReport = map[string]string{}
	for _, e := range plan {
		s.resumeReport[e.ID] = e.Outcome
		if e.Allocation || e.FirstDATA {
			s.resumed[e.ID] = e
			s.current[e.ID] = true
			if e.FirstDATA {
				s.fresh[e.ID] = true
			}
		}
	}
}
func (s *normalStore) resumeBudget(id string, n normalStamp) (time.Duration, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.db == nil || s.poisoned {
		return 0, false
	}
	e, ok := s.resumed[id]
	if !ok {
		return 29 * time.Second, true
	}
	return normalResumeRemaining(e, n, s.current[id])
}
func normalResumeRemaining(e normalResumeEligibility, n normalStamp, current bool) (time.Duration, bool) {
	if !n.trusted || n.wall >= e.DeadlineWall || n.boot >= e.DeadlineBoot || !current {
		return 0, false
	}
	b := e.DeadlineBoot - n.boot
	w := time.Duration(e.DeadlineWall-n.wall) * time.Millisecond
	if w < b {
		b = w
	}
	if b <= 0 {
		return 0, false
	}
	return b, true
}

func (s *normalStore) resumedLease(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.resumed[id]
	return ok && e.FirstDATA && s.fresh[id]
}

func (s *normalStore) isResumed(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.resumed[id]
	return ok
}

// Explicit safe operator projection, NOT a DATA permission/status-live grant.
type normalResumeOperatorRow struct {
	ID      string `json:"id"`
	Outcome string `json:"outcome"`
}
type normalResumeOperatorStatus struct {
	Protocol                  string                    `json:"protocol"`
	Mode                      string                    `json:"mode"`
	SnapshotNotLivePermission bool                      `json:"snapshotNotLivePermission"`
	State                     string                    `json:"state"`
	Rows                      []normalResumeOperatorRow `json:"rows"`
}

func (s *normalStore) resumeStatus() normalResumeOperatorStatus {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := normalResumeOperatorStatus{Protocol: normalCustodyProtocol, Mode: normalResumeMode, SnapshotNotLivePermission: true, State: s.resumeState, Rows: []normalResumeOperatorRow{}}
	if out.State == "" {
		out.State = "not-enabled-or-no-handoff"
	}
	ids := []string{}
	for id := range s.resumeReport {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		why := s.resumeReport[id]
		if _, restored := s.resumed[id]; restored && !s.current[id] {
			why = "runtime-permission-revoked"
		}
		out.Rows = append(out.Rows, normalResumeOperatorRow{id, why})
	}
	if s.poisoned {
		out.State = "persistence-uncertain-no-permission"
	}
	return out
}

// Exact per-row samples, not reconstruction from session wall timestamps. A
// transient clock step at issue/lease is checked against close/reopen anchors.
func (s *normalStore) captureResumeIssue(id string, n normalStamp) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.resumeCaptureBoot == "" {
		return
	}
	if s.resumeIssues == nil {
		s.resumeIssues = map[string]normalResumeAnchor{}
	}
	s.resumeIssues[id] = normalResumeAnchorFor(s.resumeCaptureBoot, n)
}
func (s *normalStore) captureResumeLease(id string, n normalStamp) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.resumeCaptureBoot == "" {
		return
	}
	if s.resumeLeases == nil {
		s.resumeLeases = map[string]normalResumeAnchor{}
	}
	s.resumeLeases[id] = normalResumeAnchorFor(s.resumeCaptureBoot, n)
}
