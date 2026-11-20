'use strict';
// Shared settings for the benchmark scripts. Everything comes from the environment; nothing is read from fixed paths.
//   MONITORING_URL       Monitoring base URL (default http://localhost:3000)
//   MONITORING_EMAIL     a Monitoring login used to read results back (required by scripts that use the UI API)
//   MONITORING_PASSWORD  its password (or MONITORING_PASSWORD_FILE)
//   MONITORING_API_KEY   an API key for intake
//   DATABASE_URL    Monitoring's Postgres database, for the scripts that count stored rows directly
//   BENCH_DEPS      where bench/setup.sh installed the tracers and apps (default bench/.deps)
const fs = require('fs');
const path = require('path');

function need(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Set ${name} (see bench/lib/env.js)`);
    process.exit(2);
  }
  return v;
}
const url = () => (process.env.MONITORING_URL || 'http://localhost:3000').replace(/\/$/, '');
const email = () => need('MONITORING_EMAIL');
const password = () => process.env.MONITORING_PASSWORD || (process.env.MONITORING_PASSWORD_FILE ? fs.readFileSync(process.env.MONITORING_PASSWORD_FILE, 'utf8').trim() : need('MONITORING_PASSWORD'));
const apiKey = () => need('MONITORING_API_KEY');
const databaseUrl = () => need('DATABASE_URL');
const deps = () => process.env.BENCH_DEPS || path.join(__dirname, '..', '.deps');
const repo = path.join(__dirname, '..', '..');

module.exports = { need, url, email, password, apiKey, databaseUrl, deps, repo };
