// Characterization lock for the schema DDL that carries semantics nothing else asserts: the four
// indexes and the tenant_isolation RLS policies (declared in the Drizzle schema, emitted by
// drizzle-kit) plus FORCE ROW LEVEL SECURITY (not expressible in drizzle-kit, still applied raw by
// migrate.ts). Drop or rename an index and CI stays green while correlation falls back to a seq scan
// and job coalescing stops coalescing; mistranscribe a policy clause, or lose FORCE, and tenant
// isolation silently opens. Reads the LIVE catalog, so the assertions hold whoever emits the DDL.
import { describe, expect, test } from 'vitest';

import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';

import { ACTIVE_STATUSES, CLOSED_STATUSES, JOB_STATUSES, jobs, type JobStatus } from '../index';

import { createFixture } from './schema-ddl.fixture';

const __fixture = createFixture();

describe('platform settings system table', () => {
  test('has exactly key, value, and updated_at, with a key primary key and no RLS', async () => {
    const columns = (await __fixture.admin.db.execute(sql`
      select a.attname as name, pg_catalog.format_type(a.atttypid, a.atttypmod) as type,
             a.attnotnull as not_null
      from pg_catalog.pg_attribute a
      join pg_catalog.pg_class c on c.oid = a.attrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = 'platform_settings'
        and a.attnum > 0 and not a.attisdropped
      order by a.attnum
    `)) as unknown as { name: string; type: string; not_null: boolean }[];
    expect(columns).toEqual([
      { name: 'key', type: 'text', not_null: true },
      { name: 'value', type: 'jsonb', not_null: true },
      { name: 'updated_at', type: 'timestamp with time zone', not_null: true },
    ]);

    const table = (
      (await __fixture.admin.db.execute(sql`
        select c.relrowsecurity as rls_enabled, c.relforcerowsecurity as rls_forced,
               (select count(*) from pg_catalog.pg_policy p where p.polrelid = c.oid)::int as policy_count
        from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = 'platform_settings'
      `)) as unknown as { rls_enabled: boolean; rls_forced: boolean; policy_count: number }[]
    )[0];
    expect(table).toEqual({ rls_enabled: false, rls_forced: false, policy_count: 0 });

    const primaryKeys = (
      (await __fixture.admin.db.execute(sql`
        select pg_catalog.pg_get_constraintdef(con.oid) as def
        from pg_catalog.pg_constraint con
        join pg_catalog.pg_class c on c.oid = con.conrelid
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = 'platform_settings' and con.contype = 'p'
      `)) as unknown as { def: string }[]
    ).map((row) => __fixture.squash(row.def).toLowerCase());
    expect(primaryKeys).toEqual(['primarykey(key)']);
  });

  test('is inaccessible to app_user while the system connection retains all table privileges', async () => {
    const appPrivileges = (await __fixture.app.db.execute(sql`
      select privilege, pg_catalog.has_table_privilege(current_user, 'public.platform_settings', privilege) as allowed
      from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) as privilege
      order by privilege
    `)) as unknown as { privilege: string; allowed: boolean }[];
    expect(appPrivileges).toEqual([
      { privilege: 'DELETE', allowed: false },
      { privilege: 'INSERT', allowed: false },
      { privilege: 'SELECT', allowed: false },
      { privilege: 'UPDATE', allowed: false },
    ]);

    const adminPrivileges = (await __fixture.admin.db.execute(sql`
      select privilege, pg_catalog.has_table_privilege(current_user, 'public.platform_settings', privilege) as allowed
      from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) as privilege
      order by privilege
    `)) as unknown as { privilege: string; allowed: boolean }[];
    expect(adminPrivileges.every((row) => row.allowed)).toBe(true);
  });
});

describe('platform secrets system table', () => {
  test('is non-RLS control-plane storage inaccessible to app_user', async () => {
    const table = (
      (await __fixture.admin.db.execute(sql`
        select c.relrowsecurity as rls_enabled, c.relforcerowsecurity as rls_forced,
               (select count(*) from pg_catalog.pg_policy p where p.polrelid = c.oid)::int as policy_count
        from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = 'platform_secrets'
      `)) as unknown as { rls_enabled: boolean; rls_forced: boolean; policy_count: number }[]
    )[0];
    expect(table).toEqual({ rls_enabled: false, rls_forced: false, policy_count: 0 });

    const privileges = (await __fixture.app.db.execute(sql`
      select privilege,
             pg_catalog.has_table_privilege(current_user, 'public.platform_secrets', privilege) as allowed
      from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) as privilege
      order by privilege
    `)) as unknown as { privilege: string; allowed: boolean }[];
    expect(privileges.every((row) => !row.allowed)).toBe(true);
  });
});

describe('platform_operators system allowlist', () => {
  test('has only a non-RLS user_id primary/foreign key to users.id', async () => {
    const columns = (await __fixture.admin.db.execute(sql`
      select a.attname as name, pg_catalog.format_type(a.atttypid, a.atttypmod) as type,
             a.attnotnull as not_null
      from pg_catalog.pg_attribute a
      join pg_catalog.pg_class c on c.oid = a.attrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = 'platform_operators'
        and a.attnum > 0 and not a.attisdropped
      order by a.attnum
    `)) as unknown as { name: string; type: string; not_null: boolean }[];
    expect(columns).toEqual([{ name: 'user_id', type: 'uuid', not_null: true }]);

    const table = (
      (await __fixture.admin.db.execute(sql`
        select c.relrowsecurity as rls_enabled, c.relforcerowsecurity as rls_forced,
               (select count(*) from pg_catalog.pg_policy p where p.polrelid = c.oid)::int as policy_count
        from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = 'platform_operators'
      `)) as unknown as { rls_enabled: boolean; rls_forced: boolean; policy_count: number }[]
    )[0];
    expect(table).toEqual({ rls_enabled: false, rls_forced: false, policy_count: 0 });

    const defs = (
      (await __fixture.admin.db.execute(sql`
        select con.contype as type, pg_catalog.pg_get_constraintdef(con.oid) as def
        from pg_catalog.pg_constraint con
        join pg_catalog.pg_class c on c.oid = con.conrelid
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = 'platform_operators'
      `)) as unknown as { type: string; def: string }[]
    ).map((r) => ({ type: r.type, def: __fixture.squash(r.def).toLowerCase() }));
    expect(defs.filter((r) => r.type === 'p').map((r) => r.def)).toEqual(['primarykey(user_id)']);
    expect(defs.filter((r) => r.type === 'f')).toHaveLength(1);
    expect(defs.find((r) => r.type === 'f')?.def).toContain(
      'foreignkey(user_id)referencesusers(id)',
    );
  });
});

describe('vector + coalescing indexes exist with the semantics they were created for', () => {
  test.each(['knowledge_chunks_embedding_idx', 'incidents_embedding_idx'])(
    '%s is an HNSW cosine index (a btree/L2 index would rank by the wrong distance)',
    (name) => {
      const def = __fixture.indexes.get(name);
      expect(def, `${name} is missing`).toBeDefined();
      expect(__fixture.norm(def!)).toMatch(/USING hnsw \("?embedding"? vector_cosine_ops\)/);
    },
  );

  // Predicate is `status = 'queued'` ONLY. Covering 'processing' too would give the durable index a
  // longer lifetime than the clear-at-claim gate: a human reply landing mid-run would be coalesced
  // into the run it post-dates and dropped. See the long comment on jobs_resume_coalesce_idx in
  // schema/jobs.ts.
  test('jobs_resume_coalesce_idx is UNIQUE on (tenant_id, type, payload->>incidentId) WHERE queued only', () => {
    const def = __fixture.indexes.get('jobs_resume_coalesce_idx');
    expect(def, 'jobs_resume_coalesce_idx is missing').toBeDefined();
    const flat = __fixture.squash(def!);
    expect(flat).toContain('CREATEUNIQUEINDEX');
    expect(flat).toContain('USINGbtree(tenant_id,type,');
    expect(flat).toContain("payload->>'incidentId'");
    const where = flat.slice(flat.indexOf('WHERE'));
    expect(where).toContain("status='queued'");
    expect(where).not.toContain('processing');
  });

  test('jobs_due_idx lets the dispatcher find due work by stream and status without a table scan', () => {
    const def = __fixture.indexes.get('jobs_due_idx');
    expect(def, 'jobs_due_idx is missing').toBeDefined();
    expect(__fixture.squash(def!)).toContain('USINGbtree(stream,status,available_at)');
  });

  // Opposite requirement to the resume index: a second generate request that post-dates a RUNNING
  // generation is a duplicate, not new work, so the predicate must ALSO cover 'processing'. Else two
  // concurrent distiller runs both pass findChunkLinkingIncident and write duplicate knowledge_chunks.
  test('jobs_runbook_coalesce_idx is UNIQUE on (tenant_id, payload->>incidentId) WHERE type=runbook.generate AND queued|processing', () => {
    const def = __fixture.indexes.get('jobs_runbook_coalesce_idx');
    expect(def, 'jobs_runbook_coalesce_idx is missing').toBeDefined();
    const flat = __fixture.squash(def!);
    expect(flat).toContain('CREATEUNIQUEINDEX');
    expect(flat).toContain('USINGbtree(tenant_id,(');
    expect(flat).toContain("payload->>'incidentId'");
    // `type` must live in the predicate, not the key: a keyed type would let a queued resume and a
    // queued runbook.generate coexist per incident, which is exactly what this index must forbid.
    expect(flat).not.toContain('USINGbtree(tenant_id,type');
    const where = flat.slice(flat.indexOf('WHERE'));
    expect(where).toContain("type='runbook.generate'");
    expect(where).toContain("'queued'");
    expect(where).toContain("'processing'");
  });
});

// --- the correlation window is the ACTIVE window -------------------------------------------
// C6. The schema once had a FULL unique on (tenant_id, fingerprint), which made a fingerprint's
// first incident own it forever: once the idle sweep closed that incident, the next occurrence's INSERT
// still collided with the closed row, the upsert returned it, and the funnel kept its stale surface
// binding — so the AI would answer in a dead thread. The window must close with the incident.
// Alertmanager reaches this invariant through its bounded provider-episode router; these assertions pin
// the generic database boundary independently of that adapter.
describe('incidents_active_fingerprint_uq scopes the correlation window to ACTIVE incidents', () => {
  test('it is a PARTIAL unique index on (tenant_id, fingerprint) over exactly the ACTIVE statuses', () => {
    const def = __fixture.indexes.get('incidents_active_fingerprint_uq');
    expect(def, 'incidents_active_fingerprint_uq is missing').toBeDefined();
    const flat = __fixture.squash(def!);
    expect(flat).toContain('CREATEUNIQUEINDEX');
    expect(flat).toContain('USINGbtree(tenant_id,fingerprint)');
    // The predicate IS the fix. Without a WHERE this is the old full unique wearing a new name, and
    // every other part of becomes a no-op.
    expect(flat).toContain('WHERE');
    const where = flat.slice(flat.indexOf('WHERE'));

    // Pin the OPERATOR before the literals. The literal assertions below cannot tell the predicate from
    // its INVERSE: `NOT (status = ANY (ARRAY[...]))` deparses to `status <> ALL (ARRAY[...])`, which
    // still contains all three active literals and neither terminal one, so it would satisfy every one
    // of them while meaning the exact opposite — indexing only the terminal rows. Expected form taken
    // from the live catalog, which renders this index as:
    //   WHERE (status = ANY (ARRAY['open'::text, 'mitigated'::text]))
    expect(where).toContain('(status=ANY(ARRAY[');
    expect(where).not.toContain('<>'); // `<> ALL` — the inverted form
    expect(where).not.toContain('ALL('); // ...belt and braces, whatever the deparser spells it
    expect(where).not.toContain('NOT');

    // Every active operational lifecycle status is indexed.
    expect(where).toContain("'open'");
    expect(where).toContain("'mitigated'");
    // Both terminal statuses out, or a closed/resolved incident still blocks its fingerprint forever.
    expect(where).not.toContain("'resolved'");
    expect(where).not.toContain("'closed'");
  });

  test('C6 the old FULL unique on (tenant_id, fingerprint) is GONE, as constraint AND as index', () => {
    // Matched on the DEFINITION rather than the name: the dropped constraint was auto-named by drizzle
    // (incidents_tenant_id_fingerprint_unique), and asserting the name only would let the same
    // unconditional unique return under a different one. Reported BY name, so a failure says which.
    expect(
      __fixture.incidentConstraints
        .filter((r) => __fixture.squash(r.def) === 'UNIQUE(tenant_id,fingerprint)')
        .map((r) => r.conname),
    ).toEqual([]);
    // And no unconditional unique INDEX over those columns either — a bare index is not a constraint,
    // so it would slip past the catalog query above while blocking the fresh INSERT just as hard.
    const unconditional = [...__fixture.indexes.entries()].filter(([, d]) => {
      const f = __fixture.squash(d);
      return (
        f.includes('UNIQUEINDEX') &&
        f.includes('ONpublic.incidentsUSINGbtree(tenant_id,fingerprint)') &&
        !f.includes('WHERE')
      );
    });
    expect(unconditional).toEqual([]);
  });

  test('the composite (tenant_id, id) unique still stands, under its explicit name', () => {
    // Orthogonal to and deliberately untouched. SEVEN child tables FK (tenant_id, incident_id) ->
    // here (verified against pg_constraint): agent_tool_calls, approvals, inbound_side_effects,
    // incident_attachments, incident_messages, surface_bindings, surface_working_posts. Referential
    // checks bypass RLS, so losing this is a cross-tenant existence oracle, not just a broken FK.
    // Pin the NAME as well as the shape: made these names explicit and short precisely so they are
    // a contract, and every one of those FKs resolves through it — a rename is a breaking change.
    expect(
      __fixture.incidentConstraints
        .filter((r) => __fixture.squash(r.def) === 'UNIQUE(tenant_id,id)')
        .map((r) => r.conname),
    ).toEqual(['incidents_tenant_id_uq']);
  });
});

// --- the status vocabularies are enforced by the DATABASE, not by comments -------------------
// Both tables carried their vocabulary in a TS comment over a plain `text` column. That is what let a
// test seed jobs.status = 'running' — a status this queue has never had — and stay green: 'running' fell
// outside jobs_resume_coalesce_idx's predicate, so the seeded job left the coalescing index exactly as a
// CLAIMED job does, and the test proved nothing about the claim it was named for. The same hole on
// incidents is worse: a typo'd status escapes incidents_active_fingerprint_uq and silently permits a
// second ACTIVE incident for one fingerprint.
describe('status vocabulary CHECKs', () => {
  // Every quoted literal in a constraint definition. Postgres re-renders the def from the parse tree
  // (ARRAY[...] with ::text casts), so read the literals rather than matching the whole expression.
  const literalsIn = (def: string): string[] => [...def.matchAll(/'([^']*)'/g)].map((m) => m[1]!);
  const defOf = (table: string, name: string): string => {
    const row = __fixture.constraints.find((r) => r.relname === table && r.conname === name);
    expect(row, `${table}.${name} is missing`).toBeDefined();
    return row!.def;
  };

  // C2 drift-lock. The vocabulary is DERIVED AT TEST TIME from the same consts the schema builds the
  // CHECK from, so this assertion cannot itself drift: add a status to ACTIVE_STATUSES/CLOSED_STATUSES
  // and this test demands the constraint carry it. A hand-typed list here would be a fourth copy of the
  // vocabulary and would need editing in lockstep — exactly the failure mode is about.
  test('C2 incidents_status_vocabulary admits EXACTLY the union of ACTIVE_STATUSES and CLOSED_STATUSES', () => {
    const def = defOf('incidents', 'incidents_status_vocabulary');
    const expected = [...ACTIVE_STATUSES, ...CLOSED_STATUSES];
    expect(expected.length).toBeGreaterThan(0); // not vacuous
    // Set equality, so it fails in BOTH directions: a status the consts gained but the CHECK lacks would
    // be rejected at write time, and a literal the consts no longer carry would still be accepted.
    expect(new Set(literalsIn(def))).toEqual(new Set(expected));
    // Pin the operator before trusting the literals, for the same reason the index test does: the
    // INVERSE (`status <> ALL (ARRAY[...])`) contains every one of these literals while admitting only
    // the statuses we forbid, and would satisfy the set assertion above.
    const flat = __fixture.squash(def);
    expect(flat).toContain('=ANY(ARRAY[');
    expect(flat).not.toContain('<>');
    expect(flat).not.toContain('NOT');
  });

  test('C3 jobs_status_vocabulary admits EXACTLY JOB_STATUSES', () => {
    const def = defOf('jobs', 'jobs_status_vocabulary');
    expect(JOB_STATUSES.length).toBeGreaterThan(0);
    expect(new Set(literalsIn(def))).toEqual(new Set(JOB_STATUSES));
    const flat = __fixture.squash(def);
    expect(flat).toContain('=ANY(ARRAY[');
    expect(flat).not.toContain('<>');
    expect(flat).not.toContain('NOT');
    // The status the blocker seeded. Named explicitly: it is the whole reason this constraint exists.
    expect(literalsIn(def)).not.toContain('running');
  });

  // C4. jobs.type is free text BY CONTRACT — enqueue writes JobInput.type verbatim, production carries
  // 'poll', and tests enqueue randomized types. A vocabulary CHECK on it would break the queue suite, so
  // its ABSENCE is the invariant: this fails if someone "completes" by symmetry.
  test('C4 jobs.type has NO vocabulary constraint: it is free text by contract', () => {
    expect(
      __fixture.constraints
        .filter((r) => r.relname === 'jobs' && /type/i.test(r.conname))
        .map((r) => r.conname),
    ).toEqual([]);
  });

  // 23514 = check_violation. Asserting the CODE (not just any throw) proves the rejection is the
  // vocabulary CHECK and not an incidental error — a missing NOT NULL column would throw too. drizzle
  // wraps DB errors so the SQLSTATE is on `.cause.code`; fall back to `.code` for an unwrapped driver
  // error. Mirrors expectForeignKeyViolation in composite-fk.test.ts.
  const expectCheckViolation = async (run: Promise<unknown>, why: string): Promise<void> => {
    let err: { code?: string; cause?: { code?: string } } | undefined;
    try {
      await run;
    } catch (e) {
      err = e as typeof err;
    }
    expect(err, why).toBeDefined();
    expect(err?.code ?? err?.cause?.code).toBe('23514');
  };

  test('C6 the jobs CHECK rejects the seeded-status bug at write time (23514)', async () => {
    // A real INSERT, not a catalog read: the assertions above prove the constraint is SHAPED right, not
    // that Postgres enforces it. 'running' is the exact value two route-to-incident tests seeded to mean
    // "claimed". jobs carries no tenant FK, so a bare uuid inserts.
    await expectCheckViolation(
      __fixture.admin.db.insert(jobs).values({
        tenantId: randomUUID(),
        type: 'triage',
        stream: 'jobs:test',
        status: 'running' as unknown as JobStatus,
      }),
      "status 'running' was ACCEPTED: the CHECK is not enforced",
    );
  });

  test('C5 the jobs CHECK admits every status the queue actually writes', async () => {
    // The mirror image: a CHECK that rejects everything would pass C6 while breaking the queue. Proves
    // the constraint is not over-tight, and does it inside a rolled-back tx so nothing is left behind.
    for (const status of JOB_STATUSES) {
      await expect(
        __fixture.admin.db.transaction(async (tx) => {
          await tx
            .insert(jobs)
            .values({ tenantId: randomUUID(), type: 'triage', stream: 'jobs:test', status });
          tx.rollback();
        }),
      ).rejects.toThrow(/rollback/i); // tx.rollback() throws by design; the INSERT itself must not
    }
  });
});

describe('RLS coverage over every tenant_id table', () => {
  test('the catalog query actually sees the tenant tables (guards the assertions below from being vacuous)', () => {
    const names = __fixture.rlsTables.map((r) => r.table_name);
    expect(names).toEqual(
      expect.arrayContaining(['incidents', 'tenant_secrets', 'connector_configs']),
    );
    // A stale exemption list is a bug in its own right: it would mean we exempt a table that no
    // longer carries tenant_id, while a real one goes unchecked.
    expect(names).toEqual(expect.arrayContaining(__fixture.NON_RLS_TENANT_TABLES));
  });

  // FORCE is the load-bearing half: the migration role OWNS these tables, and an owner bypasses a
  // merely-ENABLED policy. Without FORCE, RLS is decorative for anything running as the owner.
  test('every non-exempt tenant_id table has RLS enabled AND forced AND at least one policy', () => {
    const guarded = __fixture.rlsTables.filter(
      (r) => !__fixture.NON_RLS_TENANT_TABLES.includes(r.table_name),
    );
    expect(guarded.length).toBeGreaterThan(0);
    const failures = guarded.filter((r) => !r.rls_enabled || !r.rls_forced || r.policy_count < 1);
    expect(
      failures.map(
        (r) =>
          `${r.table_name}: enabled=${r.rls_enabled} forced=${r.rls_forced} policies=${r.policy_count}`,
      ),
    ).toEqual([]);
  });
});

// Every guarded table, not one representative: the policies come from a single shared tenantIsolation()
// helper today, but the generated SQL is a checked-in file a human can hand-edit, and a wrong body on
// any ONE of the 16 opens that table to every tenant. Counting policies would not catch it — a policy
// with `USING (true)` satisfies a count.
describe('the tenant_isolation policy body, on every guarded table', () => {
  const guardedTables = (): string[] =>
    __fixture.rlsTables
      .map((r) => r.table_name)
      .filter((t) => !__fixture.NON_RLS_TENANT_TABLES.includes(t));

  test('each is PERMISSIVE, FOR ALL, TO public, with USING and WITH CHECK both bound to app.tenant_id', () => {
    const tables = guardedTables();
    expect(tables.length).toBeGreaterThan(0); // not vacuous

    const bad = tables.flatMap((table) => {
      const p = __fixture.policies.find(
        (r) => r.tablename === table && r.policyname === 'tenant_isolation',
      );
      if (!p) return [`${table}: no tenant_isolation policy`];
      const problems: string[] = [];
      // A RESTRICTIVE policy, or one scoped to a role the app does not use, changes who the clause binds.
      if (p.permissive !== 'PERMISSIVE') problems.push(`permissive=${p.permissive}`);
      if (p.cmd !== 'ALL') problems.push(`cmd=${p.cmd}`);
      if (!p.roles.includes('public')) problems.push(`roles=${p.roles.join('|')}`);
      // Postgres would fall back to USING as the row-check if WITH CHECK were absent, so a NULL here is
      // not itself a hole. It IS a divergence from the declared policy, and the fallback disappears the
      // moment `for:` is narrowed. Require both clauses, and require them to agree.
      if (p.with_check === null) problems.push('with_check=NULL');
      for (const clause of [p.qual, p.with_check]) {
        if (clause === null) continue;
        if (!__fixture.squash(clause).includes("current_setting('app.tenant_id'")) {
          problems.push(`clause does not read app.tenant_id: ${__fixture.norm(clause)}`);
        }
        if (!clause.includes('tenant_id')) problems.push(`clause does not filter tenant_id`);
      }
      if (
        p.qual !== null &&
        p.with_check !== null &&
        __fixture.squash(p.qual) !== __fixture.squash(p.with_check)
      ) {
        problems.push('USING and WITH CHECK differ');
      }
      return problems.length > 0 ? [`${table}: ${problems.join(', ')}`] : [];
    });

    expect(bad).toEqual([]);
  });
});

describe('terminal investigation-run integrity', () => {
  test('stores the approved run contract under forced tenant RLS', async () => {
    const columns = (await __fixture.admin.db.execute(sql`
      select a.attname as name
      from pg_catalog.pg_attribute a
      join pg_catalog.pg_class c on c.oid = a.attrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = 'investigation_runs'
        and a.attnum > 0 and not a.attisdropped
      order by a.attnum
    `)) as unknown as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        'id',
        'tenant_id',
        'incident_id',
        'operation',
        'provider',
        'engine_model',
        'engine_session_id',
        'turn_budget',
        'outcome',
        'result',
        'evidence_ids',
        'started_at',
        'completed_at',
      ]),
    );

    const table = __fixture.rlsTables.find((row) => row.table_name === 'investigation_runs');
    expect(table).toMatchObject({ rls_enabled: true, rls_forced: true });
    expect(table!.policy_count).toBeGreaterThan(0);
  });

  test('uses composite foreign keys for run ownership and same-incident pointers', async () => {
    const constraints = (await __fixture.admin.db.execute(sql`
      select c.relname as table_name,
             con.contype as type,
             pg_catalog.pg_get_constraintdef(con.oid) as def
      from pg_catalog.pg_constraint con
      join pg_catalog.pg_class c on c.oid = con.conrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname in ('incidents', 'investigation_runs')
    `)) as unknown as Array<{ table_name: string; type: string; def: string }>;
    const definitions = (table: string, type: string) =>
      constraints
        .filter((row) => row.table_name === table && row.type === type)
        .map((row) => __fixture.squash(row.def).toLowerCase());

    expect(definitions('investigation_runs', 'u')).toContain('unique(tenant_id,incident_id,id)');
    expect(definitions('investigation_runs', 'f')).toContainEqual(
      expect.stringContaining('foreignkey(tenant_id,incident_id)referencesincidents(tenant_id,id)'),
    );
    expect(definitions('incidents', 'f')).toContainEqual(
      expect.stringContaining(
        'foreignkey(tenant_id,id,trusted_assessment_run_id)referencesinvestigation_runs(tenant_id,incident_id,id)',
      ),
    );
    expect(definitions('incidents', 'f')).toContainEqual(
      expect.stringContaining(
        'foreignkey(tenant_id,id,recovery_run_id)referencesinvestigation_runs(tenant_id,incident_id,id)',
      ),
    );

    const outcomeCheck = definitions('investigation_runs', 'c').find((definition) =>
      definition.includes("'conclusive'"),
    );
    expect(outcomeCheck).toBeDefined();
    for (const outcome of [
      'conclusive',
      'inconclusive',
      'blocked_missing_capability',
      'budget_exhausted',
      'failed',
    ])
      expect(outcomeCheck).toContain(`'${outcome}'`);

    const completionCheck = definitions('investigation_runs', 'c').find((definition) =>
      definition.includes('completed_at'),
    );
    expect(completionCheck).toBeDefined();
    expect(completionCheck).toContain('outcomeisnull');
    expect(completionCheck).toContain('resultisnull');
    expect(completionCheck).toContain('completed_atisnull');
    expect(completionCheck).toContain('outcomeisnotnull');
    expect(completionCheck).toContain('resultisnotnull');
    expect(completionCheck).toContain('completed_atisnotnull');
  });
});
