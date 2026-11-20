import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set. Did you forget to provision a database?");
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: Number(process.env.DATABASE_POOL_SIZE ?? 20) });

// Telemetry writes don't need to wait for each commit to reach disk: with asynchronous commit a
// crash can lose the last fraction of a second of writes but never corrupts data, and intake no
// longer serializes on WAL flushes. MONITORING_SYNCHRONOUS_COMMIT=on restores the Postgres default.
if ((process.env.MONITORING_SYNCHRONOUS_COMMIT ?? "off") !== "on") {
  pool.on("connect", (client) => {
    client.query("SET synchronous_commit TO off").catch(() => {});
  });
}
export const db = drizzle(pool, { schema });

export * from "./schema";
