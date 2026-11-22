// Shared DELTA histogram distribution admission. No measurements, conversion or DB state.
// Explicit empty/empty is the OTLP scalar-only shape. Exponential has no such
// scalar-only exception: positive+negative+zero population must account for count.
export type HistogramDistribution = { state: "available" | "absent" | "invalid"; reason?: string };
const numericInteger = (v: unknown): number | null => {
  if (typeof v === "string" && /^(0|[1-9][0-9]*)$/.test(v)) v = Number(v);
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
};
const signed = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v);
export function deltaHistogramDistribution(dp: any, exponential: boolean): HistogramDistribution {
  const invalid = (reason: string): HistogramDistribution => ({ state: "invalid", reason });
  const count = numericInteger(dp.count === undefined ? 0 : dp.count);
  if (count === null) return invalid("Invalid histogram population");
  let counts: number[] = [];
  if (!exponential) {
    const bounds = dp.explicitBounds === undefined ? [] : dp.explicitBounds, buckets = dp.bucketCounts === undefined ? [] : dp.bucketCounts;
    if (!Array.isArray(bounds) || !Array.isArray(buckets)) return invalid("Invalid explicit bucket arrays");
    if (!bounds.length && !buckets.length) return { state: "absent" };
    if (buckets.length !== bounds.length + 1) return invalid("Histogram bucket layout mismatch");
    if (bounds.some((v: any, i: number) => typeof v !== "number" || !Number.isFinite(v) || (i > 0 && v <= bounds[i - 1])))
      return invalid("Histogram boundaries must be finite and increase");
    for (const v of buckets) { const n = numericInteger(v); if (n === null) return invalid("Invalid bucket population"); counts.push(n); }
  } else {
    const scale = dp.scale === undefined ? 0 : dp.scale;
    if (!signed(scale)) return invalid("Invalid exponential scale");
    if (dp.zeroThreshold !== undefined && (typeof dp.zeroThreshold !== "number" || dp.zeroThreshold !== 0))
      return invalid("Nonzero histogram zero threshold unsupported");
    const zero = numericInteger(dp.zeroCount === undefined ? 0 : dp.zeroCount);
    if (zero === null) return invalid("Invalid zero population");
    counts = [zero];
    const base = Math.pow(2, Math.pow(2, -scale));
    for (const side of [dp.negative, dp.positive]) if (side !== undefined) {
      if (!side || typeof side !== "object" || Array.isArray(side) || !signed(side.offset === undefined ? 0 : side.offset) || !Array.isArray(side.bucketCounts === undefined ? [] : side.bucketCounts))
        return invalid("Invalid exponential bucket range");
      const buckets = side.bucketCounts === undefined ? [] : side.bucketCounts, offset = side.offset === undefined ? 0 : side.offset;
      let previous: number | undefined;
      for (let i = 0; i < buckets.length; i++) {
        const n = numericInteger(buckets[i]);
        if (n === null) return invalid("Invalid exponential bucket population");
        counts.push(n);
        const lo = Math.pow(base, offset + i), hi = Math.pow(base, offset + i + 1);
        if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo <= 0 || hi <= lo || (previous !== undefined && lo < previous))
          return invalid("Exponential boundaries overflow or collapse");
        previous = hi;
      }
    }
  }
  if (counts.reduce((sum, n) => sum + BigInt(n), 0n) !== BigInt(count)) return invalid("Histogram bucket total mismatch");
  return { state: "available" };
}
