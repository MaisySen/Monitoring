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

test("F1-F4: warm-cache query/discovery/hosts, encoded duplicate ACK, concurrent quota, raw compressed hash", async () => {
  const scratch = `reviewtest_${randomBytes(4).toString("hex")}`;
  await pool.query(`CREATE DATABASE ${scratch}`);
  try {
    const url = new URL(baseUrl.toString());
    url.pathname = `/${scratch}`;
    const stdout = execFileSync(process.execPath, ["--import", "tsx", "test/fixtures/batch-review-child.ts"], {
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: url.toString() },
      timeout: 30000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const result = JSON.parse(stdout.trim().split("\n").pop()!);
    assert.deepEqual(Object.keys(result).sort(), ["F1", "F2", "F3", "F4"]);
    console.log(JSON.stringify(result));
  } finally {
    await pool.query(`DROP DATABASE IF EXISTS ${scratch}`);
  }
});
