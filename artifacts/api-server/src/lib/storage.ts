/**
 * Telemetry storage backend, chosen at install time with MONITORING_STORAGE:
 *   postgres    (default) spans, logs and metrics live in the same Postgres database as app data
 *   clickhouse  spans, logs, metrics and APM rollups live in ClickHouse (MONITORING_CLICKHOUSE_URL); app data stays in Postgres
 * Switching an existing install does not move data that is already stored.
 */
const raw = (process.env.MONITORING_STORAGE ?? "postgres").trim().toLowerCase();
if (raw !== "postgres" && raw !== "clickhouse") throw new Error(`MONITORING_STORAGE must be "postgres" or "clickhouse" (got "${raw}")`);
export const storage: "postgres" | "clickhouse" = raw;
export const useClickHouse = storage === "clickhouse";
