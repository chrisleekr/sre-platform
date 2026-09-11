import { describe, expect, test } from 'vitest';

import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';

import { type DbHandle } from '../index';

import { surfaceConfigs, tenants } from '../schema';

import {
  OUTBOUND_SURFACES,
  backfillSlackSurfaceIdentitySystem,
  deleteSurfaceConfig,
  getSurfaceConfig,
  listSurfaceConfigs,
  upsertSurfaceConfig,
  type Surface,
} from '../surface-repo';

import * as surfaceRepo from '../surface-repo';

import { createFixture } from './surface-repo.fixture';

const __fixture = createFixture();

// the tripwire's runtime half. The type-level `_assertOutboundExhaustive` in surface-repo.ts breaks
// the build if an OUTBOUND literal is missing from the tuple; this length assertion breaks the suite if a
// literal is ADDED without a deliberate review of the durable delivery state machine.
test('OUTBOUND_SURFACES lists exactly the one shipped outbound surface', () => {
  expect(OUTBOUND_SURFACES).toEqual(['slack']);
  expect(OUTBOUND_SURFACES.length).toBe(1);
});

describe('surface configs', () => {
  // The row's EXISTENCE is the connection: no post target, no enable flag, no inbound flag —
  // the AI answers in the alert's own thread and what we listen to is inbound_channels.
  test('upsert creates then updates in place; list; get; delete', async () => {
    await upsertSurfaceConfig(__fixture.app.db, __fixture.tenantId, { surface: 'slack' });
    await upsertSurfaceConfig(__fixture.app.db, __fixture.tenantId, {
      surface: __fixture.OTHER_SURFACE,
    });

    const list = await listSurfaceConfigs(__fixture.app.db, __fixture.tenantId);
    expect(list.map((c) => c.surface)).toEqual(['slack', 'teams']); // surface-ordered

    // Upsert updates in place (unique per surface), never duplicating the row.
    await upsertSurfaceConfig(__fixture.app.db, __fixture.tenantId, {
      surface: 'slack',
      botUserId: 'U999',
    });
    expect(
      (await listSurfaceConfigs(__fixture.app.db, __fixture.tenantId)).filter(
        (c) => c.surface === 'slack',
      ),
    ).toHaveLength(1);
    expect((await getSurfaceConfig(__fixture.app.db, __fixture.tenantId, 'slack'))?.botUserId).toBe(
      'U999',
    );

    await deleteSurfaceConfig(__fixture.app.db, __fixture.tenantId, __fixture.OTHER_SURFACE);
    expect(
      await getSurfaceConfig(__fixture.app.db, __fixture.tenantId, __fixture.OTHER_SURFACE),
    ).toBeUndefined();
  });

  const INBOUND_SURFACE = 'slack-inbound' as Surface;
  const PLAIN_SURFACE = 'slack-plain' as Surface;

  test('upsert persists the verified botUserId [C5]', async () => {
    await upsertSurfaceConfig(__fixture.app.db, __fixture.tenantId, {
      surface: INBOUND_SURFACE,
      botUserId: 'U123',
    });
    expect(
      (await getSurfaceConfig(__fixture.app.db, __fixture.tenantId, INBOUND_SURFACE))?.botUserId,
    ).toBe('U123');
  });

  test('botUserId defaults to null when omitted [C2]', async () => {
    await upsertSurfaceConfig(__fixture.app.db, __fixture.tenantId, { surface: PLAIN_SURFACE });
    const cfg = await getSurfaceConfig(__fixture.app.db, __fixture.tenantId, PLAIN_SURFACE);
    expect(cfg).toBeDefined();
    expect(cfg!.botUserId).toBeNull();
  });

  test('re-upsert updates botUserId in place [C5]', async () => {
    await upsertSurfaceConfig(__fixture.app.db, __fixture.tenantId, {
      surface: INBOUND_SURFACE,
      botUserId: 'U123',
    });
    await upsertSurfaceConfig(__fixture.app.db, __fixture.tenantId, {
      surface: INBOUND_SURFACE,
      botUserId: 'U999',
    });
    expect(
      (await getSurfaceConfig(__fixture.app.db, __fixture.tenantId, INBOUND_SURFACE))?.botUserId,
    ).toBe('U999');
  });

  test('persists and updates Slack botId without confusing it with botUserId', async () => {
    await upsertSurfaceConfig(__fixture.app.db, __fixture.tenantId, {
      surface: INBOUND_SURFACE,
      botUserId: 'U123',
      botId: 'B123',
    });
    expect(
      await getSurfaceConfig(__fixture.app.db, __fixture.tenantId, INBOUND_SURFACE),
    ).toMatchObject({
      botUserId: 'U123',
      botId: 'B123',
    });

    await upsertSurfaceConfig(__fixture.app.db, __fixture.tenantId, {
      surface: INBOUND_SURFACE,
      botUserId: 'U123',
      botId: 'B999',
    });
    expect(
      (await getSurfaceConfig(__fixture.app.db, __fixture.tenantId, INBOUND_SURFACE))?.botId,
    ).toBe('B999');
  });

  test('a verified Slack team resolves through one global routing authority and cannot belong to two tenants', async () => {
    const getSurfaceConfigByTeamAndAppId = (
      surfaceRepo as unknown as {
        getSurfaceConfigByTeamAndAppId?: (
          db: DbHandle['db'],
          teamId: string,
          appId: string,
        ) => Promise<
          | {
              tenantId: string;
              teamId: string;
              appId: string;
            }
          | undefined
        >;
      }
    ).getSurfaceConfigByTeamAndAppId;
    expect(getSurfaceConfigByTeamAndAppId).toBeTypeOf('function');

    const teamId = `T${randomUUID().replace(/-/g, '').slice(0, 10)}`;
    const appId = `A${randomUUID().replace(/-/g, '').slice(0, 10)}`;
    const otherTenantId = randomUUID();
    await __fixture.admin.db.insert(tenants).values({ id: otherTenantId, name: 'SURF-OTHER' });
    try {
      await upsertSurfaceConfig(__fixture.app.db, __fixture.tenantId, {
        surface: 'slack',
        teamId,
        appId,
      } as Parameters<typeof upsertSurfaceConfig>[2]);

      await expect(
        getSurfaceConfigByTeamAndAppId!(__fixture.admin.db, teamId, appId),
      ).resolves.toMatchObject({
        tenantId: __fixture.tenantId,
        teamId,
        appId,
      });
      await expect(
        getSurfaceConfigByTeamAndAppId!(__fixture.admin.db, teamId, 'A-DIFFERENT-APP'),
      ).resolves.toBeUndefined();
      await expect(
        upsertSurfaceConfig(__fixture.app.db, otherTenantId, {
          surface: 'slack',
          teamId,
          appId,
        } as Parameters<typeof upsertSurfaceConfig>[2]),
      ).rejects.toThrow();
    } finally {
      await __fixture.admin.db.delete(surfaceConfigs).where(sql`tenant_id = ${otherTenantId}`);
      await __fixture.admin.db.delete(tenants).where(sql`id = ${otherTenantId}`);
    }
  });

  test('startup identity backfill atomically completes only an incomplete legacy row', async () => {
    const surface = 'slack-legacy' as Surface;
    const row = await upsertSurfaceConfig(__fixture.app.db, __fixture.tenantId, { surface });
    const identity = {
      botUserId: 'ULEGACY',
      botId: 'BLEGACY',
      teamId: `T${randomUUID().replace(/-/g, '').slice(0, 10)}`,
      appId: 'ABACKFILLED',
    };

    await expect(
      backfillSlackSurfaceIdentitySystem(__fixture.admin.db, row.id, identity),
    ).resolves.toBe(true);
    expect(await getSurfaceConfig(__fixture.app.db, __fixture.tenantId, surface)).toMatchObject(
      identity,
    );

    await expect(
      backfillSlackSurfaceIdentitySystem(__fixture.admin.db, row.id, {
        ...identity,
        botUserId: 'UOVERWRITE',
      }),
    ).resolves.toBe(false);
    expect(await getSurfaceConfig(__fixture.app.db, __fixture.tenantId, surface)).toMatchObject(
      identity,
    );
  });
});
