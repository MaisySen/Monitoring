package main

// Bounded http.Handler only. Never Listen/Serve/register automatically. Future
// server integration MUST cap accepted connections before net/http spawns a
// goroutine, set MaxHeaderBytes=8192, ReadHeaderTimeout/ReadTimeout=1s,
// WriteTimeout=2s, IdleTimeout=1s, disable HTTP/2, bind literal loopback, and join
// handler+worker before closing store. Handler alone cannot cap TCP connections.
import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"time"
)

type normalIngress struct {
	w      *normalWorker
	gate   chan struct{}
	frozen bool // guarded by gate; monotonic, never reopened
}

func newNormalIngress(mode string, w *normalWorker) (*normalIngress, error) {
	if mode != "test-v1" || w == nil {
		return nil, normalInvalid
	}
	w.s.mu.Lock()
	defer w.s.mu.Unlock()
	if w.s.ingressClaimed || w.s.db == nil || w.s.poisoned {
		return nil, normalInvalid
	}
	w.s.ingressClaimed = true
	return &normalIngress{w: w, gate: make(chan struct{}, 1)}, nil
}
func normalReply(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_, _ = w.Write(normalMarshal(v))
}
func normalRefuse(w http.ResponseWriter, status int) {
	normalReply(w, status, struct {
		Protocol string `json:"protocol"`
		Error    string `json:"error"`
	}{normalCustodyProtocol, "unavailable-or-incompatible"})
}

// Input-specific SDK envelope intentionally contains the expected digest/size,
// but never backend credential/body/key/destination or producer labels.
type normalInputReply struct {
	Protocol            string            `json:"protocol"`
	Epoch               string            `json:"epoch"`
	ID                  string            `json:"id"`
	SHA                 string            `json:"sha"`
	Bytes               int64             `json:"bytes"`
	Contract            string            `json:"contract"`
	State               string            `json:"state"`
	Custody             bool              `json:"custody"`
	BackendStored       bool              `json:"backendStored"`
	InputUntil          int64             `json:"inputUntil"`
	RetainUntil         int64             `json:"retainUntil"`
	BackendID           *string           `json:"backendId"`
	BackendUntil        *int64            `json:"backendUntil"`
	BackendReceiptUntil *int64            `json:"backendReceiptUntil"`
	Accounting          *normalAccounting `json:"accounting"`
	Durability          *string           `json:"durability"`
	ReasonCode          string            `json:"reasonCode"`
	RecoveryMode        string            `json:"recoveryMode"`
}

func normalInputView(r normalCustodyRecord) normalInputReply {
	out := normalInputReply{Protocol: normalCustodyProtocol, Epoch: r.Epoch, ID: r.InputID, SHA: r.SHA, Bytes: r.Bytes, Contract: r.Contract, State: r.State, Custody: len(r.Body) > 0, BackendStored: r.State == "stored", InputUntil: r.InputUntil, RetainUntil: r.RetainUntil, ReasonCode: r.ReasonCode, RecoveryMode: "receipt-only-no-data-resend"}
	if r.Backend != nil {
		out.BackendID = &r.Backend.ID
		out.BackendUntil = &r.Backend.Until
		out.BackendReceiptUntil = &r.Backend.ReceiptUntil
	}
	if r.Stored != nil {
		a := r.Stored.Accounting
		d := r.Stored.Durability
		out.Accounting = &a
		out.Durability = &d
	}
	return out
}
func (a *normalIngress) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Authenticate before store work; no request body buffering before gate.
	if !normalKey(r.Header, a.w.h.key) {
		normalRefuse(w, 403)
		return
	}
	select {
	case a.gate <- struct{}{}:
		defer func() { <-a.gate }()
	default:
		normalRefuse(w, 429)
		return
	}
	// A deadline-capable future net/http server is mandatory. Test writers expose
	// these same methods without opening a listener. Unsupported writers fail shut.
	rc := http.NewResponseController(w)
	if rc.SetReadDeadline(time.Now().Add(time.Second)) != nil || rc.SetWriteDeadline(time.Now().Add(2*time.Second)) != nil {
		normalRefuse(w, 503)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), time.Second)
	defer cancel()
	if ctx.Err() != nil {
		normalRefuse(w, 408)
		return
	}
	if r.Header.Get("Origin") != "" || r.Header.Get("Cookie") != "" || r.Header.Get("Authorization") != "" || r.URL.RawQuery != "" || r.URL.ForceQuery || r.URL.RawPath != "" || len(r.TransferEncoding) != 0 || len(r.Header.Values("Content-Encoding")) != 0 || r.Header.Get("Expect") != "" {
		normalRefuse(w, 400)
		return
	}
	path := r.URL.Path
	if a.frozen && (path == normalIngressPrefix+"/lease" || path == normalIngressPrefix+"/metrics") {
		normalRefuse(w, 503)
		return
	}
	get := path == normalIngressPrefix+"/capabilities" || path == normalIngressPrefix+"/status" || path == normalIngressPrefix+"/restart-status"
	post := path == normalIngressPrefix+"/lease" || path == normalIngressPrefix+"/metrics" || path == normalIngressPrefix+"/receipt" || path == normalIngressPrefix+"/recover" || path == normalIngressPrefix+"/barrier"
	if (!get && !post) || (get && r.Method != "GET") || (post && r.Method != "POST") {
		normalRefuse(w, 404)
		return
	}
	if (get && r.ContentLength != 0) || (post && (r.ContentLength <= 0 || r.ContentLength > 1048576)) {
		normalRefuse(w, 413)
		return
	}
	if get && len(r.Header.Values("Content-Type")) != 0 {
		normalRefuse(w, 400)
		return
	}
	ct := "application/json"
	limit := int64(4096)
	if path == normalIngressPrefix+"/metrics" {
		ct = "application/x-protobuf"
		limit = 1048576
	}
	if post && (!normalOneHeader(r.Header, "Content-Type", ct) || r.ContentLength > limit) {
		normalRefuse(w, 400)
		return
	}
	// Reject duplicate identity/framing headers even on routes not using them.
	for _, key := range []string{"X-Monitoring-Input-ID", "X-Monitoring-Agent-Epoch", "Content-Length", "Host"} {
		if len(r.Header.Values(key)) > 1 {
			normalRefuse(w, 400)
			return
		}
	}
	if path == normalIngressPrefix+"/restart-status" {
		normalReply(w, 200, a.w.s.resumeStatus())
		return
	}
	// Read-only barrier has independent bounded framing, no sweep/write or clock
	// sampling. Authenticate and admission gate above still apply. No global stop.
	if path == normalIngressPrefix+"/barrier" {
		raw, e := io.ReadAll(io.LimitReader(r.Body, 4097))
		if e != nil || int64(len(raw)) != r.ContentLength || len(raw) > 4096 || ctx.Err() != nil {
			normalRefuse(w, 400)
			return
		}
		out, e := normalReadBarrier(raw, a.w.s.lookup)
		if e != nil || ctx.Err() != nil {
			normalRefuse(w, 503)
			return
		}
		normalReply(w, 200, out)
		return
	}
	stamp := a.w.clock()
	n := stamp.wall
	if e := a.w.s.sweep(n); e != nil {
		normalRefuse(w, 503)
		return
	}
	epoch, e := a.w.s.epoch()
	if e != nil {
		normalRefuse(w, 503)
		return
	}
	if get {
		if path == normalIngressPrefix+"/capabilities" {
			normalReply(w, 200, map[string]any{"protocol": normalCustodyProtocol, "testOnly": true, "profile": "test-v1", "epoch": epoch, "representation": normalContract, "inputMs": 30000, "custodyRetentionMs": 300000, "inputReceiptTotalMs": 330000, "maxEntries": normalEntryLimit, "maxPayloadBytes": normalPayloadLimit, "maxJournalFileBytes": normalFileLimit, "maxInputBytes": 1048576, "agentJournal": true, "sdkLocalSpool": false, "custodyIsBackendStored": false, "recoveryMode": "receipt-only-no-data-resend", "exclusiveModeRequired": true, "dataClockAvailable": stamp.trusted})
		} else {
			x, e := a.w.s.status()
			if e != nil {
				normalRefuse(w, 503)
				return
			}
			normalReply(w, 200, struct {
				Protocol   string           `json:"protocol"`
				Epoch      string           `json:"epoch"`
				ObservedAt int64            `json:"observedAt"`
				SweptAt    int64            `json:"sweptAt"`
				Snapshot   bool             `json:"persistedSnapshotNotLiveEligibility"`
				Status     normalSafeStatus `json:"status"`
			}{normalCustodyProtocol, epoch, n, n, true, x})
		}
		return
	}
	raw, e := io.ReadAll(io.LimitReader(r.Body, limit+1))
	if e != nil || int64(len(raw)) != r.ContentLength || int64(len(raw)) > limit || ctx.Err() != nil {
		normalRefuse(w, 400)
		return
	}
	// Use completion time, not the pre-body timestamp, for admission and floor.
	stamp = a.w.clock()
	n = stamp.wall
	if path == normalIngressPrefix+"/lease" {
		if !stamp.trusted {
			normalRefuse(w, 503)
			return
		}
		var v struct {
			SHA        string           `json:"sha"`
			Bytes      int64            `json:"bytes"`
			Contract   string           `json:"contract"`
			Population normalPopulation `json:"population"`
		}
		if normalJSON(raw, &v) != nil || !normalSHA.MatchString(v.SHA) || v.Bytes <= 0 || v.Bytes > 1048576 || v.Contract != normalContract || !v.Population.valid() {
			normalRefuse(w, 400)
			return
		}
		capacity, e := a.w.s.status()
		if e != nil {
			normalRefuse(w, 503)
			return
		}
		if capacity.PayloadBytes+v.Bytes > normalPayloadLimit {
			normalRefuse(w, 429)
			return
		}
		r, e := a.w.s.issue(v.SHA, v.Bytes, v.Population, n)
		if e != nil {
			if errors.Is(e, normalCapacity) {
				normalRefuse(w, 429)
			} else {
				normalRefuse(w, 503)
			}
			return
		}
		a.w.s.captureResumeIssue(r.InputID, stamp)
		normalReply(w, 200, normalInputView(r))
		return
	}
	var id, ep string
	if path == normalIngressPrefix+"/metrics" {
		x, y := r.Header.Values("X-Monitoring-Input-ID"), r.Header.Values("X-Monitoring-Agent-Epoch")
		if len(x) != 1 || len(y) != 1 {
			normalRefuse(w, 400)
			return
		}
		id, ep = x[0], y[0]
	} else {
		var v struct {
			ID    string `json:"id"`
			Epoch string `json:"epoch"`
		}
		if normalJSON(raw, &v) != nil {
			normalRefuse(w, 400)
			return
		}
		id, ep = v.ID, v.Epoch
	}
	if !normalID.MatchString(id) || ep != epoch {
		normalRefuse(w, 409)
		return
	}
	row, e := a.w.s.lookup(id, ep)
	if e != nil {
		normalRefuse(w, 404)
		return
	}
	if path == normalIngressPrefix+"/metrics" {
		if row.State == "issued" && n >= row.InputUntil {
			normalRefuse(w, 410)
			return
		}
		hash := sha256.Sum256(raw)
		if int64(len(raw)) != row.Bytes || hex.EncodeToString(hash[:]) != row.SHA {
			normalRefuse(w, 409)
			return
		}
		row, e = a.w.s.admit(id, raw, n)
		if e != nil {
			status := 503
			if errors.Is(e, normalCapacity) {
				status = 429
			}
			normalRefuse(w, status)
			return
		}
		// Nothing writes a successful custody response until synchronous admit
		// returns. Simulated lost commit results produce no ACK and poison store.
	}
	// /recover is an idempotent request to observe existing receipt-only work,
	// not a durable resend intent. Automatic worker receipt scanning already owns
	// this work. It never resets budgets/timing or creates a backend/input ID.
	if ctx.Err() != nil {
		normalRefuse(w, 408)
		return
	}
	normalReply(w, 200, normalInputView(row))
}

// Taking the SAME gate as admissions means a completed freeze follows any
// in-flight synchronous admit, and no later lease/DATA admission can race it.
func (a *normalIngress) freeze(ctx context.Context) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	select {
	case a.gate <- struct{}{}:
		defer func() { <-a.gate }()
		a.frozen = true
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
