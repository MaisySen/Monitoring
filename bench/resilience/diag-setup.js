'use strict';
// Preload (-r) BEFORE @monitoring/trace/init in debug repro runs (GEN_DEBUG_DIAG=1): stock OTel
// exporters report failures through the diag API, which is silent unless a logger is attached.
const path = require('path');
const deps = process.env.BENCH_DEPS || path.join(__dirname, '..', '.deps');
const { diag, DiagConsoleLogger, DiagLogLevel } = require(path.join(deps, 'node', 'node_modules', '@opentelemetry', 'api'));
diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
