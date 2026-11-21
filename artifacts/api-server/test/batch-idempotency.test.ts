import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { pool } from "@workspace/db";

// Metrics intake batch idempotency (x-monitoring-batch-id; migration 20).
// Requires DATABASE_URL pointing at a PostgreSQL where the user can create databases.
// The worker child binds its own pool to the scratch database; this parent asserts the child's
// reported outcomes and cross-checks stored rows directly (positive stored-value assertions).

const baseUrl = new URL(process.env.DATABASE_URL!);

function psql(db: string, sql: string): string {
  return execFileSync("psql", ["-X", "-v", "ON_ERROR_STOP=1", "-tA", "-d", db, "-c", sql], {
    encoding: "utf8",
    env: {
      ...process.env,
      PGHOST: baseUrl.hostname,
      PGPORT: baseUrl.port || "5432",
      PGUSER: decodeURIComponent(baseUrl.username),
      PGPASSWORD: decodeURIComponent(baseUrl.password),
    },
  }).trim();
}

test("metrics batch idempotency: dedup, conflict, org isolation, concurrency, rollback, expiry", async () => {
  const scratch = `idemtest_${randomBytes(4).toString("hex")}`;
  await pool.query(`CREATE DATABASE ${scratch}`);
  try {
    psql(scratch, `CREATE TABLE orgs (id serial PRIMARY KEY, name text);
                   INSERT INTO orgs (name) VALUES ('A'), ('B');`);
    const scratchUrl = new URL(baseUrl.toString());
    scratchUrl.pathname = `/${scratch}`;
    const stdout = execFileSync(process.execPath, ["--import", "tsx", "test/fixtures/batch-idem-child.ts"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: scratchUrl.toString(), IDEM_ORG_A: "1", IDEM_ORG_B: "2" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out = JSON.parse(stdout.trim().split("\n").pop()!);

    assert.equal(typeof out.first, "number", "first delivery ingests");
    assert.equal(out.retry, "duplicate", "exact retry dedups");
    assert.equal(out.conflict, true, "same id with different content conflicts");
    assert.equal(typeof out.distinct, "number", "distinct batch with identical points ingests");
    assert.equal(typeof out.otherOrg, "number", "same batch id in another org ingests (org isolation)");
    const dupes = out.concurrent.filter((r: unknown) => r === "duplicate").length;
    const ingested = out.concurrent.filter((r: unknown) => typeof r === "number").length;
    assert.equal(ingested, 1, "concurrent same-batch: exactly one ingests");
    assert.equal(dupes, 2, "concurrent same-batch: the other two dedup");
    assert.equal(out.rollbackThrew, true, "forced mid-ingest failure surfaces");
    assert.equal(out.rollbackClaimRows, 0, "failed ingest leaves no claim row");
    assert.equal(out.rollbackPoints, 0, "failed ingest leaves no points");
    assert.equal(typeof out.retryAfterRollback, "number", "retry after rollback re-ingests");
    assert.equal(out.retryAfterRollbackPoints, 1, "retry after rollback stores the points");
    assert.ok(out.swept >= 1, "sweep removes expired claim rows");
    // stored-value cross-check straight from the database:
    // run:a (orgA) + run:a (distinct batch) + run:a (orgB) + run:c (once) + run:rb (after rollback) = 5
    assert.equal(
      psql(scratch, "SELECT count(*) FROM metric_points mp JOIN metric_series ms ON ms.id=mp.series_id WHERE ms.metric='idem.t'"),
      "5",
      "exactly five points stored across all cases (no duplicates, none lost)",
    );
  } finally {
    await pool.query(`DROP DATABASE IF EXISTS ${scratch}`);
  }
});
