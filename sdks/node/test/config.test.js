'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { config, tags } = require('../config');
test('agent defaults and migration attributes', () => {
  const c = config({}, { DD_SERVICE: 'legacy', DD_ENV: 'qa', DD_VERSION: '2', DD_TAGS: 'team:core' });
  assert.equal(c.endpoint('traces'), 'http://localhost:4318/v1/traces');
  assert.equal(c.attributes['service.name'], 'legacy');
  assert.equal(c.attributes['deployment.environment'], 'qa');
  assert.equal(c.attributes['service.version'], '2');
  assert.equal(c.attributes.team, 'core');
  assert.equal(c.attributes['telemetry.distro.name'], 'monitoring');
});
test('agentless auth and explicit configuration precedence', () => {
  const c = config({ service: 'direct' }, {
    MONITORING_URL: 'https://example.test/', MONITORING_API_KEY: 'test-only',
    MONITORING_SERVICE: 'native', OTEL_SERVICE_NAME: 'otel', DD_SERVICE: 'legacy',
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://ignored',
  });
  assert.equal(c.attributes['service.name'], 'direct');
  assert.equal(c.endpoint('traces'), 'https://example.test/otlp/v1/traces');
  assert.equal(c.headers['DC-API-KEY'], 'test-only');
});
test('OTel configuration and disabled injection', () => {
  const c = config({}, {
    OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318/',
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'http://logs/v1/logs',
    OTEL_RESOURCE_ATTRIBUTES: 'service.name=otel,service.version=3,deployment.environment=dev,team=core',
    MONITORING_LOGS_INJECTION: 'false',
  });
  assert.equal(c.endpoint('metrics'), 'http://collector:4318/v1/metrics');
  assert.equal(c.endpoint('logs'), 'http://logs/v1/logs');
  assert.equal(c.attributes['service.name'], 'otel');
  assert.equal(c.logsInjection, false);
});
test('tags preserve colons in values', () => {
  assert.deepEqual(tags(['a:b:c', 'enabled']), { a: 'b:c', enabled: true });
  assert.deepEqual(tags({ count: 2 }), { count: 2 });
});
test('invalid configuration fails explicitly', () => {
  assert.throws(() => config({}, { MONITORING_URL: 'https://example.test' }), /API_KEY/);
  assert.throws(() => config({}, { MONITORING_SAMPLE_RATE: '2' }), /between/);
  assert.throws(() => config({}, { MONITORING_SAMPLE_RATE: 'no' }), /between/);
});
