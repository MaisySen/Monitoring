import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { checkUptimeUrl, probeUptime } from "../src/lib/uptime";

// With the test-only override unset, uptime targets must obey the SSRF rules: http(s) only,
// no credentials, no private/loopback/link-local/reserved addresses, no local hostnames.
test("checkUptimeUrl accepts a plain public http(s) URL", () => {
  assert.equal(checkUptimeUrl("https://example.com/health").hostname, "example.com");
  assert.equal(checkUptimeUrl("http://status.example.org:8080/ping").port, "8080");
});

test("checkUptimeUrl rejects non-http(s) schemes", () => {
  for (const u of ["ftp://example.com", "file:///etc/passwd", "gopher://x"]) assert.throws(() => checkUptimeUrl(u), /http\(s\)/);
  assert.throws(() => checkUptimeUrl("not a url"), /valid http\(s\) URL/);
});

test("checkUptimeUrl rejects credentials in the URL", () => {
  assert.throws(() => checkUptimeUrl("http://user:pass@example.com/"), /[Cc]redentials/);
});

test("checkUptimeUrl rejects private, loopback and link-local address literals", () => {
  for (const u of [
    "http://127.0.0.1/",
    "http://127.1.2.3/",
    "http://10.0.0.5/",
    "http://192.168.1.10/",
    "http://172.16.0.1/",
    "http://169.254.169.254/latest/meta-data",
    "http://100.64.0.1/",
    "http://0.0.0.0/",
    "http://[::1]/",
    "http://[fe80::1]/",
    "http://[fc00::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[64:ff9b::7f00:1]/",
  ])
    assert.throws(() => checkUptimeUrl(u), /private or local/, u);
});

test("checkUptimeUrl rejects local hostnames", () => {
  for (const u of ["http://localhost/", "http://api.localhost/", "http://printer.local/", "http://db.internal/"])
    assert.throws(() => checkUptimeUrl(u), /private or local/, u);
});

test("probeUptime refuses a loopback target while the override is unset", async () => {
  // Negative control: even a live local server must not be probed without the test-only flag.
  const server = http.createServer((_req, res) => {
    res.writeHead(200);
    res.end("ok");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const port = (server.address() as any).port;
    await assert.rejects(() => probeUptime(`http://127.0.0.1:${port}/`, {}), /private or local/);
    await assert.rejects(() => probeUptime(`http://localhost:${port}/`, {}), /private or local/);
  } finally {
    server.close();
  }
});

test("probe paths against a live disposable target (child process with the test-only override)", () => {
  // The allow-private override is read at module load, so the allowed-path checks run in a
  // fresh process where MONITORING_UPTIME_ALLOW_PRIVATE=1 is set explicitly and only there.
  const out = execFileSync("node", ["--import", "tsx", "test/uptime-subprocess.fixture.ts"], {
    env: { ...process.env, MONITORING_UPTIME_ALLOW_PRIVATE: "true" },
    encoding: "utf8",
    timeout: 30_000,
  });
  const results = JSON.parse(out.trim().split("\n").pop()!);
  assert.equal(results.ok200.ok, true);
  assert.equal(results.redirect.redirects, 1);
  assert.equal(results.redirectLoop.redirects, 3);
  assert.equal(results.timeout.error, "timeout");
});

// Regression: the probe loop's state update must actually land. A first version of
// runUptimeCheck referenced $2..$7 while passing $1 too, and PostgreSQL refused the whole
// statement ("could not determine data type of parameter $1") - results were recorded but
// consecutive_failures never moved, so a dead target would never surface as a problem.
// Caught only by watching a live loop; pinned here against the real schema.
test("runUptimeCheck records the result and increments consecutive_failures", async () => {
  const { pool } = await import("@workspace/db");
  const { migrations } = await import("../src/lib/migrate");
  const { runUptimeCheck } = await import("../src/jobs/uptime");
  // Apply just migration 15 (uptime tables) to the test database; idempotent by design.
  await pool.query(migrations[14]);
  const ins = await pool.query(
    `insert into uptime_checks (org_id, name, url, method, interval_s, timeout_ms, expect_status_min, expect_status_max, enabled, created_at)
     values (0, 'test-dead', 'http://127.0.0.1:1/', 'GET', 30, 1000, 200, 399, true, $1) returning id`,
    [Date.now()],
  );
  const id = Number(ins.rows[0].id);
  try {
    await runUptimeCheck({ id, org_id: 0, url: "http://127.0.0.1:1/", method: "GET", timeout_ms: 1000, expect_status_min: 200, expect_status_max: 399 });
    let row = (await pool.query("select consecutive_failures, last_ok, last_error from uptime_checks where id=$1", [id])).rows[0];
    assert.equal(row.consecutive_failures, 1);
    assert.equal(row.last_ok, false);
    assert.ok(row.last_error, "last_error recorded");
    await runUptimeCheck({ id, org_id: 0, url: "http://127.0.0.1:1/", method: "GET", timeout_ms: 1000, expect_status_min: 200, expect_status_max: 399 });
    row = (await pool.query("select consecutive_failures from uptime_checks where id=$1", [id])).rows[0];
    assert.equal(row.consecutive_failures, 2);
    const results = await pool.query("select ok, error from uptime_results where check_id=$1 order by ts", [id]);
    assert.equal(results.rows.length, 2);
    assert.ok(results.rows.every((r: any) => r.ok === false && r.error));
  } finally {
    await pool.query("delete from uptime_results where check_id=$1", [id]);
    await pool.query("delete from uptime_checks where id=$1", [id]);
  }
});

// SSRF claims as tested controls (parent review 2026-11-21): redirect-to-private refusal,
// DNS-rebinding/mixed-address refusal, and validated-addresses-are-connected (the same
// lookup that validates backs the socket - see makeSafeLookup in lib/safeHttp.ts).
import { firstBlockedAddress, makeSafeLookup } from "../src/lib/safeHttp";
import { nextHopUrl, RateLimiter } from "../src/lib/uptime";

test("redirect hops are re-validated: private targets and credentials are refused", () => {
  const base = new URL("https://example.com/a");
  assert.throws(() => nextHopUrl("http://169.254.169.254/latest/meta-data", base), /private or local/);
  assert.throws(() => nextHopUrl("http://10.1.2.3/", base), /private or local/);
  assert.throws(() => nextHopUrl("http://[::1]/", base), /private or local/);
  assert.throws(() => nextHopUrl("//127.0.0.1:9000/", base), /private or local/); // scheme-relative
  assert.throws(() => nextHopUrl("http://user:pass@example.com/", base), /[Cc]redentials/);
  assert.throws(() => nextHopUrl("ftp://example.com/", base), /http\(s\)/);
  assert.equal(nextHopUrl("/health", base).toString(), "https://example.com/health");
  assert.equal(nextHopUrl("https://status.example.com/", base).hostname, "status.example.com");
});

test("mixed resolution results are refused: any blocked address blocks the hostname", () => {
  // DNS rebinding / round-robin mixes: a hostname is only probed when EVERY resolved address
  // is clean. The lookup performing this check is the one passed to the HTTP request, so the
  // validated addresses are the only addresses the socket can connect to (no re-resolution).
  assert.equal(firstBlockedAddress(["8.8.8.8", "10.0.0.1"]), "10.0.0.1");
  assert.equal(firstBlockedAddress(["1.1.1.1", "169.254.169.254"]), "169.254.169.254");
  assert.equal(firstBlockedAddress(["2606:4700:4700::1111", "::1"]), "::1");
  assert.equal(firstBlockedAddress(["8.8.8.8", "::ffff:127.0.0.1"]), "::ffff:127.0.0.1"); // IPv4-mapped
  assert.equal(firstBlockedAddress(["8.8.8.8", "64:ff9b::7f00:1"]), "64:ff9b::7f00:1"); // NAT64 well-known
  assert.equal(firstBlockedAddress(["8.8.8.8", "1.1.1.1"]), null);
  // The live lookup object the probes use refuses through the same path.
  const lookup = makeSafeLookup(false);
  lookup("localhost", {}, (err: any) => assert.equal(err?.code, "EBLOCKED"));
});

test("manual-run rate limiter: fixed window per key", () => {
  const rl = new RateLimiter(3, 60_000);
  const t0 = 1_000_000;
  assert.equal(rl.allow("org:1", t0), true);
  assert.equal(rl.allow("org:1", t0 + 1000), true);
  assert.equal(rl.allow("org:2", t0 + 1000), true); // independent keys
  assert.equal(rl.allow("org:1", t0 + 2000), true);
  assert.equal(rl.allow("org:1", t0 + 3000), false); // 4th within the window
  assert.equal(rl.allow("org:1", t0 + 61_000), true); // window slid
});

// This worker owns the pool; do not keep Node alive for the idle-client timeout.
after(async () => {
  const { pool } = await import("@workspace/db");
  await pool.end();
});
