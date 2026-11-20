import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import crypto from "node:crypto";
import { pool } from "@workspace/db";
import { migrations } from "../src/lib/migrate";

// The multi-organization backfill (migration 4) must move every legacy single-org user
// (users.org_id/role set, no membership row) into org_memberships, verbatim from the
// shipped migration SQL against the real v1 schema.
//
// Requires DATABASE_URL pointing at a PostgreSQL where the user can create databases.

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

test("migration 4 backfills legacy single-org users into org_memberships", async () => {
  const scratch = `migtest_${crypto.randomBytes(4).toString("hex")}`;
  await pool.query(`CREATE DATABASE ${scratch}`);
  try {
    const dir = mkdtempSync(join(tmpdir(), "mig-"));
    const apply = (version: number) => {
      const f = join(dir, `m${version}.sql`);
      writeFileSync(f, migrations[version - 1]);
      psql(scratch, `\\i ${f}`);
    };
    // A pre-membership install: schema v1 only, one legacy admin and one legacy member in two orgs.
    apply(1);
    psql(
      scratch,
      `INSERT INTO orgs (name) VALUES ('Legacy One'), ('Legacy Two');
       INSERT INTO users (email, org_id, role) VALUES
         ('admin@legacy.test', (SELECT id FROM orgs WHERE name='Legacy One'), 'admin'),
         ('member@legacy.test', (SELECT id FROM orgs WHERE name='Legacy Two'), 'member'),
         ('pending@legacy.test', NULL, 'member');`,
    );
    apply(4);
    const rows = psql(
      scratch,
      `SELECT u.email, m.org_id, m.role FROM org_memberships m JOIN users u ON u.id = m.user_id ORDER BY u.email`,
    );
    assert.deepEqual(rows.split("\n"), [
      `admin@legacy.test|${psql(scratch, "SELECT id FROM orgs WHERE name='Legacy One'")}|admin`,
      `member@legacy.test|${psql(scratch, "SELECT id FROM orgs WHERE name='Legacy Two'")}|member`,
    ]);
    // Users without an org stay out; replaying the migration is a no-op (ON CONFLICT DO NOTHING).
    apply(4);
    assert.equal(psql(scratch, "SELECT count(*) FROM org_memberships"), "2");
  } finally {
    await pool.query(`DROP DATABASE IF EXISTS ${scratch}`);
  }
});
