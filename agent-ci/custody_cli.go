package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

// A CLI projection, never the journal record: no body, hash, API key or backend token.
type custodyCLIEntry struct {
	ID            string `json:"id"`
	Epoch         string `json:"epoch"`
	State         string `json:"state"`
	Reason        string `json:"reason"`
	Until         int64  `json:"until"`
	RetainUntil   int64  `json:"retainUntil"`
	RetainedBytes int    `json:"retainedBytes"`
	BackendID     string `json:"backendId"`
	BackendUntil  int64  `json:"backendUntil"`
	Attempts      int    `json:"attempts"`
	Custody       bool   `json:"custody"`
	BackendStored bool   `json:"backendStored"`
}
type custodyCLIStatus struct {
	Protocol            string            `json:"protocol"`
	Epoch               string            `json:"epoch"`
	Entries             []custodyCLIEntry `json:"entries"`
	Counts              custodyCounts     `json:"counts"`
	JournalFileBytes    int64             `json:"journalFileBytes"`
	MaxJournalFileBytes int64             `json:"maxJournalFileBytes"`
}

func custodyCLIIdentity(s string) bool {
	if len(s) != 32 {
		return false
	}
	for _, c := range s {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}
func runCustodyCLI(args []string, out io.Writer) error {
	if len(args) == 0 || args[0] != "status" && args[0] != "recover" {
		return errors.New("use custody status -c FILE or custody recover --id ID --epoch E -c FILE; experimental only")
	}
	command := args[0]
	configPath := defaultConfigPath()
	id, epoch := "", ""
	seen := map[string]bool{}
	for i := 1; i < len(args); i++ {
		flag := args[i]
		if flag != "-c" && flag != "--config" && flag != "--id" && flag != "--epoch" {
			return errors.New("unsupported custody option")
		}
		if flag == "--config" {
			flag = "-c"
		}
		if seen[flag] || i+1 >= len(args) {
			return errors.New("missing or duplicate custody option")
		}
		seen[flag] = true
		i++
		switch flag {
		case "-c":
			configPath = args[i]
		case "--id":
			id = args[i]
		case "--epoch":
			epoch = args[i]
		}
	}
	if command == "status" && (id != "" || epoch != "") {
		return errors.New("status takes no input identity")
	}
	if command == "recover" && (!custodyCLIIdentity(id) || !custodyCLIIdentity(epoch)) {
		return errors.New("recover requires the exact 32-character input ID and journal epoch from status")
	}
	cfg, e := loadConfig(configPath)
	if e != nil {
		return errors.New("cannot read a valid custody configuration")
	}
	if !cfg.CustodyTest.Enabled || cfg.CustodyTest.Endpoint == "" || cfg.StateDir == "" || cfg.APIKey == "" || strings.ContainsAny(cfg.APIKey, "\r\n") {
		return errors.New("custody CLI requires explicit enabled experimental custody, endpoint, state_dir and API key")
	}
	host, port, e := net.SplitHostPort(cfg.CustodyTest.Endpoint)
	ip := net.ParseIP(host)
	n, pe := strconv.Atoi(port)
	if e != nil || ip == nil || !ip.IsLoopback() || pe != nil || n < 1 || n > 65535 {
		return errors.New("custody CLI requires an explicit loopback IP and nonzero port")
	}
	base := "http://" + net.JoinHostPort(host, port) + "/monitoring/experimental/metric-custody/v1"
	client := &http.Client{Timeout: 6 * time.Second, Transport: &http.Transport{Proxy: nil}, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("redirect refused") }}
	defer client.CloseIdleConnections()
	request := func(route string, body any, target any) error {
		var data []byte
		method := "GET"
		if body != nil {
			method = "POST"
			data, _ = json.Marshal(body)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
		defer cancel()
		req, e := http.NewRequestWithContext(ctx, method, base+route, bytes.NewReader(data))
		if e != nil {
			return errors.New("invalid custody request")
		}
		req.Header.Set("DC-API-KEY", cfg.APIKey)
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		res, e := client.Do(req)
		if e != nil {
			return errors.New("local custody agent unavailable; no replacement identity was created")
		}
		defer res.Body.Close()
		if res.StatusCode != 200 {
			return fmt.Errorf("local agent refused custody request (HTTP %d); no replacement identity was created", res.StatusCode)
		}
		b, e := io.ReadAll(io.LimitReader(res.Body, 1048577))
		if e != nil || len(b) > 1048576 || json.Unmarshal(b, target) != nil {
			return errors.New("invalid local custody response")
		}
		return nil
	}
	var cap struct {
		Protocol string `json:"protocol"`
		Epoch    string `json:"epoch"`
	}
	if e = request("/capabilities", nil, &cap); e != nil {
		return e
	}
	if cap.Protocol != custodyProtocol || !custodyCLIIdentity(cap.Epoch) {
		return errors.New("unsupported local custody protocol")
	}
	enc := json.NewEncoder(out)
	enc.SetIndent("", "  ")
	warning := "TEST ONLY. Agent custody is not backend storage. Finite windows; no identity renewal. Default delivery response-loss defects remain."
	if command == "status" {
		var s custodyCLIStatus
		if e = request("/status", nil, &s); e != nil {
			return e
		}
		if s.Protocol != custodyProtocol || s.Epoch != cap.Epoch {
			return errors.New("local journal epoch changed during status; inspect again")
		}
		if s.Entries == nil {
			s.Entries = []custodyCLIEntry{}
		}
		return enc.Encode(struct {
			Warning string           `json:"warning"`
			Status  custodyCLIStatus `json:"status"`
		}{warning, s})
	}
	if epoch != cap.Epoch {
		return errors.New("journal epoch mismatch; old input cannot be renewed")
	}
	body := map[string]string{"id": id, "epoch": epoch}
	var entry custodyCLIEntry
	if e = request("/receipt", body, &entry); e != nil {
		return e
	}
	if entry.ID != id || entry.Epoch != epoch {
		return errors.New("receipt identity mismatch; no recovery requested")
	}
	if entry.State == "stored" && entry.BackendStored {
		return enc.Encode(struct {
			Warning           string          `json:"warning"`
			RecoveryRequested bool            `json:"recoveryRequested"`
			Entry             custodyCLIEntry `json:"entry"`
		}{warning, false, entry})
	}
	if entry.State != "blocked" || entry.RetainUntil <= time.Now().UnixMilli() {
		return errors.New("input is not retained and blocked; inspect status, do not create a replacement identity")
	}
	if e = request("/recover", body, &entry); e != nil {
		return e
	}
	if entry.ID != id || entry.Epoch != epoch {
		return errors.New("recovery response identity mismatch; inspect original status")
	}
	return enc.Encode(struct {
		Warning           string          `json:"warning"`
		RecoveryRequested bool            `json:"recoveryRequested"`
		Notice            string          `json:"notice"`
		Entry             custodyCLIEntry `json:"entry"`
	}{warning, true, "Recovery request accepted by local agent, not a storage confirmation. Run custody status to inspect the later outcome.", entry})
}

func executeCustodyCLI(args []string) error { return runCustodyCLI(args, os.Stdout) }
