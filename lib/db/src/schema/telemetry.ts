import { pgTable, serial, text, timestamp, integer, bigint, doublePrecision, jsonb, index, uniqueIndex, bigserial, varchar } from "drizzle-orm/pg-core";

export const metricSeriesTable = pgTable(
  "metric_series",
  {
    id: serial("id").primaryKey(),
    orgId: integer("org_id").notNull(),
    metric: text("metric").notNull(),
    host: text("host").notNull().default(""),
    tags: text("tags").array().notNull().default([]),
    tagsKey: text("tags_key").notNull(),
    type: text("type").notNull().default("gauge"),
    unit: text("unit"),
    lastSeen: bigint("last_seen", { mode: "number" }).notNull().default(0),
  },
  (t) => [uniqueIndex("metric_series_uniq").on(t.orgId, t.metric, t.host, t.tagsKey), index("metric_series_metric").on(t.orgId, t.metric)],
);

export const metricPointsTable = pgTable(
  "metric_points",
  {
    seriesId: integer("series_id").notNull(),
    ts: bigint("ts", { mode: "number" }).notNull(), // unix seconds
    value: doublePrecision("value").notNull(),
  },
  (t) => [index("metric_points_series_ts").on(t.seriesId, t.ts)],
);

export const hostsTable = pgTable(
  "hosts",
  {
    id: serial("id").primaryKey(),
    orgId: integer("org_id").notNull(),
    name: text("name").notNull(),
    os: text("os"),
    platform: text("platform"),
    agentVersion: text("agent_version"),
    tags: text("tags").array().notNull().default([]),
    apps: text("apps").array().notNull().default([]),
    meta: jsonb("meta").notNull().default({}),
    firstSeen: bigint("first_seen", { mode: "number" }).notNull(),
    lastSeen: bigint("last_seen", { mode: "number" }).notNull(),
  },
  (t) => [uniqueIndex("hosts_uniq").on(t.orgId, t.name)],
);

export const logsTable = pgTable(
  "logs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: integer("org_id").notNull(),
    ts: bigint("ts", { mode: "number" }).notNull(), // unix ms
    status: text("status").notNull().default("info"),
    service: text("service").notNull().default(""),
    host: text("host").notNull().default(""),
    source: text("source").notNull().default(""),
    message: text("message").notNull().default(""),
    tags: text("tags").array().notNull().default([]),
    attributes: jsonb("attributes").notNull().default({}),
    traceId: text("trace_id"),
  },
  (t) => [index("logs_org_ts").on(t.orgId, t.ts), index("logs_trace").on(t.orgId, t.traceId)],
);

export const spansTable = pgTable(
  "spans",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: integer("org_id").notNull(),
    traceId: text("trace_id").notNull(),
    spanId: text("span_id").notNull(),
    parentId: text("parent_id").notNull().default("0"),
    service: text("service").notNull(),
    name: text("name").notNull(),
    resource: text("resource").notNull(),
    type: text("type").notNull().default(""),
    env: text("env").notNull().default(""),
    host: text("host").notNull().default(""),
    start: bigint("start", { mode: "number" }).notNull(), // unix ns (fits in double to ~us)
    startMs: bigint("start_ms", { mode: "number" }).notNull(),
    duration: bigint("duration", { mode: "number" }).notNull(), // ns
    error: integer("error").notNull().default(0),
    isTopLevel: integer("is_top_level").notNull().default(0),
    meta: jsonb("meta").notNull().default({}),
    metrics: jsonb("metrics").notNull().default({}),
  },
  (t) => [
    index("spans_org_start").on(t.orgId, t.startMs),
    index("spans_trace").on(t.orgId, t.traceId),
    index("spans_service").on(t.orgId, t.service, t.startMs),
  ],
);

export const dashboardsTable = pgTable("dashboards", {
  id: varchar("id", { length: 16 }).primaryKey(),
  orgId: integer("org_id").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  layoutType: text("layout_type").notNull().default("ordered"),
  definition: jsonb("definition").notNull(),
  authorId: varchar("author_id"),
  authorName: text("author_name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  modifiedAt: timestamp("modified_at", { withTimezone: true }).notNull().defaultNow(),
});

export const monitorsTable = pgTable("monitors", {
  id: serial("id").primaryKey(),
  orgId: integer("org_id").notNull(),
  name: text("name").notNull(),
  type: text("type").notNull().default("metric alert"),
  query: text("query").notNull(),
  message: text("message").notNull().default(""),
  tags: text("tags").array().notNull().default([]),
  priority: integer("priority"),
  options: jsonb("options").notNull().default({}),
  overallState: text("overall_state").notNull().default("No Data"),
  groupStates: jsonb("group_states").notNull().default({}),
  mutedUntil: bigint("muted_until", { mode: "number" }),
  lastTriggeredAt: bigint("last_triggered_at", { mode: "number" }),
  lastEvaluatedAt: bigint("last_evaluated_at", { mode: "number" }),
  creatorId: varchar("creator_id"),
  creatorName: text("creator_name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  modifiedAt: timestamp("modified_at", { withTimezone: true }).notNull().defaultNow(),
});

export const eventsTable = pgTable(
  "events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: integer("org_id").notNull(),
    ts: bigint("ts", { mode: "number" }).notNull(), // unix ms
    title: text("title").notNull(),
    text: text("text").notNull().default(""),
    alertType: text("alert_type").notNull().default("info"),
    source: text("source").notNull().default("monitoring"),
    monitorId: integer("monitor_id"),
    groupKey: text("group_key"),
    tags: text("tags").array().notNull().default([]),
  },
  (t) => [index("events_org_ts").on(t.orgId, t.ts), index("events_monitor").on(t.monitorId)],
);

export const notificationsTable = pgTable("notification_log", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  orgId: integer("org_id").notNull(),
  ts: bigint("ts", { mode: "number" }).notNull(),
  monitorId: integer("monitor_id"),
  channel: text("channel").notNull(),
  status: text("status").notNull(),
  detail: text("detail"),
  payload: jsonb("payload"),
  attempts: integer("attempts").notNull().default(1),
  nextAttemptAt: bigint("next_attempt_at", { mode: "number" }),
});
