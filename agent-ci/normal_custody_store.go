package main

// Synchronous persistence. No listener, CLI or build wiring.
import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	bolt "go.etcd.io/bbolt"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"time"
)

var normalMetaBucket = []byte("normal-meta-v1")
var normalEntriesBucket = []byte("normal-entries-v1")
var normalMetaKey = []byte("record")
var normalStoreFailure = errors.New("normal custody persistence unavailable")
var normalCapacity = errors.New("normal custody capacity unavailable")

type normalStore struct {
	mu                sync.Mutex
	db                *bolt.DB
	binding           string
	resumed           map[string]normalResumeEligibility
	resumeReport      map[string]string
	resumeState       string
	resumeCaptureBoot string
	resumeIssues      map[string]normalResumeAnchor
	resumeLeases      map[string]normalResumeAnchor
	// In-memory trust only, never reconstructed from persisted wall timestamps.
	// Reopen normally invalidates DATA. Optional consumed clean same-boot checkpoint
	// can restore only proven never-sent original windows; attempted DATA stays receipt-only.
	current        map[string]bool
	fresh          map[string]bool
	poisoned       bool
	ingressClaimed bool
	workerClaimed  bool // process-local single worker ownership, never restored from disk
	// Deterministic local transaction-boundary simulation, never network/user callback.
	// nil in normal use, private to same-package tests.
	testFault func(string) error
}

func normalRandom() (string, error) {
	b := make([]byte, 16)
	if _, e := rand.Read(b); e != nil {
		return "", normalStoreFailure
	}
	return hex.EncodeToString(b), nil
}
func normalDiskEncode(v any) ([]byte, error) {
	b, e := json.Marshal(v)
	if e != nil {
		return nil, normalStoreFailure
	}
	return b, nil
}
func normalDiskDecode(b []byte, v any) error {
	if len(b) == 0 || len(b) > 1500000 {
		return normalStoreFailure
	}
	d := json.NewDecoder(bytes.NewReader(b))
	d.DisallowUnknownFields()
	if d.Decode(v) != nil {
		return normalStoreFailure
	}
	// Exact canonical encoding rejects duplicates, missing fields, trailing data and
	// coercion. Store writes this same encoding, never accepts external JSON here.
	out, e := normalDiskEncode(v)
	if e != nil || !bytes.Equal(b, out) {
		return normalStoreFailure
	}
	return nil
}
func normalSyncDirs(dir string) error {
	for d := dir; ; d = filepath.Dir(d) {
		f, e := os.Open(d)
		if e != nil {
			return normalStoreFailure
		}
		e = f.Sync()
		ce := f.Close()
		if e != nil || ce != nil {
			return normalStoreFailure
		}
		if filepath.Dir(d) == d {
			return nil
		}
	}
}
func openNormalStore(stateDir, origin, key string) (*normalStore, error) {
	binding, e := normalBinding(origin, key)
	if e != nil || !filepath.IsAbs(stateDir) {
		return nil, normalStoreFailure
	}
	// Do not follow symlinked ancestry or operate an old journal namespace.
	for d := filepath.Clean(stateDir); ; d = filepath.Dir(d) {
		if f, e := os.Lstat(d); e == nil && (!f.IsDir() || f.Mode()&os.ModeSymlink != 0) {
			return nil, normalStoreFailure
		} else if e != nil && !os.IsNotExist(e) {
			return nil, normalStoreFailure
		}
		if filepath.Dir(d) == d {
			break
		}
	}
	dir := filepath.Join(stateDir, normalJournalNamespace)
	if e = os.MkdirAll(dir, 0700); e != nil {
		return nil, normalStoreFailure
	}
	if f, e := os.Lstat(dir); e != nil || !f.IsDir() || f.Mode()&os.ModeSymlink != 0 {
		return nil, normalStoreFailure
	}
	if f, e := os.Stat(dir); e != nil || f.Mode().Perm() != 0700 {
		return nil, normalStoreFailure
	}
	path := filepath.Join(dir, "journal.db")
	existed := false
	if f, e := os.Lstat(path); e == nil {
		if !f.Mode().IsRegular() || f.Mode()&os.ModeSymlink != 0 || f.Size() == 0 || f.Size() > normalFileLimit || f.Mode().Perm() != 0600 {
			return nil, normalStoreFailure
		}
		existed = true
	} else if !os.IsNotExist(e) {
		return nil, normalStoreFailure
	}
	if !existed {
		f, e := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if e != nil {
			return nil, normalStoreFailure
		}
		if e = f.Close(); e != nil {
			return nil, normalStoreFailure
		}
	}
	db, e := bolt.Open(path, 0600, &bolt.Options{Timeout: time.Second, MaxSize: normalFileLimit})
	if e != nil {
		return nil, normalStoreFailure
	}
	s := &normalStore{db: db, binding: binding, fresh: map[string]bool{}, current: map[string]bool{}}
	fail := func() (*normalStore, error) { db.Close(); return nil, normalStoreFailure }
	if db.NoSync || db.NoGrowSync || db.MaxSize != normalFileLimit {
		return fail()
	}
	if e = db.Update(func(tx *bolt.Tx) error {
		if !existed {
			n := 0
			tx.ForEach(func([]byte, *bolt.Bucket) error { n++; return nil })
			if n != 0 {
				return normalStoreFailure
			}
			m, e := tx.CreateBucket(normalMetaBucket)
			if e != nil {
				return e
			}
			if _, e = tx.CreateBucket(normalEntriesBucket); e != nil {
				return e
			}
			epoch, e := normalRandom()
			if e != nil {
				return e
			}
			b, e := normalDiskEncode(normalJournalMeta{Version: 1, Protocol: normalCustodyProtocol, Contract: normalContract, Epoch: epoch, Binding: binding})
			if e != nil {
				return e
			}
			return m.Put(normalMetaKey, b)
		}
		_, e := s.audit(tx)
		return e
	}); e != nil {
		return fail()
	}
	if e = normalSyncDirs(dir); e != nil {
		return fail()
	}
	return s, nil
}
func (s *normalStore) audit(tx *bolt.Tx) (normalJournalMeta, error) {
	var m normalJournalMeta
	mb, eb := tx.Bucket(normalMetaBucket), tx.Bucket(normalEntriesBucket)
	if mb == nil || eb == nil {
		return m, normalStoreFailure
	}
	count := 0
	tx.ForEach(func([]byte, *bolt.Bucket) error { count++; return nil })
	if count != 2 {
		return m, normalStoreFailure
	}
	n := 0
	mb.ForEach(func(k, v []byte) error { n++; return nil })
	if (n != 1 && n != 2) || normalDiskDecode(mb.Get(normalMetaKey), &m) != nil || !m.valid(s.binding) {
		return m, normalStoreFailure
	}
	if n == 2 {
		var c normalResumeCheckpoint
		if normalDiskDecode(mb.Get(normalResumeKey), &c) != nil || (!c.valid(s.binding) || c.Epoch != m.Epoch) {
			return m, normalStoreFailure
		}
	}
	total := int64(0)
	count = 0
	e := eb.ForEach(func(k, v []byte) error {
		var r normalCustodyRecord
		if v == nil || normalDiskDecode(v, &r) != nil || !r.valid() || string(k) != r.InputID || r.Epoch != m.Epoch || r.IssuedAt > m.ClockFloor || r.AcceptedAt > m.ClockFloor || r.BackendStartedAt > m.ClockFloor {
			return normalStoreFailure
		}
		count++
		total += int64(len(r.Body))
		if count > normalEntryLimit || total > normalPayloadLimit {
			return normalStoreFailure
		}
		return nil
	})
	if e != nil || total != m.PayloadBytes {
		return m, normalStoreFailure
	}
	return m, nil
}
func (s *normalStore) close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.db == nil {
		return nil
	}
	e := s.db.Close()
	s.db = nil
	return e
}
func (s *normalStore) fault(stage string) error {
	if s.testFault != nil {
		return s.testFault(stage)
	}
	return nil
}

// No caller-controlled transaction closure is exported. Transitions are prepared
// on copies, then entry/meta/counters/floor change in one synchronous bbolt commit.
func (s *normalStore) update(now int64, fn func(*bolt.Tx, *normalJournalMeta) error) error {
	if s.db == nil || s.poisoned {
		return normalStoreFailure
	}
	prepared := false
	e := s.db.Update(func(tx *bolt.Tx) error {
		m, e := s.audit(tx)
		if e != nil {
			return e
		}
		if now < m.ClockFloor || now <= 0 || now > normalMaxInteger {
			s.fresh = map[string]bool{}
			s.current = map[string]bool{}
			return normalStoreFailure
		}
		m.ClockFloor = now
		if e = fn(tx, &m); e != nil {
			return e
		}
		if !m.valid(s.binding) {
			return normalStoreFailure
		}
		b, e := normalDiskEncode(m)
		if e != nil {
			return e
		}
		if e = tx.Bucket(normalMetaBucket).Put(normalMetaKey, b); e != nil {
			return e
		}
		if _, e = s.audit(tx); e != nil {
			return e
		}
		if e = s.fault("before-commit"); e != nil {
			return e
		}
		prepared = true
		return nil
	})
	if e != nil {
		if !prepared && errors.Is(e, normalCapacity) {
			return normalCapacity
		}
		if prepared {
			s.poisoned = true
		}
		return normalStoreFailure
	}
	// Simulated lost commit result: never return ACK, poison until reopen. This is
	// intentionally different from rollback-before-commit. Not a physical IO fault.
	if s.fault("after-commit") != nil {
		s.poisoned = true
		return normalStoreFailure
	}
	return nil
}
func normalLoad(tx *bolt.Tx, id string) (normalCustodyRecord, error) {
	var r normalCustodyRecord
	if !normalID.MatchString(id) || normalDiskDecode(tx.Bucket(normalEntriesBucket).Get([]byte(id)), &r) != nil {
		return r, normalStoreFailure
	}
	return r, nil
}
func normalPut(tx *bolt.Tx, m *normalJournalMeta, old *normalCustodyRecord, r normalCustodyRecord) error {
	if !r.valid() || r.Epoch != m.Epoch {
		return normalStoreFailure
	}
	oldBytes := 0
	if old != nil {
		oldBytes = len(old.Body)
	}
	m.PayloadBytes += int64(len(r.Body) - oldBytes)
	if m.PayloadBytes < 0 || m.PayloadBytes > normalPayloadLimit {
		return normalCapacity
	}
	b, e := normalDiskEncode(r)
	if e != nil {
		return e
	}
	return tx.Bucket(normalEntriesBucket).Put([]byte(r.InputID), b)
}
func (s *normalStore) issue(sha string, size int64, p normalPopulation, now int64) (normalCustodyRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out normalCustodyRecord
	e := s.update(now, func(tx *bolt.Tx, m *normalJournalMeta) error {
		if tx.Bucket(normalEntriesBucket).Stats().KeyN >= normalEntryLimit {
			return normalCapacity
		}
		id, e := normalRandom()
		if e != nil {
			return e
		}
		if tx.Bucket(normalEntriesBucket).Get([]byte(id)) != nil {
			return normalStoreFailure
		}
		out = normalCustodyRecord{Version: 1, InputID: id, Epoch: m.Epoch, SHA: sha, Bytes: size, Contract: normalContract, Population: p, IssuedAt: now, InputUntil: now + 30000, RetainUntil: now + 330000, State: "issued"}
		return normalPut(tx, m, nil, out)
	})
	if e != nil {
		return normalCustodyRecord{}, e
	}
	s.current[out.InputID] = true
	return out, nil
}
func (s *normalStore) transition(id string, now int64, fn func(normalCustodyRecord) (normalCustodyRecord, error)) (normalCustodyRecord, error) {
	var out normalCustodyRecord
	e := s.update(now, func(tx *bolt.Tx, m *normalJournalMeta) error {
		old, e := normalLoad(tx, id)
		if e != nil || now > old.RetainUntil {
			return normalStoreFailure
		}
		out, e = fn(old)
		if e != nil {
			return e
		}
		return normalPut(tx, m, &old, out)
	})
	if e != nil {
		return normalCustodyRecord{}, e
	}
	return cloneNormalRecord(out), nil
}
func (s *normalStore) admit(id string, body []byte, now int64) (normalCustodyRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.transition(id, now, func(r normalCustodyRecord) (normalCustodyRecord, error) { return admitNormalInput(r, body, now) })
}
func (s *normalStore) reserveLease(id string, now int64) (normalCustodyRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.current[id] {
		return normalCustodyRecord{}, normalStoreFailure
	}
	return s.transition(id, now, prepareNormalLeaseAttempt)
}
func (s *normalStore) attachLease(id string, l normalLease, start, now int64) (normalCustodyRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.current[id] || now < start || now-start >= 29000 {
		return normalCustodyRecord{}, normalStoreFailure
	}
	r, e := s.transition(id, now, func(r normalCustodyRecord) (normalCustodyRecord, error) { return attachNormalLease(r, l, start) })
	if e == nil {
		s.fresh[id] = true
	}
	return r, e
}
func (s *normalStore) firstSend(id string, now int64) (normalCustodyRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.fresh[id] {
		return normalCustodyRecord{}, normalStoreFailure
	}
	return s.transition(id, now, func(r normalCustodyRecord) (normalCustodyRecord, error) {
		if now < r.BackendStartedAt || now-r.BackendStartedAt >= 29000 {
			return normalCustodyRecord{}, normalStoreFailure
		}
		return prepareNormalFirstSend(r)
	})
}
func (s *normalStore) confirm(id string, status int, body []byte, now int64) (normalCustodyRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.transition(id, now, func(r normalCustodyRecord) (normalCustodyRecord, error) {
		return confirmNormalStored(r, status, body, now)
	})
}
func (s *normalStore) reserveReceipt(id string, now int64) (normalCustodyRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.transition(id, now, func(r normalCustodyRecord) (normalCustodyRecord, error) {
		if r.Backend == nil || !r.MayHaveSent || r.State == "stored" || r.ReceiptAttempts >= 6 || now > r.BackendStartedAt+60000 {
			return normalCustodyRecord{}, normalStoreFailure
		}
		r = cloneNormalRecord(r)
		r.ReceiptAttempts++
		return r, nil
	})
}

// Local retention reclaim and terminal counters/ranges are one transaction.
func (s *normalStore) sweep(now int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	var removed []string
	e := s.update(now, func(tx *bolt.Tx, m *normalJournalMeta) error {
		eb := tx.Bucket(normalEntriesBucket)
		var records []normalCustodyRecord
		if e := eb.ForEach(func(k, v []byte) error {
			var r normalCustodyRecord
			if normalDiskDecode(v, &r) != nil {
				return normalStoreFailure
			}
			records = append(records, r)
			return nil
		}); e != nil {
			return e
		}
		for _, old := range records {
			r, reclaim, e := expireNormalRecord(old, now)
			if e != nil {
				return e
			}
			if !reclaim {
				if !reflect.DeepEqual(r, old) {
					if e = normalPut(tx, m, &old, r); e != nil {
						return e
					}
				}
				continue
			}
			switch r.State {
			case "stored":
				m.Stored++
			case "issued":
				m.Refused++
			default:
				m.Unconfirmed++
			}
			if m.FirstUntil == 0 || r.InputUntil < m.FirstUntil {
				m.FirstUntil = r.InputUntil
			}
			if r.InputUntil > m.LastUntil {
				m.LastUntil = r.InputUntil
			}
			removed = append(removed, r.InputID)
			m.PayloadBytes -= int64(len(old.Body))
			if e = eb.Delete([]byte(r.InputID)); e != nil {
				return e
			}
		}
		return nil
	})
	if e == nil {
		for _, id := range removed {
			delete(s.current, id)
			delete(s.fresh, id)
			delete(s.resumeIssues, id)
			delete(s.resumeLeases, id)
			delete(s.resumed, id)
			delete(s.resumeReport, id)
		}
	}
	return e
}

// Safe projection is separate from disk types. Never credential/body/hash/origin/key.
type normalSafeRecord struct {
	ID                  string            `json:"id"`
	Epoch               string            `json:"epoch"`
	State               string            `json:"state"`
	Custody             bool              `json:"custody"`
	BackendStored       bool              `json:"backendStored"`
	ReceiptOnly         bool              `json:"receiptOnly"`
	InputUntil          int64             `json:"inputUntil"`
	RetainUntil         int64             `json:"retainUntil"`
	RetainedBytes       int               `json:"retainedBytes"`
	BackendID           string            `json:"backendId"`
	BackendUntil        int64             `json:"backendUntil"`
	BackendReceiptUntil int64             `json:"backendReceiptUntil"`
	DataAttempts        int               `json:"dataAttempts"`
	ReceiptAttempts     int               `json:"receiptAttempts"`
	LeaseAttempts       int               `json:"leaseAttempts"`
	Accounting          *normalAccounting `json:"accounting"`
}
type normalSafeStatus struct {
	Entries      []normalSafeRecord `json:"entries"`
	Stored       int64              `json:"stored"`
	Refused      int64              `json:"refused"`
	Unconfirmed  int64              `json:"unconfirmed"`
	FirstUntil   int64              `json:"firstUntil"`
	LastUntil    int64              `json:"lastUntil"`
	PayloadBytes int64              `json:"payloadBytes"`
	JournalBytes int64              `json:"journalBytes"`
}

func (s *normalStore) status() (normalSafeStatus, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out normalSafeStatus
	if s.db == nil || s.poisoned {
		return out, normalStoreFailure
	}
	e := s.db.View(func(tx *bolt.Tx) error {
		m, e := s.audit(tx)
		if e != nil {
			return e
		}
		out = normalSafeStatus{Entries: []normalSafeRecord{}, Stored: m.Stored, Refused: m.Refused, Unconfirmed: m.Unconfirmed, FirstUntil: m.FirstUntil, LastUntil: m.LastUntil, PayloadBytes: m.PayloadBytes}
		return tx.Bucket(normalEntriesBucket).ForEach(func(k, v []byte) error {
			var r normalCustodyRecord
			if normalDiskDecode(v, &r) != nil {
				return normalStoreFailure
			}
			x := normalSafeRecord{ID: r.InputID, Epoch: r.Epoch, State: r.State, Custody: len(r.Body) > 0, BackendStored: r.State == "stored", ReceiptOnly: !s.fresh[r.InputID] || r.MayHaveSent, InputUntil: r.InputUntil, RetainUntil: r.RetainUntil, RetainedBytes: len(r.Body), DataAttempts: r.DataAttempts, ReceiptAttempts: r.ReceiptAttempts, LeaseAttempts: r.LeaseAttempts}
			if r.Backend != nil {
				x.BackendID = r.Backend.ID
				x.BackendUntil = r.Backend.Until
				x.BackendReceiptUntil = r.Backend.ReceiptUntil
			}
			if r.Stored != nil {
				a := r.Stored.Accounting
				x.Accounting = &a
			}
			out.Entries = append(out.Entries, x)
			return nil
		})
	})
	if e != nil {
		return normalSafeStatus{}, normalStoreFailure
	}
	f, e := os.Stat(s.db.Path())
	if e != nil {
		return normalSafeStatus{}, normalStoreFailure
	}
	out.JournalBytes = f.Size()
	return out, nil
}
