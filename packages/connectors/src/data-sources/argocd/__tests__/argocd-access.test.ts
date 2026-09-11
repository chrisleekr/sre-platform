import { describe, expect, test } from 'vitest';
import { argoCdAccessCommands, generateArgoCdAccess } from '../access';

describe('generateArgoCdAccess', () => {
  test('creates a project-scoped role instead of a global local account', () => {
    const instructions = generateArgoCdAccess({
      project: 'payments',
      applicationsInAnyNamespace: false,
      applications: [{ name: 'checkout' }, { name: 'orders' }],
    });

    expect(instructions).toEqual({
      project: 'payments',
      role: 'sre-platform',
      identity: 'proj:payments:sre-platform',
      policies: [
        'p, proj:payments:sre-platform, applications, get, payments/checkout, allow',
        'p, proj:payments:sre-platform, logs, get, payments/checkout, allow',
        'p, proj:payments:sre-platform, applications, get, payments/orders, allow',
        'p, proj:payments:sre-platform, logs, get, payments/orders, allow',
      ],
      tokenCommand:
        "argocd proj role create-token 'payments' 'sre-platform' --expires-in 8760h --token-only",
    });
    expect(JSON.stringify(instructions)).not.toContain('accounts.');
    expect(JSON.stringify(instructions)).not.toContain('policy.csv');
  });

  test('uses project-relative namespace/name objects in any-namespace mode', () => {
    const instructions = generateArgoCdAccess({
      project: 'payments',
      applicationsInAnyNamespace: true,
      applications: [{ namespace: 'team-a', name: '*' }],
    });
    expect(instructions.policies).toEqual([
      'p, proj:payments:sre-platform, applications, get, payments/team-a/*, allow',
      'p, proj:payments:sre-platform, logs, get, payments/team-a/*, allow',
    ]);
  });

  test('isolates provider access with a source-specific role', () => {
    const instructions = generateArgoCdAccess({
      project: 'payments',
      role: 'sre-platform-a1b2c3d4',
      applicationsInAnyNamespace: false,
      applications: [{ name: 'checkout' }],
    });

    expect(instructions.role).toBe('sre-platform-a1b2c3d4');
    expect(instructions.identity).toBe('proj:payments:sre-platform-a1b2c3d4');
    expect(instructions.policies).toContain(
      'p, proj:payments:sre-platform-a1b2c3d4, applications, get, payments/checkout, allow',
    );
    expect(argoCdAccessCommands(instructions).uninstall).toBe(
      "argocd proj role delete 'payments' 'sre-platform-a1b2c3d4'",
    );
  });

  test('requires a concrete project and rejects injected or oversized segments', () => {
    for (const request of [
      { project: '*', applications: [{ name: '*' }] },
      { project: 'payments, admin', applications: [{ name: '*' }] },
      { project: 'a'.repeat(254), applications: [{ name: '*' }] },
      { project: 'payments', applications: [{ name: 'a'.repeat(254) }] },
      { project: 'payments', role: 'bad,role', applications: [{ name: '*' }] },
      { project: 'payments', role: '*', applications: [{ name: '*' }] },
    ])
      expect(() =>
        generateArgoCdAccess({
          project: request.project,
          role: 'role' in request ? request.role : undefined,
          applicationsInAnyNamespace: false,
          applications: request.applications,
        }),
      ).toThrow(/project|required|application|role/);
  });

  test('install and uninstall only mutate the selected AppProject role', () => {
    const commands = argoCdAccessCommands(
      generateArgoCdAccess({
        project: 'payments',
        applicationsInAnyNamespace: false,
        applications: [{ name: 'checkout' }],
      }),
    );
    expect(commands.install).toContain(
      "argocd proj role create 'payments' 'sre-platform' --description 'Read-only incident investigation'",
    );
    expect(commands.install).toContain(
      "argocd proj role add-policy 'payments' 'sre-platform' --resource 'applications' --action 'get' --object 'checkout' --permission 'allow'",
    );
    expect(commands.install).toContain("--resource 'logs'");
    expect(commands.createRole).toBe(
      "argocd proj role create 'payments' 'sre-platform' --description 'Read-only incident investigation'",
    );
    expect(commands.createRole).not.toContain('add-policy');
    expect(commands.addPolicies).toBe(
      [
        "argocd proj role add-policy 'payments' 'sre-platform' --resource 'applications' --action 'get' --object 'checkout' --permission 'allow'",
        "argocd proj role add-policy 'payments' 'sre-platform' --resource 'logs' --action 'get' --object 'checkout' --permission 'allow'",
      ].join('\n'),
    );
    expect(commands.addPolicies).not.toContain('role create');
    expect(commands.install).not.toContain('kubectl');
    expect(commands.install).not.toContain('argocd-cm');
    expect(commands.uninstall).toBe("argocd proj role delete 'payments' 'sre-platform'");
  });
});
