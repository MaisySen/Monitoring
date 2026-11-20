import { pgTable, serial, text, timestamp, integer, boolean, jsonb, varchar } from "drizzle-orm/pg-core";

export const orgsTable = pgTable("orgs", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// A user can belong to many organizations; role is per organization. Authorization reads this table only
// (users.org_id/users.role are legacy columns kept for rollback; migration 4 backfills this table from them).
// source marks how the membership was granted: "local" (setup/invite/admin action - never touched by SSO
// sync) or "sso" (derived from provider claims, synced on every login, sso_issuer names the issuer).
export const orgMembershipsTable = pgTable("org_memberships", {
  userId: varchar("user_id").notNull(),
  orgId: integer("org_id").notNull(),
  role: text("role").notNull().default("member"),
  source: text("source").notNull().default("local"),
  ssoIssuer: text("sso_issuer"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// SSO identities bind a user to an immutable (issuer, subject) pair. Email is never used to link an SSO
// login to an existing account: display names and addresses collide; (issuer, sub) does not.
export const ssoIdentitiesTable = pgTable("sso_identities", {
  issuer: text("issuer").notNull(),
  sub: text("sub").notNull(),
  userId: varchar("user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Organization bindings map an immutable (issuer, external org id) pair onto a Monitoring organization.
// The provider's display name is kept only for rendering; it is never used to look an organization up.
export const ssoOrgBindingsTable = pgTable("sso_org_bindings", {
  issuer: text("issuer").notNull(),
  externalId: text("external_id").notNull(),
  orgId: integer("org_id").notNull(),
  name: text("name").notNull(),
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
