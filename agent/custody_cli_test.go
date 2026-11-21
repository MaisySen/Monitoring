package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCustodyCLIExplicitAndSafe(t *testing.T) {
	id, epoch := strings.Repeat("a", 32), strings.Repeat("b", 32)
	key := "test-cli-secret"
	paths := []string{}
	state := "blocked"
	epochReply := epoch
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.Path)
		if r.Header.Get("DC-API-KEY") != key {
			t.Error("missing authentication")
		}
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.HasSuffix(r.URL.Path, "/capabilities"):
			fmt.Fprintf(w, `{"protocol":%q,"epoch":%q}`, custodyProtocol, epochReply)
		case strings.HasSuffix(r.URL.Path, "/status"):
			fmt.Fprintf(w, `{"protocol":%q,"epoch":%q,"entries":[],"token":"must-not-print","body":"must-not-print"}`, custodyProtocol, epochReply)
		default:
			if r.Method != "POST" {
				t.Error("mutation/read protocol mismatch")
			}
			var b map[string]string
			json.NewDecoder(r.Body).Decode(&b)
			if b["id"] != id || b["epoch"] != epoch {
				t.Error("identity changed")
			}
			fmt.Fprintf(w, `{"id":%q,"epoch":%q,"state":%q,"custody":true,"backendStored":%t,"retainUntil":%d,"token":"must-not-print","body":"must-not-print"}`, id, epoch, state, state == "stored", time.Now().Add(time.Minute).UnixMilli())
		}
	}))
	defer server.Close()
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	config := fmt.Sprintf("api_key: %s\nstate_dir: %s/must-not-create\nmetric_custody_test:\n  enabled: true\n  endpoint: %s\n", key, dir, strings.TrimPrefix(server.URL, "http://"))
	os.WriteFile(path, []byte(config), 0600)
	var out bytes.Buffer
	if e := runCustodyCLI([]string{"status", "-c", path}, &out); e != nil {
		t.Fatal(e)
	}
	if strings.Contains(out.String(), key) || strings.Contains(out.String(), "must-not-print") {
		t.Fatal("secret/raw response leaked")
	}
	if _, e := os.Stat(filepath.Join(dir, "must-not-create")); !os.IsNotExist(e) {
		t.Fatal("CLI created journal")
	}
	paths = nil
	out.Reset()
	if e := runCustodyCLI([]string{"recover", "--id", id, "--epoch", epoch, "-c", path}, &out); e != nil {
		t.Fatal(e)
	}
	if len(paths) != 3 || !strings.HasSuffix(paths[1], "/receipt") || !strings.HasSuffix(paths[2], "/recover") {
		t.Fatal(paths)
	}
	if !strings.Contains(out.String(), `"recoveryRequested": true`) || !strings.Contains(out.String(), `"backendStored": false`) {
		t.Fatal(out.String())
	}
	state = "stored"
	paths = nil
	out.Reset()
	if e := runCustodyCLI([]string{"recover", "--id", id, "--epoch", epoch, "-c", path}, &out); e != nil {
		t.Fatal(e)
	}
	if len(paths) != 2 || !strings.Contains(out.String(), `"recoveryRequested": false`) {
		t.Fatal(paths, out.String())
	}
	for _, bad := range []string{"issued", "custody", "expired-unconfirmed", "refused"} {
		state = bad
		paths = nil
		out.Reset()
		if runCustodyCLI([]string{"recover", "--id", id, "--epoch", epoch, "-c", path}, &out) == nil {
			t.Fatal("accepted " + bad)
		}
		if len(paths) != 2 {
			t.Fatal(paths)
		}
	}
	state = "blocked"
	epochReply = strings.Repeat("c", 32)
	paths = nil
	if runCustodyCLI([]string{"recover", "--id", id, "--epoch", epoch, "-c", path}, &out) == nil || len(paths) != 1 {
		t.Fatal("old epoch reached recovery")
	}
	paths = nil
	os.WriteFile(path, []byte(strings.Replace(config, "enabled: true", "enabled: false", 1)), 0600)
	if runCustodyCLI([]string{"status", "-c", path}, &out) == nil || len(paths) != 0 {
		t.Fatal("disabled performed HTTP")
	}
}
func TestCustodyCLIRefusesNetworkOrAmbiguousArgs(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "c.yaml")
	for _, ep := range []string{"example.com:80", "0.0.0.0:4438", "127.0.0.1:0", "127.0.0.1:70000", "localhost:4438"} {
		os.WriteFile(p, []byte("api_key: secret\nmetric_custody_test:\n  enabled: true\n  endpoint: "+ep+"\n"), 0600)
		var b bytes.Buffer
		if runCustodyCLI([]string{"status", "-c", p}, &b) == nil {
			t.Fatal(ep)
		}
	}
	for _, args := range [][]string{{}, {"recover"}, {"status", "--id", "x"}, {"status", "-c", "a", "--config", "b"}, {"status", "--show-secrets"}} {
		var b bytes.Buffer
		if runCustodyCLI(args, &b) == nil {
			t.Fatal(args)
		}
	}
}
