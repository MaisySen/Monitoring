'use strict';
// Lean incoming-HTTP tracing built on Node's diagnostics_channel,
// replacing the server side of @opentelemetry/instrumentation-http. One OpenTelemetry SERVER span
// per request with W3C context propagation, the stable HTTP semantic-convention attributes, the
// framework route (filled in by the express/koa/etc. instrumentations through RPC metadata) and an
// ERROR status for 5xx. It avoids patching http.Server.emit and binding every request/response
// event emitter to the context, which is where most of the stock instrumentation's per-request
// CPU goes. Outgoing requests stay with the OpenTelemetry http/undici instrumentations.
const dc = require('node:diagnostics_channel');
const api = require('@opentelemetry/api');
const { setRPCMetadata, RPCType, isTracingSuppressed } = require('@opentelemetry/core');

const SERVER = api.SpanKind.SERVER;
let installed = false;

function install({ contextManager, ignorePaths = [] }) {
  if (installed) return;
  const als = contextManager && contextManager._asyncLocalStorage;
  if (!als || typeof als.enterWith !== 'function') return false; // fall back to the stock instrumentation
  installed = true;
  const tracer = api.trace.getTracer('@monitoring/trace/http-server', '0.1.0');
  const ignore = new Set(ignorePaths);

  dc.subscribe('http.server.request.start', ({ request, response }) => {
    const parent = api.propagation.extract(api.ROOT_CONTEXT, request.headers);
    if (isTracingSuppressed(parent)) return;
    const url = request.url || '/';
    const q = url.indexOf('?');
    const path = q === -1 ? url : url.slice(0, q);
    if (ignore.size && ignore.has(path)) return;
    const method = request.method || 'GET';
    const headers = request.headers;
    const attributes = {
      'http.request.method': method,
      'url.path': path,
      'url.scheme': request.socket && request.socket.encrypted ? 'https' : 'http',
      'network.protocol.version': request.httpVersion,
    };
    if (q !== -1) attributes['url.query'] = url.slice(q + 1);
    if (headers.host) attributes['server.address'] = headers.host;
    if (headers['user-agent']) attributes['user_agent.original'] = headers['user-agent'];
    const peer = request.socket && request.socket.remoteAddress;
    if (peer) attributes['client.address'] = peer;
    const span = tracer.startSpan(method, { kind: SERVER, attributes }, parent);
    const rpc = { type: RPCType.HTTP, span };
    // Enter the request's context for the rest of this tick (the 'request' event is emitted
    // synchronously right after this channel fires) and every async continuation it creates.
    als.enterWith(setRPCMetadata(api.trace.setSpan(parent, span), rpc));
    response.once('close', () => {
      const status = response.statusCode;
      span.setAttribute('http.response.status_code', status);
      if (rpc.route) {
        span.setAttribute('http.route', rpc.route);
        span.updateName(`${method} ${rpc.route}`);
      }
      if (status >= 500) span.setStatus({ code: api.SpanStatusCode.ERROR });
      if (!response.writableFinished) span.setAttribute('http.aborted', true);
      span.end();
    });
  });
  return true;
}

module.exports = { install };
