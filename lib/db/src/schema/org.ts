import { pgTable, serial, text, timestamp, integer, boolean, jsonb, varchar } from "drizzle-orm/pg-core";

export const orgsTable = pgTable("orgs", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// A user can belong to many organizations; role is per organization. Authorization reads this table only
// (users.org_id/users.role are legacy columns kept for rollback; migration 4 backfills this table from them).
export const orgMembershipsTable = pgTable("org_memberships", {
  userId: varchar("user_id").notNull(),
  orgId: integer("org_id").notNull(),
  role: text("role").notNull().default("member"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const invitesTable = pgTable("invites", {
  id: serial("id").primaryKey(),
  email: varchar("email").notNull(),
  orgId: integer("org_id").notNull(),
  role: text("role").notNull().default("member"),
  token: varchar("token", { length: 64 }).unique(),
  invitedBy: varchar("invited_by"),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const apiKeysTable = pgTable("api_keys", {
  id: serial("id").primaryKey(),
  orgId: integer("org_id").notNull(),
  name: text("name").notNull(),
  key: varchar("key", { length: 64 }).notNull().unique(),
  kind: text("kind").notNull().default("api"), // api | app
  createdBy: varchar("created_by"),
  revoked: boolean("revoked").notNull().default(false),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const integrationsTable = pgTable("notification_channels", {
  id: serial("id").primaryKey(),
  orgId: integer("org_id").notNull(),
  kind: text("kind").notNull(), // webhook | slack
  name: text("name").notNull(),
  config: jsonb("config").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
