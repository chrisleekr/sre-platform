import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { identityProviders, users, workspaceFoundings, tenants } from './control-plane';

/** Browser credentials are random, hashed at rest, and never upstream OAuth tokens. */
export const browserSessions = pgTable(
  'browser_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    credentialHash: text('credential_hash').notNull().unique(),
    providerId: uuid('provider_id')
      .notNull()
      .references(() => identityProviders.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    foundingId: uuid('founding_id').references(() => workspaceFoundings.id, {
      onDelete: 'cascade',
    }),
    oidcSubject: text('oidc_subject').notNull(),
    clientId: text('client_id').notNull(),
    oidcSessionId: text('oidc_session_id'),
    bindingClaimValue: text('binding_claim_value'),
    selectedTenantId: uuid('selected_tenant_id').references(() => tenants.id, {
      onDelete: 'cascade',
    }),
    authenticatedAt: timestamp('authenticated_at', { withTimezone: true }).notNull(),
    idleExpiresAt: timestamp('idle_expires_at', { withTimezone: true }).notNull(),
    absoluteExpiresAt: timestamp('absolute_expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('browser_sessions_user_idx').on(table.userId),
    index('browser_sessions_provider_subject_idx').on(table.providerId, table.oidcSubject),
    check(
      'browser_sessions_expiry_check',
      sql`${table.idleExpiresAt} <= ${table.absoluteExpiresAt}`,
    ),
  ],
);

/** A callback can consume only the attempt created in the same browser. */
export const oidcAttempts = pgTable('oidc_attempts', {
  stateHash: text('state_hash').primaryKey(),
  browserHash: text('browser_hash').notNull(),
  providerId: uuid('provider_id')
    .notNull()
    .references(() => identityProviders.id, { onDelete: 'cascade' }),
  foundingId: uuid('founding_id').references(() => workspaceFoundings.id, { onDelete: 'cascade' }),
  nonce: text('nonce').notNull(),
  codeVerifier: text('code_verifier').notNull(),
  redirectUri: text('redirect_uri').notNull(),
  returnTo: text('return_to').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

export interface PendingMailboxIdentity {
  providerId: string;
  clientId: string;
  issuer: string;
  subject: string;
  oidcSubject: string;
  email: string;
  oidcSessionId?: string;
  bindingClaimValue: string | null;
  authenticatedAt: string;
  foundingId: string | null;
  returnTo: string;
}

/** Mailbox proof stays outside both the product inbox and an authenticated session. */
export const mailboxProofs = pgTable('mailbox_proofs', {
  credentialHash: text('credential_hash').primaryKey(),
  codeHash: text('code_hash').notNull(),
  identity: jsonb('identity').$type<PendingMailboxIdentity>().notNull(),
  attempts: integer('attempts').notNull().default(0),
  lastSentAt: timestamp('last_sent_at', { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});
