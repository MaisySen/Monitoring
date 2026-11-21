package main

// Disabled-by-default connected experiment. Journal transactions never perform
// network calls. Custody ACK is deliberately distinct from backend storage.
import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	bolt "go.etcd.io/bbolt"
	"go.opentelemetry.io/collector/component"
	"go.opentelemetry.io/collector/extension"
	"go.opentelemetry.io/collector/otelcol"
)

const custodyProtocol = "monitoring-agent-custody-test-v1"
const custodyInputMS int64 = 30000
const custodyKeepMS int64 = 300000
const custodyEntries = 128
const custodyBytes = 16 * 1024 * 1024
const custodyPhysicalBytes = 128 * 1024 * 1024

var custodyType = component.MustNewType("monitoring_custody_test")

type custodyConfig struct {
	Endpoint  string `mapstructure:"endpoint"`
	Directory string `mapstructure:"directory"`
	Backend   string `mapstructure:"backend"`
	APIKey    string `mapstructure:"api_key"`
}
type custodyEntry struct {
	ID           string `json:"id"`
	Epoch        string `json:"epoch"`
	SHA          string `json:"sha"`
	Until        int64  `json:"until"`
	RetainUntil  int64  `json:"retainUntil"`
	State        string `json:"state"`
	Reason       string `json:"reason"`
	Body         []byte `json:"body,omitempty"`
	Token        string `json:"token,omitempty"`
	BackendID    string `json:"backendId,omitempty"`
	BackendUntil int64  `json:"backendUntil,omitempty"`
	ReceiptUntil int64  `json:"receiptUntil,omitempty"`
	Attempts     int    `json:"attempts"`
	Sent         bool   `json:"sent"`
	Recover      bool   `json:"recover"`
	Accepted     int    `json:"accepted"`
}
type custodyCounts struct {
	Unconfirmed int   `json:"unconfirmed"`
	Refused     int   `json:"refused"`
	Stored      int   `json:"stored"`
	First       int64 `json:"first"`
	Last        int64 `json:"last"`
}
type custodyAgent struct {
	cfg        custodyConfig
	db         *bolt.DB
	srv        *http.Server
	client     *http.Client
	stop       chan struct{}
	done       chan struct{}
	mu         sync.Mutex
	epoch      string
	lastReport int64
}

func custodyComponents() (otelcol.Factories, error) {
	f, e := components()
	if e != nil {
		return f, e
	}
	x := extension.NewFactory(custodyType, func() component.Config { return &custodyConfig{} }, func(_ context.Context, _ extension.Settings, c component.Config) (extension.Extension, error) {
		return &custodyAgent{cfg: *c.(*custodyConfig)}, nil
	}, component.StabilityLevelDevelopment)
	f.Extensions[custodyType] = x
	return f, nil
}
func randomCustodyID() string {
	b := make([]byte, 16)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	return hex.EncodeToString(b)
}
func (a *custodyAgent) Start(_ context.Context, _ component.Host) error {
	host, _, e := net.SplitHostPort(a.cfg.Endpoint)
	if e != nil || net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback() {
		return errors.New("custody test endpoint must be explicit loopback IP:port")
	}
	u, urlErr := url.Parse(a.cfg.Backend)
	if a.cfg.Directory == "" || a.cfg.APIKey == "" || urlErr != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return errors.New("custody requires explicit directory/backend/key")
	}
	if e = os.MkdirAll(a.cfg.Directory, 0700); e != nil {
		return e
	}
	if e = os.Chmod(a.cfg.Directory, 0700); e != nil {
		return e
	}
	a.db, e = bolt.Open(filepath.Join(a.cfg.Directory, "custody-test.db"), 0600, &bolt.Options{Timeout: time.Second, MaxSize: custodyPhysicalBytes})
	if e != nil {
		return e
	}
	e = a.db.Update(func(tx *bolt.Tx) error {
		m, e := tx.CreateBucketIfNotExists([]byte("meta"))
		if e != nil {
			return e
		}
		if _, e = tx.CreateBucketIfNotExists([]byte("entries")); e != nil {
			return e
		}
		v := m.Get([]byte("epoch"))
		if v == nil {
			a.epoch = randomCustodyID()
			if e = m.Put([]byte("epoch"), []byte(a.epoch)); e != nil {
				return e
			}
		} else {
			a.epoch = string(v)
		}
		binding := sha256.Sum256([]byte(a.cfg.Backend + "\x00" + a.cfg.APIKey))
		old := m.Get([]byte("binding"))
		if old != nil && !bytes.Equal(old, binding[:]) {
			return errors.New("custody destination/key binding changed; journal recovery must preserve original destination")
		}
		return m.Put([]byte("binding"), binding[:])
	})
	if e != nil {
		a.db.Close()
		return e
	}
	// A first ACK must preserve newly-created directory entries as well as bbolt
	// file content. Flush ancestry, never ignore an unsupported directory sync.
	for d := filepath.Clean(a.cfg.Directory); ; d = filepath.Dir(d) {
		directory, dirErr := os.Open(d)
		if dirErr != nil {
			a.db.Close()
			return dirErr
		}
		dirErr = directory.Sync()
		directory.Close()
		if dirErr != nil {
			a.db.Close()
			return dirErr
		}
		if filepath.Dir(d) == d {
			break
		}
	}

	l, e := net.Listen("tcp", a.cfg.Endpoint)
	if e != nil {
		a.db.Close()
		return e
	}
	a.stop = make(chan struct{})
	a.done = make(chan struct{})
	a.client = &http.Client{Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("custody backend redirects refused") }}
	a.srv = &http.Server{Handler: http.HandlerFunc(a.serve), ReadHeaderTimeout: 2 * time.Second, ReadTimeout: 6 * time.Second, WriteTimeout: 8 * time.Second}
	go a.srv.Serve(l)
	go a.run()
	return nil
}
func (a *custodyAgent) Shutdown(ctx context.Context) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.db == nil {
		return nil
	}
	if a.stop != nil {
		close(a.stop)
		a.srv.Shutdown(ctx)
		<-a.done
	}
	e := a.db.Close()
	a.db = nil
	return e
}
func jsonCustody(w http.ResponseWriter, status int, v any) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}
func custodyNow(tx *bolt.Tx) (int64, error) {
	m := tx.Bucket([]byte("meta"))
	var floor int64
	json.Unmarshal(m.Get([]byte("floor")), &floor)
	now := time.Now().UnixMilli()
	if now < floor {
		return 0, errors.New("agent clock behind durable floor; wait, never reset")
	}
	v, _ := json.Marshal(now)
	return now, m.Put([]byte("floor"), v)
}
func putCustody(tx *bolt.Tx, x *custodyEntry) error {
	v, e := json.Marshal(x)
	if e != nil {
		return e
	}
	return tx.Bucket([]byte("entries")).Put([]byte(x.ID), v)
}
func loadCustody(tx *bolt.Tx, id string) (*custodyEntry, error) {
	v := tx.Bucket([]byte("entries")).Get([]byte(id))
	if v == nil {
		return nil, errors.New("unknown or expired identity; never recreate old deltas")
	}
	var x custodyEntry
	if e := json.Unmarshal(v, &x); e != nil {
		return nil, e
	}
	return &x, nil
}
func safeCustody(x *custodyEntry) map[string]any {
	return map[string]any{"id": x.ID, "epoch": x.Epoch, "state": x.State, "reason": x.Reason, "until": x.Until, "retainUntil": x.RetainUntil, "retainedBytes": len(x.Body), "backendId": x.BackendID, "backendUntil": x.BackendUntil, "receiptUntil": x.ReceiptUntil, "attempts": x.Attempts, "accepted": x.Accepted, "custody": x.State != "issued" && x.State != "expired-unconfirmed", "backendStored": x.State == "stored"}
}
func (a *custodyAgent) serve(w http.ResponseWriter, r *http.Request) {
	if subtle.ConstantTimeCompare([]byte(r.Header.Get("DC-API-KEY")), []byte(a.cfg.APIKey)) != 1 {
		jsonCustody(w, 403, map[string]any{"error": "Forbidden"})
		return
	}
	p := strings.TrimPrefix(r.URL.Path, "/monitoring/experimental/metric-custody/v1")
	if r.Method == "GET" && p == "/capabilities" {
		jsonCustody(w, 200, map[string]any{"protocol": custodyProtocol, "testOnly": true, "epoch": a.epoch, "inputMs": custodyInputMS, "custodyMs": custodyKeepMS, "maxEntries": custodyEntries, "maxPayloadBytes": custodyBytes, "maxJournalFileBytes": custodyPhysicalBytes, "custodyIsBackendStored": false})
		return
	}
	if r.Method == "GET" && p == "/status" {
		var rows []any
		var counts custodyCounts
		e := a.db.View(func(tx *bolt.Tx) error {
			json.Unmarshal(tx.Bucket([]byte("meta")).Get([]byte("counts")), &counts)
			return tx.Bucket([]byte("entries")).ForEach(func(_, v []byte) error {
				var x custodyEntry
				if e := json.Unmarshal(v, &x); e != nil {
					return e
				}
				rows = append(rows, safeCustody(&x))
				return nil
			})
		})
		if e != nil {
			jsonCustody(w, 503, map[string]any{"error": "status unavailable"})
			return
		}
		jsonCustody(w, 200, map[string]any{"protocol": custodyProtocol, "epoch": a.epoch, "entries": rows, "counts": counts, "maxJournalFileBytes": custodyPhysicalBytes, "journalFileBytes": a.fileSize(), "warning": "Local durable custody is not backend storage. Finite experiment; never renew ambiguous deltas."})
		return
	}
	if r.Method != "POST" {
		jsonCustody(w, 404, map[string]any{"error": "not found"})
		return
	}
	b, e := io.ReadAll(http.MaxBytesReader(w, r.Body, 1024*1024))
	if e != nil {
		jsonCustody(w, 413, map[string]any{"error": "body limit1MiB"})
		return
	}
	var request struct {
		SHA   string `json:"sha"`
		ID    string `json:"id"`
		Epoch string `json:"epoch"`
	}
	if p != "/metrics" {
		if json.Unmarshal(b, &request) != nil {
			jsonCustody(w, 400, map[string]any{"error": "invalid request"})
			return
		}
	} else {
		request.ID = r.Header.Get("X-Monitoring-Input-ID")
		request.Epoch = r.Header.Get("X-Monitoring-Agent-Epoch")
	}
	var result any
	status := 200
	e = a.db.Update(func(tx *bolt.Tx) error {
		now, e := custodyNow(tx)
		if e != nil {
			return e
		}
		bucket := tx.Bucket([]byte("entries"))
		if p == "/lease" {
			decoded, e := hex.DecodeString(request.SHA)
			if e != nil || len(decoded) != 32 {
				status = 400
				return errors.New("SHA256 required")
			}
			n := 0
			bucket.ForEach(func(_, _ []byte) error { n++; return nil })
			if n >= custodyEntries {
				status = 429
				return errors.New("journal entry capacity; existing custody retained")
			}
			x := &custodyEntry{ID: randomCustodyID(), Epoch: a.epoch, SHA: request.SHA, Until: now + custodyInputMS, RetainUntil: now + custodyInputMS + custodyKeepMS, State: "issued", Reason: "No custody until immutable bytes durably accepted"}
			if e = putCustody(tx, x); e != nil {
				return e
			}
			result = safeCustody(x)
			return nil
		}
		if request.Epoch != a.epoch {
			status = 409
			return errors.New("agent epoch changed; do not renew ambiguous input")
		}
		x, e := loadCustody(tx, request.ID)
		if e != nil {
			status = 410
			return e
		}
		switch p {
		case "/receipt":
			result = safeCustody(x)
			return nil
		case "/recover":
			if x.State == "stored" {
				result = safeCustody(x)
				return nil
			}
			if x.State != "blocked" || (len(x.Body) == 0 && x.Token == "") {
				status = 409
				return errors.New("no retained receipt/recovery state available")
			}
			x.Recover = true
			if e = putCustody(tx, x); e != nil {
				return e
			}
			result = safeCustody(x)
			return nil
		case "/metrics":
			sum := sha256.Sum256(b)
			if hex.EncodeToString(sum[:]) != x.SHA {
				status = 409
				return errors.New("immutable input body mismatch")
			}
			if x.State != "issued" {
				result = safeCustody(x)
				return nil
			}
			if now >= x.Until {
				status = 410
				return errors.New("input eligibility ended; never renew these deltas")
			}
			used := 0
			if err := bucket.ForEach(func(_, v []byte) error {
				var y custodyEntry
				if e := json.Unmarshal(v, &y); e != nil {
					return e
				}
				used += len(y.Body)
				return nil
			}); err != nil {
				return err
			}
			if used+len(b) > custodyBytes {
				status = 429
				return errors.New("journal payload capacity; no custody accepted")
			}
			x.Body = append([]byte(nil), b...)
			x.State = "custody"
			x.Reason = "Durable agent custody, not backend stored"
			if e = putCustody(tx, x); e != nil {
				return e
			}
			result = safeCustody(x)
			return nil
		default:
			status = 404
			return errors.New("unknown custody route")
		}
	})
	if e != nil {
		if status == 200 {
			status = 503
		}
		jsonCustody(w, status, map[string]any{"error": e.Error()})
		return
	}
	jsonCustody(w, 200, result)
}
func (a *custodyAgent) run() {
	defer close(a.done)
	tick := time.NewTicker(200 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-a.stop:
			return
		case <-tick.C:
			a.step()
			if time.Now().UnixMilli()-a.lastReport >= 5000 {
				a.lastReport = time.Now().UnixMilli()
				a.report()
			}
		}
	}
}
func (a *custodyAgent) step() {
	var work *custodyEntry
	e := a.db.Update(func(tx *bolt.Tx) error {
		now, e := custodyNow(tx)
		if e != nil {
			return e
		}
		b := tx.Bucket([]byte("entries"))
		var counts custodyCounts
		json.Unmarshal(tx.Bucket([]byte("meta")).Get([]byte("counts")), &counts)
		remove := [][]byte{}
		updates := []*custodyEntry{}
		e = b.ForEach(func(k, v []byte) error {
			var x custodyEntry
			if e := json.Unmarshal(v, &x); e != nil {
				return e
			}
			if now > x.RetainUntil {
				if x.State == "stored" {
					counts.Stored++
				} else if x.State == "refused" {
					counts.Refused++
				} else {
					counts.Unconfirmed++
				}
				if counts.First == 0 || x.Until < counts.First {
					counts.First = x.Until
				}
				if x.Until > counts.Last {
					counts.Last = x.Until
				}
				remove = append(remove, append([]byte(nil), k...))
				return nil
			}
			if len(x.Body) > 0 && now >= x.Until+custodyKeepMS && x.State != "stored" {
				x.Body = nil
				x.State = "expired-unconfirmed"
				x.Reason = "Finite custody window ended; no identity renewal"
				updates = append(updates, &x)
			}
			if work == nil && (x.State == "custody" || x.Recover) {
				x.Recover = false
				work = &x
				updates = append(updates, &x)
				return nil
			}
			return nil
		})
		if e != nil {
			return e
		}
		for _, x := range updates {
			if e = putCustody(tx, x); e != nil {
				return e
			}
		}
		for _, k := range remove {
			if e = b.Delete(k); e != nil {
				return e
			}
		}
		v, _ := json.Marshal(counts)
		return tx.Bucket([]byte("meta")).Put([]byte("counts"), v)
	})
	if e != nil || work == nil {
		return
	}
	a.deliver(work)
}
func (a *custodyAgent) save(x *custodyEntry) error {
	return a.db.Update(func(tx *bolt.Tx) error {
		if _, e := custodyNow(tx); e != nil {
			return e
		}
		old, e := loadCustody(tx, x.ID)
		if e != nil {
			return e
		}
		if old.Epoch != x.Epoch {
			return errors.New("epoch mismatch")
		}
		return putCustody(tx, x)
	})
}
func (a *custodyAgent) backend(path string, body []byte, token string) (int, []byte, error) {
	req, e := http.NewRequest("POST", strings.TrimRight(a.cfg.Backend, "/")+"/otlp/experimental/metric-delivery/v1"+path, bytes.NewReader(body))
	if e != nil {
		return 0, nil, e
	}
	req.Header.Set("DC-API-KEY", a.cfg.APIKey)
	req.Header.Set("content-type", "application/json")
	if path == "/metrics" {
		req.Header.Set("content-type", "application/x-protobuf")
		req.Header.Set("x-monitoring-delivery-token", token)
	}
	res, e := a.client.Do(req)
	if e != nil {
		return 0, nil, e
	}
	defer res.Body.Close()
	b, e := io.ReadAll(io.LimitReader(res.Body, 8192))
	return res.StatusCode, b, e
}
func (a *custodyAgent) deliver(x *custodyEntry) {
	block := func(reason string) { x.State = "blocked"; x.Reason = reason; a.save(x) }
	if x.Token != "" {
		status, b, e := a.backend("/receipt", []byte(fmt.Sprintf(`{"token":%q}`, x.Token)), "")
		if e != nil || status != 200 {
			block("Backend receipt unavailable; original identity retained")
			return
		}
		var r struct {
			State    string `json:"state"`
			Accepted int    `json:"accepted"`
		}
		if json.Unmarshal(b, &r) != nil {
			block("Invalid receipt; no resend")
			return
		}
		if r.State == "stored" {
			x.State = "stored"
			x.Accepted = r.Accepted
			x.Body = nil
			x.Reason = "Backend synchronous receipt confirmed"
			a.save(x)
			return
		}
		if r.State == "unknown" || r.State == "expired-unconfirmed" || time.Now().UnixMilli() >= x.BackendUntil {
			x.State = "expired-unconfirmed"
			x.Body = nil
			x.Reason = "Backend eligibility/receipt ended; never renew identity"
			a.save(x)
			return
		}
	}
	if len(x.Body) == 0 || x.Attempts >= 3 {
		block("Finite send budget or payload ended")
		return
	}
	if x.Token == "" {
		status, b, e := a.backend("/lease", []byte(fmt.Sprintf(`{"sha":%q}`, x.SHA)), "")
		if e != nil || status != 200 {
			block("Backend lease unavailable, no metric send occurred")
			return
		}
		var l struct {
			Token        string `json:"token"`
			ID           string `json:"id"`
			Until        int64  `json:"until"`
			ReceiptUntil int64  `json:"receiptUntil"`
		}
		if json.Unmarshal(b, &l) != nil || l.Token == "" || l.Until <= time.Now().UnixMilli() {
			block("Invalid backend lease; no metric send occurred")
			return
		}
		x.Token = l.Token
		x.BackendID = l.ID
		x.BackendUntil = l.Until
		x.ReceiptUntil = l.ReceiptUntil
		if a.save(x) != nil {
			return
		}
	}
	// Persist the possibility of a send BEFORE networking. On restart, custody
	// entries reconcile receipt first using this same token. No regenerated ID.
	x.Sent = true
	x.Attempts++
	x.State = "custody"
	x.Reason = "Backend acceptance unconfirmed"
	if a.save(x) != nil {
		return
	}
	status, _, e := a.backend("/metrics", x.Body, x.Token)
	if e == nil && status == 200 {
		x.State = "stored"
		x.Body = nil
		x.Reason = "Backend synchronous acceptance ACK"
		a.save(x)
		return
	}
	block("Backend send refused/unconfirmed; explicit bounded recovery reconciles original receipt")
}

func (a *custodyAgent) fileSize() int64 {
	st, e := os.Stat(a.db.Path())
	if e != nil {
		return -1
	}
	return st.Size()
}

// Best-effort diagnostic mirror, not custody authority or payload transport.
func (a *custodyAgent) report() {
	rows := []any{}
	var counts custodyCounts
	e := a.db.View(func(tx *bolt.Tx) error {
		json.Unmarshal(tx.Bucket([]byte("meta")).Get([]byte("counts")), &counts)
		return tx.Bucket([]byte("entries")).ForEach(func(_, v []byte) error {
			var x custodyEntry
			if e := json.Unmarshal(v, &x); e != nil {
				return e
			}
			rows = append(rows, safeCustody(&x))
			return nil
		})
	})
	if e != nil {
		return
	}
	b, e := json.Marshal(map[string]any{"epoch": a.epoch, "entries": rows, "counts": counts, "journalFileBytes": a.fileSize()})
	if e != nil || len(b) > 65536 {
		return
	}
	a.backend("/agent-status", b, "")
}
