"use strict";
// Pure selection/configuration source. No transport or SDK startup here.
const { destination, fail } = require("./normal-custody-wire");
function selectNormalCustody(options = {}, env = process.env) {
  const gate = env.MONITORING_NODE_APP_CUSTODY;
  const barrier=env.MONITORING_NODE_APP_CUSTODY_SHUTDOWN;
  if(barrier!==undefined && !["off","observe-stored-test-v1"].includes(barrier))fail();
  if(barrier==="observe-stored-test-v1" && gate!=="test-v1")fail();
  if (gate !== undefined && !["off", "test-v1"].includes(gate)) fail();
  if (gate !== "test-v1") return { normalCustodyTest: false };
  if (
    (env.MONITORING_NODE_APP_CANDIDATE !== undefined && env.MONITORING_NODE_APP_CANDIDATE !== "off") ||
    env.MONITORING_METRIC_CUSTODY_TEST_ONLY === "yes" ||
    env.MONITORING_METRIC_DIRECT_TEST_ONLY === "yes" ||
    (env.MONITORING_METRICS_RETRY !== undefined && env.MONITORING_METRICS_RETRY !== "false")
  )
    fail();
  // Generic MONITORING/OTEL/agent endpoints never choose this destination/key.
  const origin = destination(env.MONITORING_NODE_APP_CUSTODY_URL);
  const key = options.apiKey || env.MONITORING_API_KEY;
  if (typeof key !== "string" || !/^[a-fA-F0-9]{32,64}$/.test(key)) fail();
  return { normalCustodyTest: true, normalCustodyUrl: origin, normalCustodyKey: key, normalCustodyShutdown:barrier==="observe-stored-test-v1" };
}
// Exactly one factory is invoked. Exceptions propagate, never fallback. Existing
// routes remain in a lazy unchanged closure when custody is not explicitly set.
function selectMetricExporter(config, normal, existing) {
  if (!config.normalCustodyTest) return existing();
  if (config.candidateAppTest || config.metricCustodyTest || config.metricDirectTest) fail();
  return normal(config.normalCustodyUrl, config.normalCustodyKey);
}
module.exports = { selectNormalCustody, selectMetricExporter };
