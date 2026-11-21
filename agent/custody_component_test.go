package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	bolt "go.etcd.io/bbolt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func custodyPort(t *testing.T) string {
	t.Helper()
	l, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	p := l.Addr().String()
	l.Close()
	return p
}
func custodyReq(t *testing.T, base, path string, b any, key string) (int, map[string]any) {
	t.Helper()
	var raw []byte
	if v, ok := b.([]byte); ok {
		raw = v
	} else {
		raw, _ = json.Marshal(b)
	}
	method := "POST"
	if b == nil {
		method = "GET"
	}
	r, _ := http.NewRequest(method, base+path, bytes.NewReader(raw))
	r.Header.Set("DC-API-KEY", key)
	if p, ok := b.(map[string]any); ok {
		if id, ok := p["_input"].(string); ok {
			r.Header.Set("X-Monitoring-Input-ID", id)
			r.Header.Set("X-Monitoring-Agent-Epoch", p["epoch"].(string))
			r.Body = io.NopCloser(bytes.NewReader([]byte(p["body"].(string))))
			r.ContentLength = int64(len(p["body"].(string)))
			r.GetBody = nil
		}
	}
	res, e := http.DefaultClient.Do(r)
	if e != nil {
		t.Fatal(e)
	}
	defer res.Body.Close()
	var x map[string]any
	if e = json.NewDecoder(res.Body).Decode(&x); e != nil {
		t.Fatal(e)
	}
	return res.StatusCode, x
}
func startCustodyTest(t *testing.T, dir, backend string) (*custodyAgent, string) {
	t.Helper()
	a := &custodyAgent{cfg: custodyConfig{Endpoint: custodyPort(t), Directory: dir, Backend: backend, APIKey: "synthetic-custody-key"}}
	if e := a.Start(context.Background(), nil); e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { ctx, c := context.WithTimeout(context.Background(), time.Second*8); defer c(); a.Shutdown(ctx) })
	return a, "http://" + a.cfg.Endpoint + "/monitoring/experimental/metric-custody/v1"
}
func issueCustodyTest(t *testing.T, base, body string) map[string]any {
	sum := sha256.Sum256([]byte(body))
	s, x := custodyReq(t, base, "/lease", map[string]any{"sha": hex.EncodeToString(sum[:])}, "synthetic-custody-key")
	if s != 200 {
		t.Fatalf("lease %d %v", s, x)
	}
	return x
}
func TestCustodyComponentIdentityCapacityAndEpoch(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(503); fmt.Fprint(w, `{}`) }))
	defer backend.Close()
	dir := filepath.Join(t.TempDir(), "state")
	a, base := startCustodyTest(t, dir, backend.URL)
	s, _ := custodyReq(t, base, "/capabilities", nil, "")
	if s != 403 {
		t.Fatal(s)
	}
	l := issueCustodyTest(t, base, "7")
	id, epoch := l["id"].(string), l["epoch"].(string)
	s, x := custodyReq(t, base, "/metrics", map[string]any{"_input": id, "epoch": epoch, "body": "7"}, "synthetic-custody-key")
	if s != 200 || x["custody"] != true || x["backendStored"] != false {
		t.Fatalf("custody not stored %d %v", s, x)
	}
	s, _ = custodyReq(t, base, "/metrics", map[string]any{"_input": id, "epoch": epoch, "body": "8"}, "synthetic-custody-key")
	if s != 409 {
		t.Fatal(s)
	}
	s, _ = custodyReq(t, base, "/receipt", map[string]any{"id": id, "epoch": "old-epoch"}, "synthetic-custody-key")
	if s != 409 {
		t.Fatal(s)
	}
	for i := 1; i < custodyEntries; i++ {
		issueCustodyTest(t, base, "7")
	}
	sum := sha256.Sum256([]byte("7"))
	s, _ = custodyReq(t, base, "/lease", map[string]any{"sha": hex.EncodeToString(sum[:])}, "synthetic-custody-key")
	if s != 429 {
		t.Fatalf("capacity %d", s)
	}
	// Clock expiry modeled only in scratch journal records, not production promise.
	if e := a.db.Update(func(tx *bolt.Tx) error {
		return tx.Bucket([]byte("entries")).ForEach(func(k, v []byte) error {
			var z custodyEntry
			json.Unmarshal(v, &z)
			z.RetainUntil = time.Now().UnixMilli() - 1
			return putCustody(tx, &z)
		})
	}); e != nil {
		t.Fatal(e)
	}
	a.step()
	fresh := issueCustodyTest(t, base, "7")
	if fresh["id"] == id {
		t.Fatal("reused input identity")
	}
	s, _ = custodyReq(t, base, "/receipt", map[string]any{"id": id, "epoch": epoch}, "synthetic-custody-key")
	if s != 410 {
		t.Fatal(s)
	}
	_, status := custodyReq(t, base, "/status", nil, "synthetic-custody-key")
	if status["counts"].(map[string]any)["unconfirmed"].(float64) != custodyEntries {
		t.Fatal(status)
	}
	// Fresh journal has different epoch and cannot reaccept a previous identity.
	_, base2 := startCustodyTest(t, filepath.Join(t.TempDir(), "fresh"), backend.URL)
	s, _ = custodyReq(t, base2, "/metrics", map[string]any{"_input": id, "epoch": epoch, "body": "7"}, "synthetic-custody-key")
	if s != 409 {
		t.Fatal(s)
	}
}
func TestCustodyCrashWorker(t *testing.T) {
	if os.Getenv("CUSTODY_CRASH_WORKER") != "yes" {
		t.Skip("subprocess only")
	}
	a := &custodyAgent{cfg: custodyConfig{Endpoint: os.Getenv("CUSTODY_ENDPOINT"), Directory: os.Getenv("CUSTODY_DIR"), Backend: os.Getenv("CUSTODY_BACKEND"), APIKey: "synthetic-custody-key"}}
	if e := a.Start(context.Background(), nil); e != nil {
		t.Fatal(e)
	}
	fmt.Println("CUSTODY_WORKER_READY")
	select {}
}
func TestCustodyComponentACKKillRestartNoEpochRenewal(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(503); fmt.Fprint(w, `{}`) }))
	defer backend.Close()
	dir := filepath.Join(t.TempDir(), "state")
	endpoint := custodyPort(t)
	base := "http://" + endpoint + "/monitoring/experimental/metric-custody/v1"
	start := func() *exec.Cmd {
		cmd := exec.Command(os.Args[0], "-test.run=^TestCustodyCrashWorker$")
		cmd.Env = append(os.Environ(), "CUSTODY_CRASH_WORKER=yes", "CUSTODY_ENDPOINT="+endpoint, "CUSTODY_DIR="+dir, "CUSTODY_BACKEND="+backend.URL)
		var logs bytes.Buffer
		cmd.Stdout = &logs
		cmd.Stderr = &logs
		if e := cmd.Start(); e != nil {
			t.Fatal(e)
		}
		for i := 0; i < 100; i++ {
			req, _ := http.NewRequest("GET", base+"/capabilities", nil)
			req.Header.Set("DC-API-KEY", "synthetic-custody-key")
			res, e := http.DefaultClient.Do(req)
			if e == nil {
				res.Body.Close()
				if res.StatusCode == 200 {
					return cmd
				}
			}
			time.Sleep(20 * time.Millisecond)
		}
		cmd.Process.Kill()
		cmd.Wait()
		t.Fatal("worker did not start: " + logs.String())
		return nil
	}
	cmd := start()
	l := issueCustodyTest(t, base, "7")
	id, epoch := l["id"].(string), l["epoch"].(string)
	s, x := custodyReq(t, base, "/metrics", map[string]any{"_input": id, "epoch": epoch, "body": "7"}, "synthetic-custody-key")
	if s != 200 || x["custody"] != true {
		cmd.Process.Kill()
		cmd.Wait()
		t.Fatal(s, x)
	}
	cmd.Process.Kill()
	cmd.Wait()
	cmd = start()
	defer func() { cmd.Process.Kill(); cmd.Wait() }()
	s, x = custodyReq(t, base, "/receipt", map[string]any{"id": id, "epoch": epoch}, "synthetic-custody-key")
	if s != 200 || x["custody"] != true || x["retainedBytes"].(float64) != 1 || x["backendStored"] != false {
		t.Fatal(s, x)
	}
	s, x = custodyReq(t, base, "/metrics", map[string]any{"_input": id, "epoch": epoch, "body": "7"}, "synthetic-custody-key")
	if s != 200 || x["id"] != id {
		t.Fatal(s, x)
	}
}
func TestCustodyComponentConfigNoExternalListener(t *testing.T) {
	a := &custodyAgent{cfg: custodyConfig{Endpoint: "0.0.0.0:4438", Directory: filepath.Join(t.TempDir(), "must-not-exist"), Backend: "http://localhost", APIKey: "key"}}
	if e := a.Start(context.Background(), nil); e == nil {
		t.Fatal("external bind accepted")
	}
	if _, e := os.Stat(a.cfg.Directory); !os.IsNotExist(e) {
		t.Fatal("invalid listener created state")
	}
	if strings.Contains(custodyProtocol, "exactly") {
		t.Fatal("invalid promise")
	}
}

func TestCustodyComponentBackendACKLossIdentityAndBudget(t *testing.T) {
	var mu sync.Mutex
	leases, sends, stored := 0, 0, false
	seenToken, seenBody := "", ""
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		mu.Lock()
		defer mu.Unlock()
		w.Header().Set("content-type", "application/json")
		switch {
		case strings.HasSuffix(r.URL.Path, "/lease"):
			leases++
			fmt.Fprintf(w, `{"token":"fixed-backend-token","id":"fixed-backend-id","until":%d,"receiptUntil":%d}`, time.Now().UnixMilli()+30000, time.Now().UnixMilli()+60000)
		case strings.HasSuffix(r.URL.Path, "/metrics"):
			sends++
			seenToken = r.Header.Get("x-monitoring-delivery-token")
			seenBody = string(raw)
			stored = true
			c, _, _ := w.(http.Hijacker).Hijack()
			c.Close()
		case strings.HasSuffix(r.URL.Path, "/receipt"):
			if stored {
				fmt.Fprint(w, `{"state":"stored","accepted":1}`)
			} else {
				fmt.Fprint(w, `{"state":"unconfirmed"}`)
			}
		default:
			w.WriteHeader(404)
		}
	}))
	defer backend.Close()
	a, base := startCustodyTest(t, filepath.Join(t.TempDir(), "journal"), backend.URL)
	if a.db.NoSync {
		t.Fatal("durable custody requires synchronous journal")
	}
	l := issueCustodyTest(t, base, "7")
	id, epoch := l["id"].(string), l["epoch"].(string)
	s, _ := custodyReq(t, base, "/metrics", map[string]any{"_input": id, "epoch": epoch, "body": "7"}, "synthetic-custody-key")
	if s != 200 {
		t.Fatal(s)
	}
	var x map[string]any
	for i := 0; i < 100; i++ {
		_, x = custodyReq(t, base, "/receipt", map[string]any{"id": id, "epoch": epoch}, "synthetic-custody-key")
		if x["state"] == "blocked" {
			break
		}
		time.Sleep(time.Millisecond * 10)
	}
	if x["state"] != "blocked" {
		t.Fatal(x)
	}
	// Force send budget exhausted. Receipt reconciliation must still be available
	// after all sends, never demand a fresh lease to learn accepted outcome.
	if e := a.db.Update(func(tx *bolt.Tx) error {
		z, e := loadCustody(tx, id)
		if e != nil {
			return e
		}
		z.Attempts = 3
		return putCustody(tx, z)
	}); e != nil {
		t.Fatal(e)
	}
	s, _ = custodyReq(t, base, "/recover", map[string]any{"id": id, "epoch": epoch}, "synthetic-custody-key")
	if s != 200 {
		t.Fatal(s)
	}
	for i := 0; i < 100; i++ {
		_, x = custodyReq(t, base, "/receipt", map[string]any{"id": id, "epoch": epoch}, "synthetic-custody-key")
		if x["backendStored"] == true {
			break
		}
		time.Sleep(time.Millisecond * 10)
	}
	if x["backendStored"] != true || x["retainedBytes"].(float64) != 0 {
		t.Fatal(x)
	}
	s, _ = custodyReq(t, base, "/metrics", map[string]any{"_input": id, "epoch": epoch, "body": "7"}, "synthetic-custody-key")
	if s != 200 {
		t.Fatal(s)
	}
	mu.Lock()
	defer mu.Unlock()
	if leases != 1 || sends != 1 || seenToken != "fixed-backend-token" || seenBody != "7" {
		t.Fatalf("identity renewed/resent: leases%d sends%d token%s body%s", leases, sends, seenToken, seenBody)
	}
}

func TestCustodyComponentPayloadBoundAndAtomicExpiryFailure(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(503); fmt.Fprint(w, `{}`) }))
	defer backend.Close()
	a, base := startCustodyTest(t, filepath.Join(t.TempDir(), "payload-journal"), backend.URL)
	// This test manually drives the real sweep and rewrites expiry in the journal.
	// Stop the background worker first, including any in-flight backend/save, so
	// a pre-injection snapshot cannot overwrite the deliberately changed expiry.
	close(a.stop)
	<-a.done
	a.stop = make(chan struct{})
	// done is already closed; Shutdown still closes the fresh stop and HTTP server.
	body := strings.Repeat("x", 1024*1024)
	ids := []string{}
	for i := 0; i < 16; i++ {
		l := issueCustodyTest(t, base, body)
		ids = append(ids, l["id"].(string))
		s, x := custodyReq(t, base, "/metrics", map[string]any{"_input": l["id"], "epoch": l["epoch"], "body": body}, "synthetic-custody-key")
		if s != 200 || x["custody"] != true {
			t.Fatal(i, s, x)
		}
	}
	extra := issueCustodyTest(t, base, body)
	s, _ := custodyReq(t, base, "/metrics", map[string]any{"_input": extra["id"], "epoch": extra["epoch"], "body": body}, "synthetic-custody-key")
	if s != 429 {
		t.Fatalf("logical payload capacity not enforced: %d", s)
	}
	// Inject a bad later journal record so the ACTUAL sweep returns an error after
	// inspecting expired rows. Payload deletion and counters must both roll back.

	if e := a.db.Update(func(tx *bolt.Tx) error {
		for _, id := range ids {
			x, e := loadCustody(tx, id)
			if e != nil {
				return e
			}
			x.RetainUntil = time.Now().UnixMilli() - 1
			if e = putCustody(tx, x); e != nil {
				return e
			}
		}
		return tx.Bucket([]byte("entries")).Put([]byte("zzzz-fault"), []byte("invalid-json"))
	}); e != nil {
		t.Fatal(e)
	}

	a.step()
	if e := a.db.View(func(tx *bolt.Tx) error {
		x, e := loadCustody(tx, ids[0])
		if e != nil {
			return e
		}
		if len(x.Body) != len(body) {
			t.Fatal("payload reclaimed despite aborted sweep")
		}
		var c custodyCounts
		json.Unmarshal(tx.Bucket([]byte("meta")).Get([]byte("counts")), &c)
		if c.Unconfirmed != 0 {
			t.Fatal("partial aggregate on aborted sweep")
		}
		return nil
	}); e != nil {
		t.Fatal(e)
	}
	if e := a.db.Update(func(tx *bolt.Tx) error { return tx.Bucket([]byte("entries")).Delete([]byte("zzzz-fault")) }); e != nil {
		t.Fatal(e)
	}
	a.step()
	s, x := custodyReq(t, base, "/metrics", map[string]any{"_input": extra["id"], "epoch": extra["epoch"], "body": body}, "synthetic-custody-key")
	if s != 200 || x["custody"] != true {
		t.Fatal("cleanup did not restore payload capacity", s, x)
	}
	_, status := custodyReq(t, base, "/status", nil, "synthetic-custody-key")
	if status["counts"].(map[string]any)["unconfirmed"].(float64) != 16 {
		t.Fatal(status)
	}
}

func TestCustodyComponentPhysicalCapRefusesWithoutErasingCustody(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(503); fmt.Fprint(w, `{}`) }))
	defer backend.Close()
	a, base := startCustodyTest(t, filepath.Join(t.TempDir(), "physical-journal"), backend.URL)
	l := issueCustodyTest(t, base, "7")
	id, epoch := l["id"].(string), l["epoch"].(string)
	s, _ := custodyReq(t, base, "/metrics", map[string]any{"_input": id, "epoch": epoch, "body": "7"}, "synthetic-custody-key")
	if s != 200 {
		t.Fatal(s)
	}
	limit := a.fileSize() + 65536
	if e := a.db.Update(func(tx *bolt.Tx) error { a.db.MaxSize = int(limit); return nil }); e != nil {
		t.Fatal(e)
	}
	e := a.db.Update(func(tx *bolt.Tx) error {
		return tx.Bucket([]byte("meta")).Put([]byte("forced-capacity-test"), bytes.Repeat([]byte("x"), int(limit)*2))
	})
	if e == nil {
		t.Fatal("physical limit did not refuse oversized journal transaction")
	}
	if a.fileSize() > limit {
		t.Fatalf("file grew beyond cap: %d > %d", a.fileSize(), limit)
	}
	s, x := custodyReq(t, base, "/receipt", map[string]any{"id": id, "epoch": epoch}, "synthetic-custody-key")
	if s != 200 || x["custody"] != true {
		t.Fatal("acknowledged custody disappeared", s, x)
	}
}
