package main

import (
	"encoding/hex"
	"testing"

	"github.com/open-telemetry/opentelemetry-collector-contrib/pkg/stanza/entry"
)

func TestJSONNormalization(t *testing.T) {
	e := entry.New()
	e.Body = `{"message":"payment failed","level":"error","dd":{"trace_id":"6af3e9890000000065aeb68962d7c44b","span_id":"18446744073709551615"},"timestamp":"2026-11-11T04:05:30.123Z"}`
	if err := normalizeLog(e); err != nil {
		t.Fatal(err)
	}
	if e.Body != "payment failed" || e.Severity != entry.Error || e.Timestamp.IsZero() {
		t.Fatal("body, severity or timestamp not normalized")
	}
	if hex.EncodeToString(e.TraceID) != "6af3e9890000000065aeb68962d7c44b" || hex.EncodeToString(e.SpanID) != "ffffffffffffffff" {
		t.Fatal("trace context not preserved")
	}
}

func TestContextFormats(t *testing.T) {
	for _, body := range []string{
		`{"msg":"ok","status":"warn","trace_id":"0123456789abcdef0123456789abcdef","span_id":"0123456789abcdef"}`,
		`{"msg":"ok","status":"warn","dd.trace_id":"81985529216486895","dd.span_id":"81985529216486895"}`,
		`{"msg":"ok","severity":"warn","dd.trace_id":81985529216486895,"dd.span_id":81985529216486895}`,
	} {
		e := entry.New()
		e.Body = body
		if err := normalizeLog(e); err != nil {
			t.Fatal(err)
		}
		if e.Body != "ok" || e.Severity != entry.Warn || hex.EncodeToString(e.SpanID) != "0123456789abcdef" {
			t.Fatalf("normalization failed for %s", body)
		}
	}
}

func TestMalformedJSONPreservesBody(t *testing.T) {
	e := entry.New()
	e.Body = "not json"
	if err := normalizeLog(e); err == nil || e.Body != "not json" || e.Attributes["monitoring.parse_error"] == nil {
		t.Fatal("malformed JSON must be preserved and explicitly marked")
	}
}
