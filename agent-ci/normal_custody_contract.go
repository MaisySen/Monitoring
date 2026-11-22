package main

// Pure candidate contract validators. No networking, listeners, journal IO or wiring.
import (
	"bytes"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/url"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

const normalCProtocol = "monitoring-node-app-service-test-v1"
const normalContract = "node-app-representation-v2-candidate"
const normalCustodyProtocol = "monitoring-node-app-custody-test-v1"
const normalDurability = "same-tx-synchronous-commit"
const normalResponseMax = 65536
const normalMaxInteger int64 = 9007199254740991

var normalInvalid = errors.New("normal custody contract unavailable or incompatible")
var normalID = regexp.MustCompile(`^[a-f0-9]{32}$`)
var normalSHA = regexp.MustCompile(`^[a-f0-9]{64}$`)
var normalReason = regexp.MustCompile(`^[a-z0-9-]{0,64}$`)
var normalAPIKey = regexp.MustCompile(`^[a-fA-F0-9]{32,64}$`)
var normalCredential = regexp.MustCompile(`^[a-f0-9]{64}$`)

// Reject duplicate keys, null, extra documents, excessive depth and invalid UTF-8
// before strict struct decoding. This must run on a separately bounded HTTP body.
func normalJSON(raw []byte, out any) error {
	if len(raw) == 0 || len(raw) > normalResponseMax || !utf8.Valid(raw) || !json.Valid(raw) {
		return normalInvalid
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	var walk func(int) error
	walk = func(depth int) error {
		if depth > 16 {
			return normalInvalid
		}
		t, e := d.Token()
		if e != nil || t == nil {
			return normalInvalid
		}
		switch x := t.(type) {
		case json.Delim:
			if x == '{' {
				seen := map[string]bool{}
				for d.More() {
					k, e := d.Token()
					s, ok := k.(string)
					if e != nil || !ok || seen[s] {
						return normalInvalid
					}
					seen[s] = true
					if e = walk(depth + 1); e != nil {
						return e
					}
				}
				t, e = d.Token()
				if e != nil || t != json.Delim('}') {
					return normalInvalid
				}
			} else if x == '[' {
				for d.More() {
					if e = walk(depth + 1); e != nil {
						return e
					}
				}
				t, e = d.Token()
				if e != nil || t != json.Delim(']') {
					return normalInvalid
				}
			} else {
				return normalInvalid
			}
		}
		return nil
	}
	if e := walk(0); e != nil {
		return e
	}
	if _, e := d.Token(); e != io.EOF {
		return normalInvalid
	}
	d = json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if d.Decode(out) != nil {
		return normalInvalid
	}
	// Typed structs require every JSON field, including zero/false counts.
	var required func([]byte, reflect.Type) error
	required = func(b []byte, t reflect.Type) error {
		if t.Kind() == reflect.Pointer {
			t = t.Elem()
		}
		if t.Kind() != reflect.Struct {
			return nil
		}
		var fields map[string]json.RawMessage
		if json.Unmarshal(b, &fields) != nil {
			return normalInvalid
		}
		for i := 0; i < t.NumField(); i++ {
			f := t.Field(i)
			key := strings.Split(f.Tag.Get("json"), ",")[0]
			v, ok := fields[key]
			if !ok {
				return normalInvalid
			}
			if e := required(v, f.Type); e != nil {
				return e
			}
		}
		return nil
	}
	return required(raw, reflect.TypeOf(out))
}

// Exact accepted C profile. A new version/profile requires explicit source review.
const normalCapabilityJSON = `{"protocol":"monitoring-node-app-service-test-v1","testOnly":true,"profile":"test-v1","storage":"postgres","rawSubset":"node-app-protobuf-subset-v1-candidate","representation":"node-app-representation-v2-candidate","accountingVersion":1,"compression":"none","exactIssuingKeyOnly":true,"lastUsedAtAccounting":false,"localSpool":false,"receiptOnClockUnavailable":"refuse-unavailable","limits":{"bytes":1048576,"fields":100000,"depth":16,"messages":10000,"resources":64,"scopes":256,"metrics":1024,"sourcePoints":1000,"derivedRowsUpperBound":8000,"bucketsPerPoint":2048,"buckets":16384,"kvPerSet":64,"kv":4096,"attributeDepth":8,"attributeBytes":262144,"stringBytes":4096,"nameBytes":256,"schemaBytes":2048},"perWorker":{"admissionMs":30000,"receiptGraceMs":30000,"dataCalls":2,"controlCalls":4,"bufferedBytes":2097152,"bodyMs":1000,"controlBytes":1024,"activeLeases":20,"issuesPerMinute":10,"cleanupBatch":10},"durability":"same-tx-synchronous-commit","supported":["delta-sum","gauge","delta-explicit-histogram","delta-exponential-histogram","nonmonotonic-cumulative-snapshot"],"omitted":["exemplars-refused","unknown-fields-refused","raw-buckets-not-retained","absent-distribution-no-quantiles"]}`

func validateNormalCapability(status int, raw []byte) error {
	if status != 200 {
		return normalInvalid
	}
	var got, want any
	if normalJSON(raw, &got) != nil || normalJSON([]byte(normalCapabilityJSON), &want) != nil || !reflect.DeepEqual(got, want) {
		return normalInvalid
	}
	return nil
}

type normalPopulation struct {
	Source      int64 `json:"sourcePoints"`
	Number      int64 `json:"numberPoints"`
	Explicit    int64 `json:"explicitHistogramPoints"`
	Exponential int64 `json:"exponentialHistogramPoints"`
	Snapshot    int64 `json:"cumulativeSnapshotPoints"`
}

func (p normalPopulation) valid() bool {
	return p.Source >= 0 && p.Source <= 1000 && p.Number >= 0 && p.Explicit >= 0 && p.Exponential >= 0 && p.Snapshot >= 0 && p.Number <= 1000 && p.Explicit <= 1000 && p.Exponential <= 1000 && p.Source == p.Number+p.Explicit+p.Exponential && p.Snapshot <= p.Number
}

type normalAccounting struct {
	Contract           string `json:"contract"`
	Source             int64  `json:"sourcePoints"`
	Number             int64  `json:"numberPoints"`
	Explicit           int64  `json:"explicitHistogramPoints"`
	Exponential        int64  `json:"exponentialHistogramPoints"`
	Snapshot           int64  `json:"cumulativeSnapshotPoints"`
	Omitted            int64  `json:"omittedEmptyHistogramPoints"`
	Derived            int64  `json:"derivedRows"`
	AbsentSum          int64  `json:"absentSumHistogramPoints"`
	AbsentDistribution int64  `json:"absentDistributionHistogramPoints"`
}

func (a normalAccounting) population() normalPopulation {
	return normalPopulation{a.Source, a.Number, a.Explicit, a.Exponential, a.Snapshot}
}
func (a normalAccounting) valid() bool {
	h := a.Explicit + a.Exponential
	return a.Contract == normalContract && a.population().valid() && a.Omitted >= 0 && a.Omitted <= h && a.AbsentSum >= 0 && a.AbsentSum <= h && a.AbsentDistribution >= 0 && a.AbsentDistribution <= h && a.Derived >= a.Number && a.Derived <= 8000 && a.Derived <= a.Number+8*(h-a.Omitted)
}

type normalLease struct {
	Protocol     string `json:"protocol"`
	ID           string `json:"id"`
	Credential   string `json:"credential"`
	Until        int64  `json:"until"`
	ReceiptUntil int64  `json:"receiptUntil"`
	SHA          string `json:"sha"`
	Bytes        int64  `json:"bytes"`
	Contract     string `json:"contract"`
}

func (l normalLease) valid() bool {
	return l.Protocol == normalCProtocol && normalID.MatchString(l.ID) && normalCredential.MatchString(l.Credential) && normalSHA.MatchString(l.SHA) && l.Bytes >= 0 && l.Bytes <= 1048576 && l.Contract == normalContract && l.Until > 0 && l.Until <= normalMaxInteger-30000 && l.ReceiptUntil == l.Until+30000
}

// Timing is conservative request-start anchored; late response cannot extend it.
func validateNormalLease(status int, raw []byte, sha string, size, requestStart, now int64) (normalLease, error) {
	var l normalLease
	if status != 200 || normalJSON(raw, &l) != nil || !l.valid() || l.SHA != sha || l.Bytes != size || requestStart < 0 || now < requestStart || requestStart > normalMaxInteger || now > normalMaxInteger || now-requestStart >= 29000 {
		return normalLease{}, normalInvalid
	}
	return l, nil
}

type normalStored struct {
	State      string           `json:"state"`
	Protocol   string           `json:"protocol"`
	ID         string           `json:"id"`
	SHA        string           `json:"sha"`
	Bytes      int64            `json:"bytes"`
	Accounting normalAccounting `json:"accounting"`
	Durability string           `json:"durability"`
}

func validateNormalStored(status int, raw []byte, l normalLease) (normalStored, error) {
	var s normalStored
	if status != 200 || !l.valid() || normalJSON(raw, &s) != nil || s.State != "stored" || s.Protocol != normalCProtocol || s.ID != l.ID || s.SHA != l.SHA || s.Bytes != l.Bytes || s.Durability != normalDurability || !s.Accounting.valid() {
		return normalStored{}, normalInvalid
	}
	return s, nil
}
func validateNormalReceipt(status int, raw []byte, l normalLease) (string, *normalStored, error) {
	if s, e := validateNormalStored(status, raw, l); e == nil {
		return "stored", &s, nil
	}
	var r struct {
		State string `json:"state"`
		ID    string `json:"id"`
	}
	if status != 200 || !l.valid() || normalJSON(raw, &r) != nil || r.ID != l.ID || (r.State != "unconfirmed" && r.State != "expired-unconfirmed" && r.State != "unknown") {
		return "", nil, normalInvalid
	}
	return r.State, nil, nil
}
func normalOrigin(raw string) (string, error) {
	u, e := url.Parse(raw)
	if e != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.RawPath != "" || (u.Path != "" && u.Path != "/") {
		return "", normalInvalid
	}
	if u.Scheme != "https" && (u.Scheme != "http" || (u.Hostname() != "127.0.0.1" && u.Hostname() != "::1")) {
		return "", normalInvalid
	}
	u.Path = ""
	host, port := strings.ToLower(u.Hostname()), u.Port()
	if host == "" || strings.HasSuffix(u.Host, ":") {
		return "", normalInvalid
	}
	if port != "" {
		n, e := strconv.Atoi(port)
		if e != nil || n < 1 || n > 65535 {
			return "", normalInvalid
		}
		port = strconv.Itoa(n)
	}
	if (u.Scheme == "https" && port == "443") || (u.Scheme == "http" && port == "80") {
		port = ""
	}
	if port != "" {
		u.Host = net.JoinHostPort(host, port)
	} else if strings.Contains(host, ":") {
		u.Host = "[" + host + "]"
	} else {
		u.Host = host
	}
	return u.String(), nil
}
func normalBinding(origin, key string) (string, error) {
	o, e := normalOrigin(origin)
	if e != nil || !normalAPIKey.MatchString(key) {
		return "", normalInvalid
	}
	b, _ := json.Marshal([]string{"1", normalCustodyProtocol, normalContract, o, key})
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:]), nil
}
func sameNormalBinding(a, b string) bool {
	return len(a) == 64 && len(b) == 64 && subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}
