import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;
export { Pool };

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set. Did you forget to provision a database?");
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DATABASE_POOL_SIZE ?? 20),
  // Startup options apply BEFORE checkout. An async connect-event SET races the
  // first caller query and causes pg's busy-client deprecation warning.
  options: (process.env.MONITORING_SYNCHRONOUS_COMMIT ?? "off") === "on" ? undefined : "-c synchronous_commit=off",
});

// A database restart or network break kills idle pool clients, and pg emits that as an 'error' event on
// the pool itself. Without a listener the event is an uncaught exception and the whole process dies,
// turning a seconds-long database blip into a full server outage. Log it and let the pool recover:
// in-flight queries already fail individually and surface as retriable 503s at intake.
pool.on("error", (err) => {
  console.error("postgres pool client error (connection dropped; pool will recover):", err.message);
});

// Telemetry writes don't need to wait for each commit to reach disk: with asynchronous commit a
// crash can lose the last fraction of a second of writes but never corrupts data, and intake no
// longer serializes on WAL flushes. MONITORING_SYNCHRONOUS_COMMIT=on restores the Postgres default.
export const db = drizzle(pool, { schema });

export * from "./schema";
