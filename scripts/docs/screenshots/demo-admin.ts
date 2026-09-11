import { randomUUID } from 'node:crypto';
import {
  grantAdminRole,
  identityProviders,
  memberships,
  rejectAdminFounding,
  setAdminUserStatus,
  signOutAdminUser,
  updateAdminProvider,
  users,
  workspaceFoundings,
} from '../../../packages/db/src/index';
import type { DemoSeedDeps } from './demo-environment';

/** Seeds administration examples in the disposable screenshot database.
 * @param deps - Demo database, workspace, actor, and timestamp anchor.
 */
export async function seedAdministration(deps: DemoSeedDeps): Promise<void> {
  const { adminDb, userId: actorUserId, tenantId, now } = deps;
  const ago = (hours: number) => new Date(now.getTime() - hours * 3_600_000);
  const providers = [
    { name: 'Staff directory', host: 'staff.example.test', signup: false },
    { name: 'Workspace sign-in', host: 'accounts.example.test', signup: true },
    { name: 'Legacy directory', host: 'legacy.example.test', signup: false },
  ].map((provider) => ({ ...provider, id: randomUUID() }));
  await adminDb.insert(identityProviders).values(
    providers.map((provider) => ({
      id: provider.id,
      displayName: provider.name,
      issuer: `https://${provider.host}/`,
      jwksUri: `https://${provider.host}/.well-known/jwks.json`,
      authorizationEndpoint: `https://${provider.host}/authorize`,
      tokenEndpoint: `https://${provider.host}/token`,
      audience: 'https://api.sre-platform/',
      browserClientId: 'documentation-demo',
      kind: 'oidc' as const,
      scope: 'installation' as const,
      supportsSignup: provider.signup,
      status: 'active' as const,
      createdAt: ago(720),
    })),
  );

  const people = [
    'alex.chen',
    'morgan.patel',
    'sam.rivera',
    'jordan.kim',
    'casey.lee',
    'taylor.reed',
  ].map((name, index) => ({
    id: randomUUID(),
    issuer: `https://${providers[index < 3 ? 0 : 1]!.host}/`,
    subject: name,
    email: `${name}@example.test`,
    createdAt: ago(168 + index * 24),
    lastSignInAt: ago(index + 1),
  }));
  await adminDb.insert(users).values(people);
  await adminDb.insert(memberships).values(
    people.slice(0, 3).map((person, index) => ({
      userId: person.id,
      tenantId,
      role: index === 0 ? ('admin' as const) : ('member' as const),
    })),
  );

  const registrations = [
    { name: 'Payments engineering', slug: 'payments-engineering', status: 'pending' as const },
    { name: 'Commerce operations', slug: 'commerce-operations', status: 'pending' as const },
    { name: 'Fulfilment services', slug: 'fulfilment-services', status: 'failed' as const },
    { name: 'Duplicate sandbox', slug: 'duplicate-sandbox', status: 'pending' as const },
  ].map((registration) => ({ ...registration, id: randomUUID() }));
  await adminDb.insert(workspaceFoundings).values(
    registrations.map((registration, index) => ({
      id: registration.id,
      path: 'hosted',
      slug: registration.slug,
      requestedName: registration.name,
      providerId: providers[1]!.id,
      founderUserId: people[3 + (index % 3)]!.id,
      status: registration.status,
      failureReason:
        registration.status === 'failed'
          ? 'Workspace provisioning timed out. Retry provisioning.'
          : null,
      createdAt: ago(index + 1),
      updatedAt: ago(index + 0.5),
    })),
  );

  // Real mutations produce matching state and audit records.
  await grantAdminRole(adminDb, {
    actorUserId,
    userId: people[0]!.id,
    reason: 'Added to the platform support rotation.',
  });
  await signOutAdminUser(adminDb, {
    actorUserId,
    userId: people[1]!.id,
    reason: 'Session reset requested after replacing a workstation.',
  });
  await setAdminUserStatus(adminDb, {
    actorUserId,
    userId: people[2]!.id,
    status: 'disabled',
    reason: 'Contract ended. Access removed during offboarding.',
  });
  await updateAdminProvider(adminDb, {
    actorUserId,
    providerId: providers[0]!.id,
    patch: { backchannelLogout: true },
    reason: 'Enable session revocation from the staff directory.',
  });
  await updateAdminProvider(adminDb, {
    actorUserId,
    providerId: providers[2]!.id,
    patch: { status: 'disabled' },
    reason: 'Directory migration completed. Legacy sign-in retired.',
  });
  await rejectAdminFounding(adminDb, {
    actorUserId,
    foundingId: registrations[3]!.id,
    reason: 'Duplicate request. Use the existing engineering workspace.',
  });
}
