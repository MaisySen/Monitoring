"use strict";
// Separate protocol. Never use candidate-direct stored receipt as custody proof.
const PROTOCOL = "monitoring-node-app-custody-test-v1";
const CONTRACT = "node-app-representation-v2-candidate";
const RECOVERY = "receipt-only-no-data-resend";
const DURABILITY = "same-tx-synchronous-commit";
const PREFIX = "/monitoring/candidate/node-app-custody/v1";
const CONTROL_BYTES = 65536,
  STATUS_BYTES = 262144;
const fail = () => {
  throw Error("Normal custody unavailable or incompatible");
};
const id = (x) => typeof x === "string" && /^[a-f0-9]{32}$/.test(x);
const sha = (x) => typeof x === "string" && /^[a-f0-9]{64}$/.test(x);
const integer = (x) => Number.isSafeInteger(x) && x >= 0;
function exact(v, keys) {
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).sort().join(",") !== [...keys].sort().join(",")) fail();
}
// Duplicate keys (including escaped equivalents) and unsafe numbers must not be
// lost by JSON.parse. Scan full grammar before decoding; bound depth and bytes.
function parse(raw, max = CONTROL_BYTES) {
  if (!Buffer.isBuffer(raw) || ![CONTROL_BYTES, STATUS_BYTES].includes(max) || !raw.length || raw.length > max) fail();
  let s;
  try {
    s = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    fail();
  }
  let i = 0;
  const ws = () => {
    while (/[\x20\x09\x0a\x0d]/.test(s[i] || "!")) i++;
  };
  const string = () => {
    const start = i;
    if (s[i++] !== '"') fail();
    while (i < s.length) {
      if (s[i] === '"') {
        i++;
        try {
          return JSON.parse(s.slice(start, i));
        } catch {
          fail();
        }
      }
      if (s[i] === "\\") i++;
      i++;
    }
    fail();
  };
  const value = (depth) => {
    if (depth > 16) fail();
    ws();
    const c = s[i];
    if (c === "{") {
      i++;
      ws();
      const keys = new Set();
      if (s[i] === "}") {
        i++;
        return;
      }
      for (;;) {
        ws();
        const k = string();
        if (keys.has(k)) fail();
        keys.add(k);
        ws();
        if (s[i++] !== ":") fail();
        value(depth + 1);
        ws();
        if (s[i] === "}") {
          i++;
          return;
        }
        if (s[i++] !== ",") fail();
      }
    }
    if (c === "[") {
      i++;
      ws();
      if (s[i] === "]") {
        i++;
        return;
      }
      for (;;) {
        value(depth + 1);
        ws();
        if (s[i] === "]") {
          i++;
          return;
        }
        if (s[i++] !== ",") fail();
      }
    }
    if (c === '"') {
      string();
      return;
    }
    for (const t of ["true", "false", "null"])
      if (s.startsWith(t, i)) {
        i += t.length;
        return;
      }
    const m = s.slice(i).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!m) fail();
    const n = Number(m[0]);
    if (!Number.isSafeInteger(n)) fail();
    i += m[0].length;
  };
  value(0);
  ws();
  if (i !== s.length) fail();
  try {
    return JSON.parse(s);
  } catch {
    fail();
  }
}
function destination(raw) {
  if (typeof raw !== "string" || !/^https?:\/\//.test(raw) || raw.includes("?") || raw.includes("#")) fail();
  let u;
  try {
    u = new URL(raw);
  } catch {
    fail();
  }
  if (u.username || u.password || u.pathname !== "/" || !["127.0.0.1", "[::1]"].includes(u.hostname)) fail();
  // No alternate spelling accepted as a loopback identity (octal, abbreviated,
  // numeric, hostname, encoded host or normalized dot-path).
  const authority = raw.slice(raw.indexOf("://") + 3).replace(/\/$/, "");
  if (!/^(?:127\.0\.0\.1|\[::1\])(?::[1-9][0-9]{0,4})?$/.test(authority)) fail();
  return u.origin;
}
function capability(v) {
  const expected = {
    protocol: PROTOCOL,
    testOnly: true,
    profile: "test-v1",
    representation: CONTRACT,
    inputMs: 30000,
    custodyRetentionMs: 300000,
    inputReceiptTotalMs: 330000,
    maxEntries: 128,
    maxPayloadBytes: 16777216,
    maxJournalFileBytes: 134217728,
    maxInputBytes: 1048576,
    agentJournal: true,
    sdkLocalSpool: false,
    custodyIsBackendStored: false,
    recoveryMode: RECOVERY,
    exclusiveModeRequired: true,
  };
  exact(v, [...Object.keys(expected), "epoch", "dataClockAvailable"]);
  for (const k of Object.keys(expected)) if (v[k] !== expected[k]) fail();
  if (!id(v.epoch) || typeof v.dataClockAvailable !== "boolean") fail();
  return v;
}
const POP = ["sourcePoints", "numberPoints", "explicitHistogramPoints", "exponentialHistogramPoints", "cumulativeSnapshotPoints"];
const ACC = [...POP, "omittedEmptyHistogramPoints", "derivedRows", "absentSumHistogramPoints", "absentDistributionHistogramPoints"];
function accounting(a, p) {
  exact(a, ["contract", ...ACC]);
  if (
    a.contract !== CONTRACT ||
    ACC.some((k) => !integer(a[k])) ||
    a.sourcePoints > 1000 ||
    a.derivedRows > 8000 ||
    a.sourcePoints !== a.numberPoints + a.explicitHistogramPoints + a.exponentialHistogramPoints ||
    a.cumulativeSnapshotPoints > a.numberPoints
  )
    fail();
  const h = a.explicitHistogramPoints + a.exponentialHistogramPoints;
  if (
    a.omittedEmptyHistogramPoints > h ||
    a.absentSumHistogramPoints > h ||
    a.absentDistributionHistogramPoints > h ||
    a.derivedRows < a.numberPoints ||
    a.derivedRows > a.numberPoints + 8 * (h - a.omittedEmptyHistogramPoints)
  )
    fail();
  if (p && POP.some((k) => a[k] !== p[k])) fail();
  return a;
}
const INPUT = [
  "protocol",
  "epoch",
  "id",
  "sha",
  "bytes",
  "contract",
  "state",
  "custody",
  "backendStored",
  "inputUntil",
  "retainUntil",
  "backendId",
  "backendUntil",
  "backendReceiptUntil",
  "accounting",
  "durability",
  "reasonCode",
  "recoveryMode",
];
function input(v, r, lease = false) {
  exact(v, INPUT);
  if (
    v.protocol !== PROTOCOL ||
    v.contract !== CONTRACT ||
    v.recoveryMode !== RECOVERY ||
    !id(v.id) ||
    !id(v.epoch) ||
    !sha(v.sha) ||
    v.sha !== r.sha ||
    v.bytes !== r.length ||
    !integer(v.bytes) ||
    v.bytes < 1 ||
    v.bytes > 1048576 ||
    v.epoch !== r.epoch ||
    typeof v.custody !== "boolean" ||
    typeof v.backendStored !== "boolean" ||
    !integer(v.inputUntil) ||
    v.inputUntil < 30001 ||
    !integer(v.retainUntil) ||
    v.retainUntil - v.inputUntil !== 300000 ||
    typeof v.reasonCode !== "string" ||
    !/^[a-z0-9-]{0,64}$/.test(v.reasonCode)
  )
    fail();
  if (r.id && (v.id !== r.id || v.inputUntil !== r.inputUntil || v.retainUntil !== r.retainUntil)) fail();
  const backend = v.backendId !== null;
  if (backend) {
    if (
      !id(v.backendId) ||
      !integer(v.backendUntil) ||
      v.backendUntil < 1 ||
      !integer(v.backendReceiptUntil) ||
      v.backendReceiptUntil - v.backendUntil !== 30000
    )
      fail();
  } else if (v.backendUntil !== null || v.backendReceiptUntil !== null) fail();
  if (r.backendId && (v.backendId !== r.backendId || v.backendUntil !== r.backendUntil || v.backendReceiptUntil !== r.backendReceiptUntil)) fail();
  if (lease && (v.state !== "issued" || v.custody || v.backendStored || backend)) fail();
  if (v.state === "issued") {
    if (v.custody || v.backendStored || backend) fail();
  } else if (v.state === "custody" || v.state === "blocked") {
    if (!v.custody || v.backendStored) fail();
  } else if (v.state === "expired-unconfirmed") {
    if (v.custody || v.backendStored) fail();
  } else if (v.state === "stored") {
    if (v.custody || !v.backendStored || !backend || v.durability !== DURABILITY) fail();
    accounting(v.accounting, r.population);
  } else fail();
  if (v.state !== "stored" && (v.accounting !== null || v.durability !== null)) fail();

  return v;
}
// Distinct bounded diagnostic reader. Not accepted as per-input ACK/receipt.
function status(v) {
  exact(v, ["protocol", "epoch", "observedAt", "sweptAt", "persistedSnapshotNotLiveEligibility", "status"]);
  if (
    v.protocol !== PROTOCOL ||
    !id(v.epoch) ||
    !integer(v.observedAt) ||
    v.observedAt < 1 ||
    v.sweptAt !== v.observedAt ||
    v.persistedSnapshotNotLiveEligibility !== true
  )
    fail();
  const s = v.status;
  exact(s, ["entries", "stored", "refused", "unconfirmed", "firstUntil", "lastUntil", "payloadBytes", "journalBytes"]);
  for (const k of ["stored", "refused", "unconfirmed", "firstUntil", "lastUntil", "payloadBytes", "journalBytes"]) if (!integer(s[k])) fail();
  if (s.firstUntil > s.lastUntil || s.payloadBytes > 16777216 || s.journalBytes > 134217728 || !Array.isArray(s.entries) || s.entries.length > 128) fail();
  const seen = new Set();
  let total = 0;
  for (const x of s.entries) {
    exact(x, [
      "id",
      "epoch",
      "state",
      "custody",
      "backendStored",
      "receiptOnly",
      "inputUntil",
      "retainUntil",
      "retainedBytes",
      "backendId",
      "backendUntil",
      "backendReceiptUntil",
      "dataAttempts",
      "receiptAttempts",
      "leaseAttempts",
      "accounting",
    ]);
    if (
      !id(x.id) ||
      seen.has(x.id) ||
      x.epoch !== v.epoch ||
      typeof x.receiptOnly !== "boolean" ||
      typeof x.custody !== "boolean" ||
      typeof x.backendStored !== "boolean" ||
      !["issued", "custody", "blocked", "expired-unconfirmed", "stored"].includes(x.state)
    )
      fail();
    seen.add(x.id);
    for (const k of ["inputUntil", "retainUntil", "retainedBytes", "backendUntil", "backendReceiptUntil", "dataAttempts", "receiptAttempts", "leaseAttempts"])
      if (!integer(x[k])) fail();
    if (
      x.retainUntil - x.inputUntil !== 300000 ||
      x.retainedBytes > 1048576 ||
      x.dataAttempts > 3 ||
      x.receiptAttempts > 6 ||
      x.leaseAttempts > 2 ||
      x.custody !== x.retainedBytes > 0 ||
      x.backendStored !== (x.state === "stored") ||
      (["issued", "stored", "expired-unconfirmed"].includes(x.state) && x.custody) ||
      (["custody", "blocked"].includes(x.state) && !x.custody)
    )
      fail();
    if (
      x.inputUntil < 30001 ||
      (x.state === "issued" && (x.backendId !== "" || x.dataAttempts || x.receiptAttempts || x.leaseAttempts)) ||
      ((x.dataAttempts || x.receiptAttempts) && (!id(x.backendId) || !x.leaseAttempts)) ||
      (x.receiptAttempts && !x.dataAttempts)
    )
      fail();
    if (x.backendId === "") {
      if (x.backendUntil !== 0 || x.backendReceiptUntil !== 0 || x.dataAttempts || x.receiptAttempts) fail();
    } else if (!id(x.backendId) || x.backendReceiptUntil - x.backendUntil !== 30000 || x.backendUntil < 1) fail();
    if (x.state === "stored") {
      if (!id(x.backendId) || !x.dataAttempts) fail();
      accounting(x.accounting);
    } else if (x.accounting !== null) fail();
    total += x.retainedBytes;
  }
  if (total !== s.payloadBytes) fail();
  return v;
}
module.exports = {
  PROTOCOL,
  CONTRACT,
  RECOVERY,
  DURABILITY,
  PREFIX,
  CONTROL_BYTES,
  STATUS_BYTES,
  parse,
  exact,
  capability,
  input,
  status,
  accounting,
  destination,
  fail,
};
