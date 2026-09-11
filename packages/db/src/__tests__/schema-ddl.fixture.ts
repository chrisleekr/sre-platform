// Characterization lock for the schema DDL that carries semantics nothing else asserts: the four
// indexes and the tenant_isolation RLS policies (declared in the Drizzle schema, emitted by
// drizzle-kit) plus FORCE ROW LEVEL SECURITY (not expressible in drizzle-kit, still applied raw by
// migrate.ts). Drop or rename an index and CI stays green while correlation falls back to a seq scan
// and job coalescing stops coalescing; mistranscribe a policy clause, or lose FORCE, and tenant
// isolation silently opens. Reads the LIVE catalog, so the assertions hold whoever emits the DDL.
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll } from 'vitest';
import { makeDb, type DbHandle } from '../index';

interface IndexRow {
  indexname: string;
  indexdef: string;
}

interface RlsRow {
  table_name: string;
  rls_enabled: boolean;
  rls_forced: boolean;
  policy_count: number;
}

interface PolicyRow {
  tablename: string;
  policyname: string;
  permissive: string;
  roles: string[];
  cmd: string;
  qual: string | null;
  with_check: string | null;
}

interface ConstraintRow {
  relname: string;
  conname: string;
  def: string;
}

export function createFixture() {
  const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';

  const APP_URL =
    process.env.APP_DATABASE_URL ?? 'postgres://app_user:app@localhost:5432/sre_platform';

  // Jobs dispatch across tenants. Notifications are scoped to a signed-in recipient before tenant
  // context exists. Surface receipts arrive before tenant resolution and deny the app role all
  // access. Impersonation sessions are resolved before tenant context and the app role can only
  // read them. The remaining control-plane records resolve or create tenant context. Every other
  // tenant_id table must be RLS-guarded.
  const NON_RLS_TENANT_TABLES = [
    'impersonation_sessions',
    'jobs',
    'memberships',
    'notifications',
    'surface_inbound_events',
    'tenant_identity_bindings',
    'tenant_invitations',
    'workspace_foundings',
  ];

  let admin: DbHandle;

  let app: DbHandle;

  let indexes: Map<string, string>;

  let rlsTables: RlsRow[];

  let policies: PolicyRow[];

  let constraints: ConstraintRow[];

  let incidentConstraints: ConstraintRow[];

  // Postgres re-renders indexdef and policy expressions from the parse tree (its own spacing, quoting
  // and ::text casts), so match on semantic substrings. `squash` drops ALL whitespace, which makes the
  // match independent of how the deparser spaced an operator.
  const squash = (s: string): string => s.replace(/\s+/g, '');

  const norm = (s: string): string => s.replace(/\s+/g, ' ');

  beforeAll(async () => {
    admin = makeDb(ADMIN_URL);
    app = makeDb(APP_URL);

    const idx = (await admin.db.execute(sql`
      select indexname, indexdef from pg_indexes where schemaname = 'public'
    `)) as unknown as IndexRow[];
    indexes = new Map(idx.map((r) => [r.indexname, r.indexdef]));

    rlsTables = (await admin.db.execute(sql`
      select c.relname as table_name,
             c.relrowsecurity as rls_enabled,
             c.relforcerowsecurity as rls_forced,
             (select count(*) from pg_policy p where p.polrelid = c.oid)::int as policy_count
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        -- 'r' ordinary + 'p' partitioned: a partitioned table honours RLS but is a different relkind,
        -- so filtering on 'r' alone would hide it from this check the day someone partitions a table.
        and c.relkind in ('r', 'p')
        and exists (
          select 1 from pg_attribute a
          where a.attrelid = c.oid and a.attname = 'tenant_id' and a.attnum > 0 and not a.attisdropped
        )
      order by c.relname
    `)) as unknown as RlsRow[];

    policies = (await admin.db.execute(sql`
      select tablename, policyname, permissive, roles, cmd, qual, with_check
      from pg_policies where schemaname = 'public'
    `)) as unknown as PolicyRow[];

    // Table CONSTRAINTS, separately from pg_indexes: the retired full unique on (tenant, fingerprint)
    // was a table constraint (an unnamed drizzle `unique()`), and a constraint is not droppable by DROP
    // INDEX. Covers `jobs` too, which is where the status CHECKs live.
    constraints = (await admin.db.execute(sql`
      select c.relname, con.conname, pg_get_constraintdef(con.oid) as def
      from pg_constraint con
      join pg_class c on c.oid = con.conrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname in ('incidents', 'jobs')
    `)) as unknown as ConstraintRow[];
    incidentConstraints = constraints.filter((r) => r.relname === 'incidents');
  }, 30_000);

  afterAll(async () => {
    if (admin) await admin.close();
    if (app) await app.close();
  });

  return {
    ADMIN_URL,
    APP_URL,
    NON_RLS_TENANT_TABLES,
    get admin() {
      return admin;
    },
    set admin(value: typeof admin) {
      admin = value;
    },
    get app() {
      return app;
    },
    set app(value: typeof app) {
      app = value;
    },
    get indexes() {
      return indexes;
    },
    set indexes(value: typeof indexes) {
      indexes = value;
    },
    get rlsTables() {
      return rlsTables;
    },
    set rlsTables(value: typeof rlsTables) {
      rlsTables = value;
    },
    get policies() {
      return policies;
    },
    set policies(value: typeof policies) {
      policies = value;
    },
    get constraints() {
      return constraints;
    },
    set constraints(value: typeof constraints) {
      constraints = value;
    },
    get incidentConstraints() {
      return incidentConstraints;
    },
    set incidentConstraints(value: typeof incidentConstraints) {
      incidentConstraints = value;
    },
    squash,
    norm,
  };
}

export type TestFixture = ReturnType<typeof createFixture>;
