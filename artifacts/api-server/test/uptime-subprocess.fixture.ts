// Runs in a child process with MONITORING_UPTIME_ALLOW_PRIVATE=true (test-only override) so the
// probe paths that need a live target can run against a disposable local server. Prints one
// JSON line: { name, result } entries. Exits non-zero if any assertion inside throws.
import http from "node:http";
import assert from "node:assert/strict";
import { probeUptime, checkUptimeUrl } from "../src/lib/uptime";

const server = http.createServer((req, res) => {
  const url = req.url ?? "/";
  if (url === "/ok") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  } else if (url === "/fail500") {
    res.writeHead(500);
    res.end("boom");
  } else if (url === "/redir") {
    res.writeHead(302, { location: "/ok" });
    res.end();
  } else if (url === "/loop") {
    res.writeHead(302, { location: "/loop" });
    res.end();
  } else if (url === "/redir-private") {
    res.writeHead(302, { location: "http://127.0.0.1:1/x" });
    res.end();
  } else if (url === "/credredir") {
    res.writeHead(302, { location: `http://user:pass@127.0.0.1:${port}/ok` });
    res.end();
  } else if (url === "/ftp") {
    res.writeHead(302, { location: "ftp://example.com/file" });
    res.end();
  } else if (url === "/hang") {
    // never responds; the probe's timeout must win
  } else {
    res.writeHead(404);
    res.end();
  }
});

await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as any).port;
const base = `http://127.0.0.1:${port}`;

const out: Record<string, unknown> = {};

let r = await probeUptime(`${base}/ok`, {});
assert.equal(r.ok, true);
assert.equal(r.status, 200);
assert.ok(r.durationMs >= 0);
out.ok200 = r;

r = await probeUptime(`${base}/ok`, { method: "HEAD" });
assert.equal(r.ok, true);
out.head = r;

r = await probeUptime(`${base}/fail500`, {});
assert.equal(r.ok, false);
assert.equal(r.status, 500);
assert.match(r.error ?? "", /outside expected/);
out.fail500 = r;

// A 500 counts as up when the expected range includes it.
r = await probeUptime(`${base}/fail500`, { expectMin: 200, expectMax: 599 });
assert.equal(r.ok, true);
out.customRange = r;

// One redirect hop is followed to the ok endpoint.
r = await probeUptime(`${base}/redir`, {});
assert.equal(r.ok, true);
assert.equal(r.status, 200);
assert.equal(r.redirects, 1);
out.redirect = r;

// A redirect loop exceeds the hop limit instead of chasing forever.
r = await probeUptime(`${base}/loop`, {});
assert.equal(r.ok, false);
assert.match(r.error ?? "", /too many redirects/);
assert.equal(r.redirects, 3);
out.redirectLoop = r;

// Every hop is re-validated: a redirect to a non-http scheme is refused, not followed.
r = await probeUptime(`${base}/ftp`, {});
assert.equal(r.ok, false);
assert.match(r.error ?? "", /redirect refused/);
out.redirectRefused = r;

// A redirect to a private target IS followed here (override set), proving the hop executes
// and lands on the redirect target - paired with the unit-level refusal of the same hop when
// the override is unset (test/uptime.test.ts nextHopUrl matrix).
r = await probeUptime(`${base}/redir-private`, {});
assert.equal(r.ok, false);
assert.equal(r.redirects, 1);
assert.match(r.error ?? "", /ECONNREFUSED/);
out.redirectPrivateFollowed = r;

// A redirect carrying credentials is refused at the hop even with the private override set.
r = await probeUptime(`${base}/credredir`, {});
assert.equal(r.ok, false);
assert.match(r.error ?? "", /redirect refused/);
out.redirectCredsRefused = r;

// A hanging server is bounded by the timeout.
r = await probeUptime(`${base}/hang`, { timeoutMs: 1000 });
assert.equal(r.ok, false);
assert.equal(r.error, "timeout");
assert.ok(r.durationMs < 5000, `timeout took ${r.durationMs}ms`);
out.timeout = r;

// An unreachable port reports the connection failure, not a crash.
r = await probeUptime("http://127.0.0.1:1/ok", {});
assert.equal(r.ok, false);
assert.match(r.error ?? "", /ECONNREFUSED/);
out.refused = r;

// checkUptimeUrl honours the test-only override: private literals pass when it is set.
assert.doesNotThrow(() => checkUptimeUrl("http://127.0.0.1:8080/"));

server.close();
console.log(JSON.stringify(out));
