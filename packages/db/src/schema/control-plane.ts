// Identity control-plane tables resolve a verified provider identity to tenant membership.
// Memberships carry the tenant-scoped role and lifecycle state, while provider bindings and
// workspace founding records are read before a request has a tenant context.
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  customType,
  foreignKey,
  integer,
  jsonb,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { DirectoryEmail, DirectoryName } from './directory-types';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

export const TENANT_STATUSES = ['active', 'suspended', 'deleting'] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];
export const USER_STATUSES = ['active', 'disabled', 'deleted'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];
export const MEMBERSHIP_ROLES = ['owner', 'admin', 'member'] as const;
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];
export const MEMBERSHIP_STATUSES = ['active', 'removed'] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];
export const PROVIDER_KINDS = ['oidc', 'local'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];
export const PROVIDER_SCOPES = ['installation', 'tenant'] as const;
export type ProviderScope = (typeof PROVIDER_SCOPES)[number];
export const PROVIDER_STATUSES = [
  'provisional',
  'pending_verification',
  'active',
  'disabled',
  'failed',
] as const;
export type ProviderStatus = (typeof PROVIDER_STATUSES)[number];
export const SCIM_IDENTITY_ATTRIBUTES = ['externalId', 'userName'] as const;
export type ScimIdentityAttribute = (typeof SCIM_IDENTITY_ATTRIBUTES)[number];

export const tenants = pgTable(
  'tenants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    /** Stable workspace address used in links and workspace-specific sign-in pages. */
    slug: text('slug')
      .notNull()
      .default(sql`'workspace-' || gen_random_uuid()::text`),
    status: text('status').$type<TenantStatus>().notNull().default('active'),
    requireDirectory: boolean('require_directory').notNull().default(false),
    deleteAfter: timestamp('delete_after', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique().on(table.slug),
    check('tenants_status_check', sql`status in ('active','suspended','deleting')`),
  ],
);

// A user is identified by the standard OIDC (issuer, subject) pair, present in every
// provider's tokens. Rows are JIT-created on first successful login.
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    issuer: text('issuer').notNull(),
    subject: text('subject').notNull(),
    email: text('email'),
    status: text('status').$type<UserStatus>().notNull().default('active'),
    lastSignInAt: timestamp('last_sign_in_at', { withTimezone: true }),
    /** Tokens issued before this instant are refused; null means no revocation has happened. */
    notBefore: timestamp('not_before', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique().on(table.issuer, table.subject),
    check('users_status_check', sql`status in ('active','disabled','deleted')`),
  ],
);

export const platformOperators = pgTable('platform_operators', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id),
});

export const platformSettings = pgTable('platform_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<unknown>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/** Platform-global encrypted credentials. App-role access is revoked during migration bootstrap. */
export const platformSecrets = pgTable('platform_secrets', {
  name: text('name').primaryKey(),
  ciphertext: bytea('ciphertext').notNull(),
  nonce: bytea('nonce').notNull(),
  authTag: bytea('auth_tag').notNull(),
  keyVersion: integer('key_version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/** Recipient-scoped product notifications, durable before any optional secondary delivery. */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    recipientUserId: uuid('recipient_user_id').references(() => users.id),
    recipientEmail: text('recipient_email'),
    tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    /** Optional producer identity that makes retrying one domain event safe. */
    eventKey: text('event_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    readAt: timestamp('read_at', { withTimezone: true }),
    emailedAt: timestamp('emailed_at', { withTimezone: true }),
    emailError: text('email_error'),
  },
  (table) => [
    index('notifications_recipient_idx').on(table.recipientUserId, table.createdAt, table.id),
    uniqueIndex('notifications_event_key_uq')
      .on(table.eventKey)
      .where(sql`${table.eventKey} is not null`),
    check(
      'notifications_recipient_check',
      sql`${table.recipientUserId} is not null or ${table.recipientEmail} is not null`,
    ),
  ],
);

/** Append-only record of every successful platform-administrator mutation. */
export const adminActions = pgTable(
  'admin_actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actorUserId: uuid('actor_user_id')
      .notNull()
      .references(() => users.id),
    action: text('action').notNull(),
    targetKind: text('target_kind').notNull(),
    targetId: text('target_id').notNull(),
    reason: text('reason'),
    details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('admin_actions_target_idx').on(table.targetKind, table.targetId, table.createdAt),
  ],
);

/** One-hour, non-extendable platform-support access to a target workspace. */
export const impersonationSessions = pgTable(
  'impersonation_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actorUserId: uuid('actor_user_id')
      .notNull()
      .references(() => users.id),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    reason: text('reason').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (table) => [
    index('impersonation_sessions_actor_idx').on(table.actorUserId, table.startedAt),
    index('impersonation_sessions_tenant_idx').on(table.tenantId, table.startedAt),
    check('impersonation_sessions_expiry_check', sql`${table.expiresAt} > ${table.startedAt}`),
  ],
);

export const memberships = pgTable(
  'memberships',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    role: text('role').$type<MembershipRole>().notNull().default('member'),
    /** Removed memberships remain durable so just-in-time provisioning cannot resurrect them. */
    status: text('status').$type<MembershipStatus>().notNull().default('active'),
    /** First-run welcome has been presented for this person in this workspace. */
    welcomeShownAt: timestamp('welcome_shown_at', { withTimezone: true }),
    /** Per-person dismissal of the first-run checklist for this workspace. */
    welcomeDismissedAt: timestamp('welcome_dismissed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique().on(table.userId, table.tenantId),
    check('memberships_role_check', sql`role in ('owner','admin','member')`),
    check('memberships_status_check', sql`status in ('active','removed')`),
  ],
);

export const identityProviders = pgTable(
  'identity_providers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    displayName: text('display_name').notNull(),
    issuer: text('issuer').notNull(),
    /** Stored from discovery because the well-known key path is provider-specific. */
    jwksUri: text('jwks_uri').notNull(),
    authorizationEndpoint: text('authorization_endpoint'),
    tokenEndpoint: text('token_endpoint'),
    audience: text('audience'),
    kind: text('kind').$type<ProviderKind>().notNull(),
    scope: text('scope').$type<ProviderScope>().notNull(),
    supportsSignup: boolean('supports_signup').notNull().default(false),
    emailClaim: text('email_claim').notNull().default('email'),
    tenantClaim: text('tenant_claim'),
    subjectClaim: text('subject_claim').notNull().default('sub'),
    browserClientId: text('browser_client_id'),
    /** Allows the configured OIDC client to accept provider-initiated logout tokens. */
    backchannelLogout: boolean('backchannel_logout').notNull().default(false),
    /** Requires the final-spec logout+jwt media type on provider logout tokens. */
    backchannelLogoutTypRequired: boolean('backchannel_logout_typ_required')
      .notNull()
      .default(false),
    /** Enables the provider-scoped SCIM 2.0 User endpoint. */
    scimEnabled: boolean('scim_enabled').notNull().default(false),
    /** SHA-256 digest of the one-time SCIM bearer credential. */
    scimTokenHash: text('scim_token_hash'),
    scimTokenCreatedAt: timestamp('scim_token_created_at', { withTimezone: true }),
    scimTokenExpiresAt: timestamp('scim_token_expires_at', { withTimezone: true }),
    requireProvisioned: boolean('require_provisioned').notNull().default(false),
    scimIdentityAttribute: text('scim_identity_attribute')
      .$type<ScimIdentityAttribute>()
      .notNull()
      .default('externalId'),
    clientAuthentication: text('client_authentication')
      .$type<'none' | 'client_secret_post' | 'client_secret_basic'>()
      .notNull()
      .default('none'),
    authorizationScopes: text('authorization_scopes')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    authorizationAudience: text('authorization_audience'),
    sortOrder: integer('sort_order').notNull().default(0),
    status: text('status').$type<ProviderStatus>().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('identity_providers_active_issuer_idx')
      .on(table.issuer)
      .where(sql`${table.status} = 'active' and ${table.scope} = 'installation'`),
    check('identity_providers_kind_check', sql`kind in ('oidc','local')`),
    check('identity_providers_scope_check', sql`scope in ('installation','tenant')`),
    check(
      'identity_providers_status_check',
      sql`status in ('provisional','pending_verification','active','disabled','failed')`,
    ),
    check(
      'identity_providers_scim_attribute_check',
      sql`${table.scimIdentityAttribute} in ('externalId','userName')`,
    ),
    check(
      'identity_providers_scim_credential_check',
      sql`${table.scimEnabled} = (${table.scimTokenHash} is not null and ${table.scimTokenCreatedAt} is not null and ${table.scimTokenExpiresAt} is not null)`,
    ),
    check(
      'identity_providers_scim_eligibility_check',
      sql`not ${table.scimEnabled} or (${table.kind} = 'oidc' and ${table.browserClientId} is not null)`,
    ),
    check(
      'identity_providers_scim_policy_check',
      sql`not ${table.requireProvisioned} or ${table.scimEnabled}`,
    ),
  ],
);

/** Durable one-time claims for provider logout tokens, committed with their session effects. */
export const backchannelLogoutReceipts = pgTable(
  'backchannel_logout_receipts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    providerId: uuid('provider_id')
      .notNull()
      .references(() => identityProviders.id, { onDelete: 'cascade' }),
    jtiHash: text('jti_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique().on(table.providerId, table.jtiHash),
    index('backchannel_logout_receipts_expiry_idx').on(table.expiresAt),
  ],
);

/** Provider-scoped SCIM User resources; deleted rows remain as hidden tombstones. */
export const directoryAccounts = pgTable(
  'directory_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    providerId: uuid('provider_id')
      .notNull()
      .references(() => identityProviders.id, { onDelete: 'cascade' }),
    externalId: text('external_id'),
    userName: text('user_name').notNull(),
    active: boolean('active').notNull().default(true),
    name: jsonb('name').$type<DirectoryName>().notNull().default({}),
    emails: jsonb('emails').$type<DirectoryEmail[]>().notNull().default([]),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique().on(table.id, table.providerId),
    uniqueIndex('directory_accounts_provider_username_current_idx')
      .on(table.providerId, sql`lower(${table.userName})`)
      .where(sql`${table.deletedAt} is null`),
    uniqueIndex('directory_accounts_provider_external_id_current_idx')
      .on(table.providerId, table.externalId)
      .where(sql`${table.deletedAt} is null and ${table.externalId} is not null`),
    index('directory_accounts_provider_updated_idx').on(table.providerId, table.updatedAt),
  ],
);

/** Durable OIDC-to-SCIM identity ownership; links survive deactivation and tombstoning. */
export const directoryAccountLinks = pgTable(
  'directory_account_links',
  {
    providerId: uuid('provider_id').notNull(),
    directoryAccountId: uuid('directory_account_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.directoryAccountId, table.providerId],
      foreignColumns: [directoryAccounts.id, directoryAccounts.providerId],
    }).onDelete('cascade'),
    unique().on(table.directoryAccountId),
    unique().on(table.providerId, table.userId),
    index('directory_account_links_user_idx').on(table.userId),
  ],
);

export const identityProviderDomains = pgTable(
  'identity_provider_domains',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    providerId: uuid('provider_id')
      .notNull()
      .references(() => identityProviders.id, { onDelete: 'cascade' }),
    domain: text('domain').notNull(),
    status: text('status').notNull().default('pending'),
    challenge: text('challenge'),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique().on(table.providerId, table.domain),
    uniqueIndex('identity_provider_domains_verified_idx')
      .on(sql`lower(${table.domain})`)
      .where(sql`${table.status} = 'verified'`),
    check('identity_provider_domains_status_check', sql`status in ('pending','verified','failed')`),
  ],
);

export const tenantIdentityBindings = pgTable(
  'tenant_identity_bindings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    providerId: uuid('provider_id')
      .notNull()
      .references(() => identityProviders.id),
    claimValue: text('claim_value'),
    /** Workspace-specific order, including installation methods shared by many workspaces. */
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [unique().on(table.providerId, table.claimValue).nullsNotDistinct()],
);

export const platformAdminInvitations = pgTable(
  'platform_admin_invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    issuer: text('issuer').notNull(),
    email: text('email').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    acceptedUserId: uuid('accepted_user_id').references(() => users.id),
  },
  (table) => [unique().on(table.issuer, table.email)],
);

export const FOUNDING_STATUSES = [
  'awaiting_founder',
  'authenticating_founder',
  'founder_authenticated',
  'pending',
  'approved',
  'provisioning',
  'active',
  'failed',
  'rejected',
  'expired',
] as const;
export type FoundingStatus = (typeof FOUNDING_STATUSES)[number];

export const workspaceFoundings = pgTable(
  'workspace_foundings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    path: text('path').notNull(),
    slug: text('slug').notNull(),
    requestedName: text('requested_name').notNull(),
    providerId: uuid('provider_id').references(() => identityProviders.id),
    founderUserId: uuid('founder_user_id').references(() => users.id),
    authAttemptId: uuid('auth_attempt_id'),
    authAttemptStartedAt: timestamp('auth_attempt_started_at', { withTimezone: true }),
    declaredDomain: text('declared_domain'),
    status: text('status').$type<FoundingStatus>().notNull(),
    claimValue: text('claim_value'),
    tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }),
    failureReason: text('failure_reason'),
    termsAcceptedVersion: text('terms_accepted_version'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('workspace_foundings_reserving_slug_uq')
      .on(table.slug)
      .where(sql`${table.status} not in ('rejected','expired')`),
    check('workspace_foundings_path_check', sql`path in ('hosted','own_directory')`),
    check(
      'workspace_foundings_status_check',
      sql`status in ('awaiting_founder','authenticating_founder','founder_authenticated','pending','approved','provisioning','active','failed','rejected','expired')`,
    ),
  ],
);

export const tenantInvitations = pgTable(
  'tenant_invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: text('role').notNull().default('member'),
    invitedByUserId: uuid('invited_by_user_id')
      .notNull()
      .references(() => users.id),
    status: text('status').notNull().default('pending'),
    providerInvitationId: text('provider_invitation_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('tenant_invitations_pending_email_uq')
      .on(table.tenantId, sql`lower(${table.email})`)
      .where(sql`${table.status} = 'pending'`),
    check('tenant_invitations_role_check', sql`role in ('admin','member')`),
    check(
      'tenant_invitations_status_check',
      sql`status in ('pending','accepted','revoked','expired')`,
    ),
  ],
);
