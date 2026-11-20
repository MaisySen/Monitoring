"""Fast OTLP/HTTP protobuf span exporter.

Encodes ExportTraceServiceRequest bytes directly instead of building protobuf message objects
span by span (what opentelemetry-exporter-otlp-proto-http does). Resource and scope encodings,
attribute keys and frequently repeated (key, value) attribute pairs are cached, so a batch is
encoded with a few bytes joins per span. This keeps the export thread's hold on the GIL short,
which is what shows up as tail latency in instrumented apps. Wire output is standard OTLP.
"""
from __future__ import annotations

import gzip
import http.client
import logging
import struct
import threading
from typing import Dict, Optional, Sequence
import os
import random
import time
from urllib.parse import urlparse

from opentelemetry.sdk.trace.export import SpanExporter, SpanExportResult

_log = logging.getLogger(__name__)
_pack_q = struct.Struct("<Q").pack
_pack_d = struct.Struct("<d").pack


def _varint(n: int) -> bytes:
    if n < 0:
        n += 1 << 64
    if n < 0x80:
        return bytes((n,))
    out = bytearray()
    while n > 0x7F:
        out.append((n & 0x7F) | 0x80)
        n >>= 7
    out.append(n)
    return bytes(out)


_SMALL = [bytes((i,)) for i in range(128)]


def _len(n: int) -> bytes:
    return _SMALL[n] if n < 128 else _varint(n)


def _ld(tag: bytes, payload: bytes) -> bytes:
    return tag + _len(len(payload)) + payload


def _str_field(tag: bytes, s: str) -> bytes:
    b = s.encode("utf-8")
    return tag + _len(len(b)) + b


def _any_value(v) -> bytes:
    if isinstance(v, str):
        return _str_field(b"\x0a", v)
    if isinstance(v, bool):
        return b"\x10\x01" if v else b"\x10\x00"
    if isinstance(v, int):
        return b"\x18" + _varint(v)
    if isinstance(v, float):
        return b"\x21" + _pack_d(v)
    if isinstance(v, (bytes, bytearray)):
        return _ld(b"\x3a", bytes(v))
    if isinstance(v, (list, tuple)):
        return _ld(b"\x2a", b"".join(_ld(b"\x0a", _any_value(x)) for x in v if x is not None))
    return _str_field(b"\x0a", str(v))


_key_cache: Dict[str, bytes] = {}
_pair_cache: Dict[tuple, bytes] = {}


def _kv(key: str, value) -> bytes:
    """Encoded KeyValue (without the outer field tag/length)."""
    cacheable = isinstance(value, str) and len(value) <= 64 or isinstance(value, (bool, int)) and not isinstance(value, float)
    if cacheable:
        ck = (key, type(value), value)
        hit = _pair_cache.get(ck)
        if hit is not None:
            return hit
    kb = _key_cache.get(key)
    if kb is None:
        kb = _str_field(b"\x0a", key)
        if len(_key_cache) < 4096:
            _key_cache[key] = kb
    out = kb + _ld(b"\x12", _any_value(value))
    if cacheable and len(_pair_cache) < 16384:
        _pair_cache[ck] = out
    return out


def _attrs(tag: bytes, attributes) -> bytes:
    if not attributes:
        return b""
    parts = []
    for k, v in attributes.items():
        if v is None:
            continue
        kv = _kv(k, v)
        parts.append(tag + _len(len(kv)) + kv)
    return b"".join(parts)


_resource_cache: Dict[int, tuple] = {}
_scope_cache: Dict[tuple, bytes] = {}


def _resource(resource) -> bytes:
    hit = _resource_cache.get(id(resource))
    if hit is not None and hit[0] is resource:
        return hit[1]
    enc = _ld(b"\x0a", _attrs(b"\x0a", resource.attributes))  # ResourceSpans.resource
    _resource_cache[id(resource)] = (resource, enc)
    return enc


def _scope(scope) -> bytes:
    key = (scope.name if scope else "", scope.version if scope else None)
    hit = _scope_cache.get(key)
    if hit is None:
        body = _str_field(b"\x0a", key[0] or "")
        if key[1]:
            body += _str_field(b"\x12", key[1])
        hit = _ld(b"\x0a", body)  # ScopeSpans.scope
        _scope_cache[key] = hit
    return hit


def _span(span) -> bytes:
    ctx = span.context
    parts = [b"\x0a\x10", ctx.trace_id.to_bytes(16, "big"), b"\x12\x08", ctx.span_id.to_bytes(8, "big")]
    ts = ctx.trace_state
    if ts:
        parts.append(_str_field(b"\x1a", ts.to_header()))
    parent = span.parent
    if parent is not None:
        parts.append(b"\x22\x08")
        parts.append(parent.span_id.to_bytes(8, "big"))
    parts.append(_str_field(b"\x2a", span.name))
    parts.append(b"\x30" + _SMALL[span.kind.value + 1])
    parts.append(b"\x39" + _pack_q(span.start_time or 0))
    parts.append(b"\x41" + _pack_q(span.end_time or 0))
    parts.append(_attrs(b"\x4a", span.attributes))
    dropped = getattr(span, "dropped_attributes", 0)
    if dropped:
        parts.append(b"\x50" + _varint(dropped))
    for ev in span.events or ():
        parts.append(_ld(b"\x5a", b"\x09" + _pack_q(ev.timestamp) + _str_field(b"\x12", ev.name) + _attrs(b"\x1a", ev.attributes)))
    for link in span.links or ():
        lc = link.context
        lflags = b"\x35" + (b"\x00\x03\x00\x00" if lc.is_remote else b"\x00\x01\x00\x00")
        parts.append(_ld(b"\x6a", b"\x0a\x10" + lc.trace_id.to_bytes(16, "big") + b"\x12\x08" + lc.span_id.to_bytes(8, "big") + _attrs(b"\x22", link.attributes) + lflags))
    st = span.status
    code = st.status_code.value if st is not None else 0
    if code or (st is not None and st.description):
        body = (_str_field(b"\x12", st.description) if st.description else b"") + (b"\x18" + _SMALL[code] if code else b"")
        parts.append(_ld(b"\x7a", body))
    # flags (field 16, fixed32): 0x100 = "is_remote known", 0x200 = parent context is remote
    parts.append(b"\x85\x01" + (b"\x00\x03\x00\x00" if parent is not None and parent.is_remote else b"\x00\x01\x00\x00"))
    return b"".join(parts)


_YIELD_EVERY = int(os.environ.get("MONITORING_EXPORT_YIELD_EVERY", "32"))


def encode_spans(spans: Sequence) -> bytes:
    groups: Dict[int, tuple] = {}
    for s in spans:
        r = s.resource
        g = groups.get(id(r))
        if g is None:
            g = groups[id(r)] = (r, {})
        scope = s.instrumentation_scope
        key = (scope.name, scope.version) if scope else ("", None)
        g[1].setdefault(key, (scope, []))[1].append(s)
    out = []
    n = 0
    for resource, scopes in groups.values():
        rs = [_resource(resource)]
        for scope, items in scopes.values():
            encoded = []
            for s in items:
                encoded.append(_ld(b"\x12", _span(s)))
                n += 1
                # Encoding runs in the export thread while request threads wait for the GIL. Yield it every
                # _YIELD_EVERY spans so a large batch never stalls requests for the whole encode (tail latency);
                # the output, flush interval and batch size are unchanged.
                if _YIELD_EVERY and n % _YIELD_EVERY == 0:
                    time.sleep(0)
            body = _scope(scope) + b"".join(encoded)
            rs.append(_ld(b"\x12", body))
        out.append(_ld(b"\x0a", b"".join(rs)))
    return b"".join(out)


_RETRYABLE_STATUS = {408, 429, 502, 503, 504}


class MonitoringSpanExporter(SpanExporter):
    def __init__(self, endpoint: str, headers: Optional[Dict[str, str]] = None, timeout: float = 10.0, compression: Optional[str] = None):
        u = urlparse(endpoint)
        self._https = u.scheme == "https"
        self._host = u.hostname
        self._port = u.port or (443 if self._https else 80)
        self._path = (u.path or "/v1/traces") + (f"?{u.query}" if u.query else "")
        self._headers = {"Content-Type": "application/x-protobuf", **(headers or {})}
        self._gzip = compression == "gzip"
        if self._gzip:
            self._headers["Content-Encoding"] = "gzip"
        self._timeout = timeout
        self._conn = None
        self._lock = threading.Lock()
        self._shutdown = False
        self._retry_seconds = float(os.environ.get("MONITORING_EXPORT_RETRY_SECONDS", "30"))

    def _connection(self):
        if self._conn is None:
            cls = http.client.HTTPSConnection if self._https else http.client.HTTPConnection
            self._conn = cls(self._host, self._port, timeout=self._timeout)
        return self._conn

    def export(self, spans) -> SpanExportResult:
        if self._shutdown:
            return SpanExportResult.FAILURE
        try:
            body = encode_spans(spans)
        except Exception:  # never break the app because of telemetry
            _log.exception("Monitoring: failed to encode spans")
            return SpanExportResult.FAILURE
        if self._gzip:
            body = gzip.compress(body, 1)
        # The agent restarting or a brief network failure must not drop the batch: retry network errors and
        # 408/429/502/503/504 with exponential backoff (0.25 s .. 5 s, honouring Retry-After) for up to
        # MONITORING_EXPORT_RETRY_SECONDS (default 30). Retries stop once the exporter is shutting down.
        deadline = time.monotonic() + self._retry_seconds
        attempt = 0
        with self._lock:
            while True:
                retry_after = 0.0
                try:
                    conn = self._connection()
                    conn.request("POST", self._path, body=body, headers=self._headers)
                    resp = conn.getresponse()
                    resp.read()
                    if 200 <= resp.status < 300:
                        return SpanExportResult.SUCCESS
                    if resp.status not in _RETRYABLE_STATUS:
                        _log.warning("Monitoring: span export failed: HTTP %s", resp.status)
                        return SpanExportResult.FAILURE
                    try:
                        retry_after = float(resp.getheader("Retry-After") or 0)
                    except ValueError:
                        retry_after = 0.0
                    error = f"HTTP {resp.status}"
                except (http.client.HTTPException, OSError) as e:
                    if self._conn is not None:
                        self._conn.close()
                    self._conn = None
                    error = str(e)
                    if attempt == 0:  # a stale keep-alive connection: reconnect immediately once
                        attempt += 1
                        continue
                delay = max(retry_after, min(5.0, 0.25 * 2 ** attempt)) * random.uniform(0.8, 1.2)
                attempt += 1
                if self._shutdown or time.monotonic() + delay > deadline:
                    _log.warning("Monitoring: span export failed after %d attempts: %s", attempt, error)
                    return SpanExportResult.FAILURE
                time.sleep(delay)

    def force_flush(self, timeout_millis: int = 30000) -> bool:
        return True

    def shutdown(self) -> None:
        self._shutdown = True
        with self._lock:
            if self._conn is not None:
                self._conn.close()
                self._conn = None
