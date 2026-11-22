// Private candidate service. Explicit TEST profile, never a production policy.
import { Pool } from "@workspace/db";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { lockExactActiveApiKey } from "./exactApiKey";
import { preflightRawAppMetrics, RAW_APP_TEST_LIMITS, RAW_APP_SUBSET, RawAppError } from "./rawAppMetrics";
import { prepareNormalAppMetrics, NORMAL_APP_CONTRACT, NormalAppShapeError } from "./normalAppContract";
import { decodeOtlp } from "../intake/otlp";
import { writeMetricPointsOnTransaction, TransactionMetricRefusal } from "../intake/transactionMetrics";
export const CANDIDATE_PREFIX = "/otlp/candidate/node-app/v1";
export const CANDIDATE_PROTOCOL = "monitoring-node-app-service-test-v1";
export const CANDIDATE_TEST = Object.freeze({
  admissionMs: 30000,
  receiptGraceMs: 30000,
  dataCalls: 2,
  controlCalls: 4,
  bufferedBytes: 2097152,
  bodyMs: 1000,
  controlBytes: 1024,
  activeLeases: 20,
  issuesPerMinute: 10,
  cleanupBatch: 10,
});
export function candidateConfig(env = process.env) {
  if (env.MONITORING_NODE_APP_CANDIDATE === undefined || env.MONITORING_NODE_APP_CANDIDATE === "off") return null;
  if (env.MONITORING_NODE_APP_CANDIDATE !== "test-v1" || (env.MONITORING_STORAGE ?? "postgres") !== "postgres")
    throw Error("Invalid candidate TEST configuration");
  return CANDIDATE_TEST;
}
export class CandidateError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
const refuse = (status: number, code: string): never => {
  throw new CandidateError(status, code);
};
// Last-resort sink only when release throws before restoring pool ownership.
// It captures no transaction/request data and never retries a broken release.
const discardedClientError = () => {};
const digest = (s: Buffer | string) => createHash("sha256").update(s).digest("hex");
const schema = `
create table candidate_app_schema(id int primary key check(id=1),version int not null);
insert into candidate_app_schema values(1,1);
create table candidate_app_clock(id int primary key check(id=1),floor_ms bigint not null);
insert into candidate_app_clock values(1,0);
create table candidate_app_issues(org_id int not null,minute bigint not null,n int not null,primary key(org_id,minute));
create table candidate_app_leases(id text primary key,org_id int not null,key_id int not null,sha text not null,bytes int not null,credential_sha text not null,contract text not null,until_ms bigint not null,receipt_until_ms bigint not null);
create index candidate_app_expiry on candidate_app_leases(receipt_until_ms,id);
create index candidate_app_org on candidate_app_leases(org_id);
create table candidate_app_receipts(id text primary key references candidate_app_leases(id),accounting jsonb not null,durability text not null);
`;
// Explicit scratch-only install. Never called by request, ordinary migrate or startup.
export async function installCandidateScratchSchema(c: any) {
  if (!candidateConfig() || !(await c.query("select current_database() name")).rows[0].name.startsWith("candidate_"))
    throw Error("Candidate installation requires isolated candidate_ scratch DB");
  await c.query("begin");
  try {
    await c.query(schema);
    await c.query("commit");
  } catch (e) {
    await c.query("rollback");
    throw e;
  }
}
export class CandidateService {
  private data = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 6,
    connectionTimeoutMillis: 500,
    allowExitOnIdle: true,
    options: "-c statement_timeout=3000 -c lock_timeout=1000 -c idle_in_transaction_session_timeout=5000",
  });
  private clockPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 500,
    allowExitOnIdle: true,
    options: "-c synchronous_commit=on -c statement_timeout=2000 -c lock_timeout=500",
  });
  constructor() {
    if (!candidateConfig()) throw Error("Candidate disabled");
    this.data.on("error", () => {});
    this.clockPool.on("error", () => {});
  }
  async close() {
    await Promise.all([this.data.end(), this.clockPool.end()]);
  }
  private async settings(c: any) {
    const r = (await c.query("select current_setting('synchronous_commit') s,current_setting('fsync') f,current_setting('full_page_writes') p")).rows[0];
    if (r.s !== "on" || r.f !== "on" || r.p !== "on") refuse(503, "unavailable");
  }
  private async tx<T>(fn: (c: any) => Promise<T>, clock = false): Promise<T> {
    const c = await (clock ? this.clockPool : this.data).connect();
    let committing = false,
      discard = false,
      connectionFailed = false;
    // pg-pool removes its idle Client error listener while checked out.
    // Keep our nonthrowing listener until release restores pool ownership.
    const onError = () => {
      connectionFailed = true;
      discard = true;
    };
    const checkConnection = () => {
      if (connectionFailed) throw new CandidateError(503, committing ? "unconfirmed" : "unavailable");
    };
    c.on("error", onError);
    try {
      await c.query("begin;set local synchronous_commit=on");
      checkConnection();
      await this.settings(c);
      checkConnection();
      const r = await fn(c);
      checkConnection();
      committing = true;
      await c.query("commit");
      checkConnection();
      return r;
    } catch (e) {
      if (committing) {
        discard = true;
        throw new CandidateError(503, "unconfirmed");
      }
      if (!connectionFailed) {
        try {
          await c.query("rollback");
        } catch {
          discard = true;
        }
      }
      checkConnection();
      throw e;
    } finally {
      let releaseFailed = false;
      try {
        c.release(discard);
        // A synchronous release event can observe a connection failure too.
        checkConnection();
      } catch {
        releaseFailed = true;
        throw new CandidateError(503, committing ? "unconfirmed" : "unavailable");
      } finally {
        c.off("error", onError);
        if (releaseFailed && c.listenerCount("error") === 0) c.on("error", discardedClientError);
      }
    }
  }
  async ready() {
    return this.tx(async (c) => {
      const r = (await c.query("select version from candidate_app_schema where id=1")).rows;
      if (r.length !== 1 || r[0].version !== 1) refuse(503, "unavailable");
      await c.query(
        "select l.id,l.org_id,l.key_id,l.sha,l.bytes,l.credential_sha,l.contract,l.until_ms,l.receipt_until_ms,r.accounting,r.durability from candidate_app_leases l left join candidate_app_receipts r on r.id=l.id limit 0",
      );
      await c.query("select floor_ms from candidate_app_clock where id=1");
      await c.query("select org_id,minute,n from candidate_app_issues limit 0");
    });
  }
  private async clock() {
    return this.tx(async (c) => {
      const row = (
        await c.query("select floor_ms,floor(extract(epoch from clock_timestamp())*1000)::bigint now from candidate_app_clock where id=1 for update")
      ).rows[0];
      if (!row || Number(row.now) < Number(row.floor_ms)) refuse(503, "unavailable");
      const now = Number(row.now);
      if (!Number.isSafeInteger(now)) refuse(503, "unavailable");
      await c.query("update candidate_app_clock set floor_ms=$1 where id=1", [now]);
      return now;
    }, true);
  }
  async preflight(key: string) {
    return this.tx(async (c) => {
      const r = await lockExactActiveApiKey(c, key);
      if (!r) refuse(403, "forbidden");
      return r!;
    });
  }
  async capabilities(key: string) {
    await this.preflight(key);
    await this.ready();
    await this.clock();
    return {
      protocol: CANDIDATE_PROTOCOL,
      testOnly: true,
      profile: "test-v1",
      storage: "postgres",
      rawSubset: RAW_APP_SUBSET,
      representation: NORMAL_APP_CONTRACT,
      accountingVersion: 1,
      compression: "none",
      exactIssuingKeyOnly: true,
      lastUsedAtAccounting: false,
      localSpool: false,
      receiptOnClockUnavailable: "refuse-unavailable",
      limits: RAW_APP_TEST_LIMITS,
      perWorker: CANDIDATE_TEST,
      durability: "same-tx-synchronous-commit",
      supported: ["delta-sum", "gauge", "delta-explicit-histogram", "delta-exponential-histogram", "nonmonotonic-cumulative-snapshot"],
      omitted: ["exemplars-refused", "unknown-fields-refused", "raw-buckets-not-retained", "absent-distribution-no-quantiles"],
    };
  }
  async cleanup() {
    const now = await this.clock();
    await this.tx(async (c) => {
      const rows = (
        await c.query("select id from candidate_app_leases where receipt_until_ms<$1 order by id limit $2 for update skip locked", [
          now,
          CANDIDATE_TEST.cleanupBatch,
        ])
      ).rows;
      for (const r of rows) {
        await c.query("delete from candidate_app_receipts where id=$1", [r.id]);
        await c.query("delete from candidate_app_leases where id=$1", [r.id]);
      }
      // Rate rows are bounded by observed issuance and expiry, independent of telemetry.
      await c.query(
        "delete from candidate_app_issues where (org_id,minute) in (select org_id,minute from candidate_app_issues where minute<$1 order by org_id,minute limit $2 for update skip locked)",
        [Math.floor(now / 60000) - 1, CANDIDATE_TEST.cleanupBatch],
      );
    });
  }
  async issue(key: string, input: any) {
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).sort().join(",") !== "bytes,contract,sha" ||
      typeof input.sha !== "string" ||
      !/^[a-f0-9]{64}$/.test(input.sha) ||
      !Number.isSafeInteger(input.bytes) ||
      input.bytes < 0 ||
      input.bytes > RAW_APP_TEST_LIMITS.bytes ||
      input.contract !== NORMAL_APP_CONTRACT
    )
      refuse(400, "invalid");
    await this.ready();
    await this.cleanup();
    return this.tx(async (c) => {
      const who = await lockExactActiveApiKey(c, key);
      if (!who) refuse(403, "forbidden");
      await c.query("select pg_advisory_xact_lock($1,$2)", [193620, who!.orgId]);
      const now = await this.clock();
      if (Number((await c.query("select count(*) n from candidate_app_leases where org_id=$1", [who!.orgId])).rows[0].n) >= CANDIDATE_TEST.activeLeases)
        refuse(429, "backpressure");
      const rate = await c.query(
        "insert into candidate_app_issues values($1,$2,1) on conflict(org_id,minute) do update set n=candidate_app_issues.n+1 where candidate_app_issues.n<$3 returning n",
        [who!.orgId, Math.floor(now / 60000), CANDIDATE_TEST.issuesPerMinute],
      );
      if (!rate.rowCount) refuse(429, "backpressure");
      const id = randomBytes(16).toString("hex"),
        credential = randomBytes(32).toString("hex");
      const until = now + CANDIDATE_TEST.admissionMs,
        receiptUntil = until + CANDIDATE_TEST.receiptGraceMs;
      await c.query("insert into candidate_app_leases values($1,$2,$3,$4,$5,$6,$7,$8,$9)", [
        id,
        who!.orgId,
        who!.id,
        input.sha,
        input.bytes,
        digest(credential),
        input.contract,
        until,
        receiptUntil,
      ]);
      if ((await this.clock()) >= until) refuse(503, "unavailable");
      return { protocol: CANDIDATE_PROTOCOL, id, credential, until, receiptUntil, sha: input.sha, bytes: input.bytes, contract: input.contract };
    });
  }
  private async owner(c: any, key: string, id: string, credential: string) {
    if (!/^[a-f0-9]{32}$/.test(id) || !/^[a-f0-9]{64}$/.test(credential)) refuse(403, "forbidden");
    const who = await lockExactActiveApiKey(c, key);
    if (!who) refuse(403, "forbidden");
    const l = (await c.query("select * from candidate_app_leases where id=$1 and org_id=$2 and key_id=$3 for update", [id, who!.orgId, who!.id])).rows[0];
    if (!l || !timingSafeEqual(Buffer.from(digest(credential)), Buffer.from(l.credential_sha))) refuse(403, "forbidden");
    if (l.contract !== NORMAL_APP_CONTRACT) refuse(503, "unavailable");
    return l;
  }
  private saved(row: any, l: any) {
    const a = row.accounting;
    const keys = [
      "sourcePoints",
      "numberPoints",
      "explicitHistogramPoints",
      "exponentialHistogramPoints",
      "omittedEmptyHistogramPoints",
      "derivedRows",
      "absentSumHistogramPoints",
      "absentDistributionHistogramPoints",
      "cumulativeSnapshotPoints",
    ];
    if (
      a?.contract !== NORMAL_APP_CONTRACT ||
      Object.keys(a).sort().join(",") !== [...keys, "contract"].sort().join(",") ||
      keys.some((k) => !Number.isSafeInteger(a[k]) || a[k] < 0) ||
      a.sourcePoints > RAW_APP_TEST_LIMITS.sourcePoints ||
      a.derivedRows > RAW_APP_TEST_LIMITS.derivedRowsUpperBound ||
      a.sourcePoints !== a.numberPoints + a.explicitHistogramPoints + a.exponentialHistogramPoints ||
      a.cumulativeSnapshotPoints > a.numberPoints ||
      ["omittedEmptyHistogramPoints", "absentSumHistogramPoints", "absentDistributionHistogramPoints"].some(
        (k) => a[k] > a.explicitHistogramPoints + a.exponentialHistogramPoints,
      ) ||
      row.durability !== "same-tx-synchronous-commit"
    )
      refuse(503, "unavailable");
    return { state: "stored", protocol: CANDIDATE_PROTOCOL, id: l.id, sha: l.sha, bytes: l.bytes, accounting: a, durability: row.durability };
  }
  async receipt(key: string, id: string, credential: string) {
    await this.ready();
    return this.tx(async (c) => {
      const l = await this.owner(c, key, id, credential),
        now = await this.clock();
      const row = (await c.query("select accounting,durability from candidate_app_receipts where id=$1", [id])).rows[0];
      if (now > Number(l.receipt_until_ms)) return { state: "unknown", id };
      return row ? this.saved(row, l) : { state: now >= Number(l.until_ms) ? "expired-unconfirmed" : "unconfirmed", id };
    });
  }
  async accept(key: string, id: string, credential: string, bytes: Buffer) {
    await this.ready();
    return this.tx(async (c) => {
      const l = await this.owner(c, key, id, credential);
      if (l.bytes !== bytes.length || l.sha !== digest(bytes)) refuse(409, "conflict");
      const row = (await c.query("select accounting,durability from candidate_app_receipts where id=$1", [id])).rows[0],
        now = await this.clock();
      if (now > Number(l.receipt_until_ms)) refuse(410, "unknown");
      if (row) return this.saved(row, l);
      if (now >= Number(l.until_ms)) refuse(410, "expired-unconfirmed");
      preflightRawAppMetrics(bytes);
      const prepared = prepareNormalAppMetrics(l.org_id, decodeOtlp("metrics", bytes, "application/x-protobuf"));
      const r = await writeMetricPointsOnTransaction(c, l.org_id, prepared.conversion.points, {
        originalBytes: bytes.length,
        nowSeconds: Math.floor(now / 1000),
        maxDerivedRows: RAW_APP_TEST_LIMITS.derivedRowsUpperBound,
        hostInfo: prepared.conversion.hosts,
      });
      if (r.derivedRows !== prepared.accounting.derivedRows) refuse(503, "unavailable");
      const saved = this.saved({ accounting: prepared.accounting, durability: "same-tx-synchronous-commit" }, l);
      await c.query("insert into candidate_app_receipts values($1,$2,'same-tx-synchronous-commit')", [id, JSON.stringify(prepared.accounting)]);
      if ((await this.clock()) >= Number(l.until_ms)) refuse(410, "expired-unconfirmed");
      return saved;
    });
  }
}
export function candidateFailure(e: unknown) {
  if (e instanceof CandidateError) return { status: e.status, code: e.code };
  if (e instanceof RawAppError)
    return { status: e.code === "limit" ? 413 : e.code === "malformed" ? 400 : 422, code: e.code === "malformed" ? "invalid" : "unsupported" };
  if (e instanceof NormalAppShapeError) return { status: 422, code: "unsupported" };
  if (e instanceof TransactionMetricRefusal) return { status: 429, code: "backpressure" };
  return { status: 503, code: "unavailable" };
}
