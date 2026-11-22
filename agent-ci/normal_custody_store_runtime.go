package main

// Narrow synchronous snapshots for the source-only handler/worker. Never expose
// these private records (credentials/body/population) through an HTTP response.
import bolt "go.etcd.io/bbolt"

func (s *normalStore) lookup(id, epoch string) (normalCustodyRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.db == nil || s.poisoned {
		return normalCustodyRecord{}, normalStoreFailure
	}
	var r normalCustodyRecord
	e := s.db.View(func(tx *bolt.Tx) error {
		if _, e := s.audit(tx); e != nil {
			return e
		}
		var e error
		r, e = normalLoad(tx, id)
		if e != nil || r.Epoch != epoch {
			return normalStoreFailure
		}
		return nil
	})
	if e != nil {
		return normalCustodyRecord{}, normalStoreFailure
	}
	return cloneNormalRecord(r), nil
}
func (s *normalStore) epoch() (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.db == nil || s.poisoned {
		return "", normalStoreFailure
	}
	var epoch string
	e := s.db.View(func(tx *bolt.Tx) error { m, e := s.audit(tx); epoch = m.Epoch; return e })
	return epoch, e
}
func (s *normalStore) canAllocate(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.db != nil && !s.poisoned && s.current[id]
}

// A detected runtime timing discontinuity permanently invalidates this session's
// outstanding DATA permission; later catch-up never revives it.
func (s *normalStore) distrust() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.current = map[string]bool{}
	s.fresh = map[string]bool{}
}
