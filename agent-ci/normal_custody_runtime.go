package main

// Source-only runtime primitives. No registration, listener, goroutine or request
// starts on import/construction. A future integration must select test-v1 as an
// EXCLUSIVE app-metrics route, never run beside Collector/retry/direct exporters.
import (
	"context"
	"crypto/subtle"
	"crypto/tls"
	"encoding/json"
	"io"
	"mime"
	"net"
	"net/http"
	"strings"
	"time"
)

const normalIngressPrefix = "/monitoring/candidate/node-app-custody/v1"
const normalBackendPrefix = "/otlp/candidate/node-app/v1"
const normalRequestTimeout = 5 * time.Second

type normalStamp struct {
	wall       int64
	mono, boot time.Duration
	trusted    bool
}
type normalClock func() normalStamp

func normalElapsed(a, b normalStamp, limit time.Duration) bool {
	if !a.trusted || !b.trusted || b.wall < a.wall || b.mono < a.mono || b.boot < a.boot {
		return false
	}
	m, d, w := b.mono-a.mono, b.boot-a.boot, time.Duration(b.wall-a.wall)*time.Millisecond
	// BOOTTIME includes suspend, Go monotonic runtime time does not. Divergence,
	// NTP steps and uncertain clocks disable DATA instead of extending its window.
	delta := func(x, y time.Duration) time.Duration {
		if x > y {
			return x - y
		}
		return y - x
	}
	return m < limit && d < limit && w < limit && delta(m, d) <= 100*time.Millisecond && delta(d, w) <= 100*time.Millisecond
}

// Own transport, no environment proxy, redirect, cookie jar or decompression.
// Fresh HTTP/1 connections only: DisableKeepAlives means Transport's retry gate
// rejects non-reused connections. POST GetBody=nil and no idempotency headers
// independently forbid body replay. GET uses NoBody to match C's no-TE contract.
type normalHTTP struct {
	origin, key string
	client      *http.Client
}

func newNormalHTTP(origin, key string) (*normalHTTP, error) {
	o, e := normalOrigin(origin)
	if e != nil || !normalAPIKey.MatchString(key) {
		return nil, normalInvalid
	}
	t := &http.Transport{Proxy: nil, DialContext: (&net.Dialer{Timeout: normalRequestTimeout}).DialContext,
		DisableKeepAlives: true, DisableCompression: true, ForceAttemptHTTP2: false,
		MaxConnsPerHost: 1, MaxIdleConns: 0, ResponseHeaderTimeout: normalRequestTimeout,
		TLSHandshakeTimeout: normalRequestTimeout, MaxResponseHeaderBytes: 8192,
		TLSNextProto: map[string]func(string, *tls.Conn) http.RoundTripper{}}
	return &normalHTTP{o, key, &http.Client{Transport: t, Timeout: normalRequestTimeout, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}
func (h *normalHTTP) call(ctx context.Context, path string, body []byte, l *normalLease) (int, []byte, error) {
	if ctx.Err() != nil {
		return 0, nil, normalInvalid
	}
	method := "POST"
	ct := "application/json"
	if path == "/capabilities" {
		method = "GET"
		if len(body) != 0 || l != nil {
			return 0, nil, normalInvalid
		}
	} else if path == "/metrics" {
		ct = "application/x-protobuf"
		if l == nil || !l.valid() || int64(len(body)) != l.Bytes {
			return 0, nil, normalInvalid
		}
	} else if path != "/lease" && path != "/receipt" {
		return 0, nil, normalInvalid
	}
	if len(body) > 1048576 || (path != "/metrics" && len(body) > 1024) {
		return 0, nil, normalInvalid
	}
	ctx, cancel := context.WithTimeout(ctx, normalRequestTimeout)
	defer cancel()
	// NopCloser prevents automatic replay for POST bodies.
	req, e := http.NewRequestWithContext(ctx, method, h.origin+normalBackendPrefix+path, io.NopCloser(strings.NewReader(string(body))))
	if e != nil {
		return 0, nil, normalInvalid
	}
	req.ContentLength = int64(len(body))
	req.GetBody = nil
	if method == "GET" {
		req.Body = http.NoBody
	}
	req.Close = true
	req.Header.Set("DC-API-KEY", h.key)
	if method == "POST" {
		req.Header.Set("Content-Type", ct)
	}
	if path == "/metrics" {
		req.Header.Set("X-Monitoring-Batch-ID", l.ID)
		req.Header.Set("X-Monitoring-Delivery-Credential", l.Credential)
	}
	res, e := h.client.Do(req)
	if e != nil {
		if res != nil && res.Body != nil {
			res.Body.Close()
		}
		return 0, nil, normalInvalid
	}
	defer res.Body.Close()
	if res.StatusCode != 200 || !normalJSONContentType(res.Header) || !normalOneHeader(res.Header, "Cache-Control", "no-store") || len(res.Header.Values("Content-Encoding")) != 0 || res.ContentLength > normalResponseMax {
		return 0, nil, normalInvalid
	}
	raw, e := io.ReadAll(io.LimitReader(res.Body, normalResponseMax+1))
	if e != nil || len(raw) > normalResponseMax || (res.ContentLength >= 0 && int64(len(raw)) != res.ContentLength) || ctx.Err() != nil {
		return 0, nil, normalInvalid
	}
	return res.StatusCode, raw, nil
}
func normalOneHeader(h http.Header, k, v string) bool {
	x := h.Values(k)
	return len(x) == 1 && x[0] == v
}
func normalMarshal(x any) []byte { b, _ := json.Marshal(x); return b }
func normalKey(h http.Header, key string) bool {
	x := h.Values("DC-API-KEY")
	return len(x) == 1 && subtle.ConstantTimeCompare([]byte(x[0]), []byte(key)) == 1
}

// Express C emits application/json; charset=utf-8. Accept that exact optional
// parameter, not duplicate media headers, alternate encodings or arbitrary types.
func normalJSONContentType(h http.Header) bool {
	x := h.Values("Content-Type")
	if len(x) != 1 {
		return false
	}
	mt, p, e := mime.ParseMediaType(x[0])
	return e == nil && mt == "application/json" && (len(p) == 0 || (len(p) == 1 && strings.EqualFold(p["charset"], "utf-8")))
}
