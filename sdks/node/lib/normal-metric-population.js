"use strict";
// Pure producer population/instrument policy. No transport, state, or custody proof.
const { InstrumentType: I, AggregationTemporality: T, DataPointType: D } = require("@opentelemetry/sdk-metrics");
const LIMITS = { sourcePoints: 1000 };
const fail = () => {
  throw Error("Candidate response unavailable or incompatible");
};
function population(metrics) {
  const p = { sourcePoints: 0, numberPoints: 0, explicitHistogramPoints: 0, exponentialHistogramPoints: 0, cumulativeSnapshotPoints: 0 };
  for (const scope of metrics.scopeMetrics || [])
    for (const m of scope.metrics || []) {
      if (!Array.isArray(m.dataPoints)) fail();
      const n = m.dataPoints.length;
      p.sourcePoints += n;
      if (m.dataPointType === D.HISTOGRAM) p.explicitHistogramPoints += n;
      else if (m.dataPointType === D.EXPONENTIAL_HISTOGRAM) p.exponentialHistogramPoints += n;
      else if (m.dataPointType === D.GAUGE || m.dataPointType === D.SUM) {
        p.numberPoints += n;
        if (m.dataPointType === D.SUM && m.aggregationTemporality === T.CUMULATIVE) {
          if (m.isMonotonic !== false) fail();
          p.cumulativeSnapshotPoints += n;
        }
      } else fail();
    }
  if (p.sourcePoints > LIMITS.sourcePoints) fail();
  return p;
}
function selectAggregationTemporality(type) {
  if ([I.UP_DOWN_COUNTER, I.OBSERVABLE_UP_DOWN_COUNTER].includes(type)) return T.CUMULATIVE;
  if ([I.COUNTER, I.OBSERVABLE_COUNTER, I.GAUGE, I.HISTOGRAM, I.OBSERVABLE_GAUGE].includes(type)) return T.DELTA;
  throw Error("Unsupported candidate instrument");
}
module.exports = { population, selectAggregationTemporality };
