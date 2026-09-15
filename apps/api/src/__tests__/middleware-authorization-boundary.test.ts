import type { Context } from 'hono';
import { describe, expect, test, vi } from 'vitest';
import { requireTenantConfigurationAdmin, type TenantContext } from '../auth';

// Configuration change is the one place the platform distinguishes members from owners and
// administrators, so the gate is exercised here as a plain function over an already-authenticated
// tenant context: no router, no database, nothing that could pass the assertion for another reason.

const FORBIDDEN_BODY = {
  error: 'A workspace owner or administrator must change this configuration.',
};

const MUTATING_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;
const PREFLIGHT_METHODS = ['OPTIONS', 'HEAD', 'TRACE'] as const;

const IMPERSONATION: TenantContext['impersonation'] = {
  sessionId: '5f1b3c8e-5a3d-4c2f-9f2b-1a2b3c4d5e6f',
  reason: 'support escalation',
  tenantName: 'Boundary workspace',
  expiresAt: new Date(Date.now() + 60_000),
};

function tenantContext(overrides: Partial<TenantContext> = {}): TenantContext {
  return {
    tenantId: '6b1f0b4a-9d2e-4a1c-8f3b-0c5d6e7f8a90',
    issuer: 'https://boundary.test.local/',
    sub: 'boundary-subject',
    userId: 'a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
    issuedAt: Math.floor(Date.now() / 1_000),
    expiresAt: Math.floor(Date.now() / 1_000) + 300,
    role: 'member',
    founderOnly: false,
    ...overrides,
  };
}

/**
 * The smallest context the gate can read: the request method and the resolved tenant. `tenant` is
 * optional because the gate defends against a context that carries none, which the declared types
 * say cannot happen.
 */
function syntheticContext(method: string, tenant: TenantContext | undefined): Context {
  const raw = new Request('https://api.boundary.test/connectors/prometheus');
  return {
    req: {
      method,
      path: '/connectors/prometheus',
      url: raw.url,
      raw,
      param: () => undefined,
      header: () => undefined,
    },
    get: (key: string) => (key === 'tenant' ? tenant : undefined),
    set: () => {},
    header: () => {},
    json: (body: unknown, status?: number) =>
      Response.json(body, { status: status ?? 200 }) as unknown as Response,
  } as unknown as Context;
}

async function invoke(
  method: string,
  tenant: TenantContext,
): Promise<{ next: ReturnType<typeof vi.fn>; result: unknown }> {
  const gate = requireTenantConfigurationAdmin();
  const next = vi.fn(async () => {});
  const result = await gate(syntheticContext(method, tenant), next);
  return { next, result };
}

async function expectRefused(method: string, tenant: TenantContext): Promise<void> {
  const { next, result } = await invoke(method, tenant);
  expect(next).not.toHaveBeenCalled();
  expect(result).toBeInstanceOf(Response);
  const response = result as Response;
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual(FORBIDDEN_BODY);
}

async function expectAdmitted(method: string, tenant: TenantContext): Promise<void> {
  const { next, result } = await invoke(method, tenant);
  expect(next).toHaveBeenCalledTimes(1);
  expect(result).not.toBeInstanceOf(Response);
}

describe('tenant configuration change authorization', () => {
  test('a member may still read configuration', async () => {
    await expectAdmitted('GET', tenantContext({ role: 'member' }));
  });

  test.each(MUTATING_METHODS)('a member may not change configuration with %s', async (method) => {
    await expectRefused(method, tenantContext({ role: 'member' }));
  });

  test.each(['owner', 'admin'] as const)(
    'a workspace %s may change configuration with every mutating method',
    async (role) => {
      for (const method of MUTATING_METHODS) {
        await expectAdmitted(method, tenantContext({ role }));
      }
      await expectAdmitted('GET', tenantContext({ role }));
    },
  );

  test.each(MUTATING_METHODS)(
    'an impersonated session may not change configuration with %s',
    async (method) => {
      // applyImpersonation synthesises the administrator role, so the synthesised role alone must
      // never open the write path: a support session reads, it does not reconfigure a workspace.
      await expectRefused(method, tenantContext({ role: 'admin', impersonation: IMPERSONATION }));
    },
  );

  test.each(MUTATING_METHODS)(
    'a context carrying no tenant is refused, not admitted, with %s',
    async (method) => {
      // The gate is typed with TenantAuthVariables, where `tenant` is required, and both mount
      // sites register it directly after authMiddleware, so this state is unreachable today. The
      // clause stays as defence in depth; this pins it fails closed, so a future mount order that
      // loses the tenant refuses the write instead of waving it through.
      const gate = requireTenantConfigurationAdmin();
      const next = vi.fn(async () => {});
      const result = await gate(syntheticContext(method, undefined), next);
      expect(next).not.toHaveBeenCalled();
      expect(result).toBeInstanceOf(Response);
      const response = result as Response;
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual(FORBIDDEN_BODY);
    },
  );

  test.each(PREFLIGHT_METHODS)(
    '%s is never refused, whatever the role or impersonation',
    async (method) => {
      for (const role of ['owner', 'admin', 'member'] as const) {
        await expectAdmitted(method, tenantContext({ role }));
        await expectAdmitted(method, tenantContext({ role, impersonation: IMPERSONATION }));
      }
    },
  );
});
