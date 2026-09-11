import { describe, expect, test } from 'vitest';

import { randomUUID } from 'node:crypto';

import {
  createApproval,
  getApproval,
  getBindingByIncident,
  listSurfaceConfigs,
} from '../surface-repo';

import { createFixture } from './surface-repo.fixture';

const __fixture = createFixture();

describe('tenant scoping', () => {
  test('another tenant sees none of these configs / bindings / approvals', async () => {
    const other = randomUUID();
    const actionId = `scope-${randomUUID().slice(0, 8)}`;
    await createApproval(__fixture.app.db, __fixture.tenantId, {
      incidentId: __fixture.incidentId,
      actionId,
      prompt: 'x',
      options: [{ id: 'approve', label: 'A' }],
    });

    expect(await listSurfaceConfigs(__fixture.app.db, other)).toHaveLength(0);
    expect(
      await getBindingByIncident(__fixture.app.db, other, 'slack', __fixture.incidentId),
    ).toBeUndefined();
    // approvals is RLS-scoped too: the owner sees it, another tenant does not.
    expect(
      await getApproval(__fixture.app.db, __fixture.tenantId, __fixture.incidentId, actionId),
    ).toBeDefined();
    expect(
      await getApproval(__fixture.app.db, other, __fixture.incidentId, actionId),
    ).toBeUndefined();
  });
});
