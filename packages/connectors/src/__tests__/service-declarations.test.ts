import { expect, test } from 'vitest';
import { topologyRelationKey } from '@sre/contracts';
import { serviceDeclarations } from '../service-declarations';

const repo = { authority: 'repository:git.example', kind: 'repository', id: 'team/app' };
const revision = 'a'.repeat(40);
const descriptor = (name: string, dependencies = '') => `apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: ${name}
  namespace: commerce
  annotations:
    private: never-retain
spec:
  type: service
  lifecycle: production
  owner: team
${dependencies}`;

test('projects multi-service declarations with pinned provenance, not a runtime environment', () => {
  const result = serviceDeclarations(
    repo,
    'apps/catalog-info.yaml',
    revision,
    `${descriptor('checkout', '  dependsOn: [component:commerce/payments]')}\n---\n${descriptor('payments')}`,
  );
  expect(result.entities).toHaveLength(2);
  expect(result.entities[0]).toMatchObject({
    name: 'checkout',
    kind: 'service',
    scope: { serviceNamespace: 'commerce' },
  });
  expect(result.entities[0]!.scope.environment).toBeUndefined();
  const dependency = result.relations.find((relation) => relation.kind === 'depends_on')!;
  expect(dependency).toMatchObject({
    from: result.entities[0]!.ref,
    to: result.entities[1]!.ref,
    evidence: 'declared',
  });
  expect(result.relations.filter((relation) => relation.kind === 'declared_in')).toHaveLength(2);
  expect(
    result.relations.some((relation) =>
      ['calls', 'runs_on', 'deployed_from'].includes(relation.kind),
    ),
  ).toBe(false);
  expect(JSON.stringify(result)).not.toContain('never-retain');
});

test('same names in different repositories cannot silently merge', () => {
  const first = serviceDeclarations(repo, 'catalog-info.yaml', revision, descriptor('checkout'));
  const second = serviceDeclarations(
    { ...repo, id: 'other/app' },
    'catalog-info.yaml',
    revision,
    descriptor('checkout'),
  );
  expect(first.entities[0]!.ref).not.toEqual(second.entities[0]!.ref);
});

test.each([
  'metadata: [invalid',
  `${descriptor('checkout')}\n---\n${descriptor('checkout')}`,
  `${descriptor('checkout')}\nmetadata: { name: overridden }`,
  `bad: &anchor [one]\ncopy: *anchor\n${descriptor('checkout')}`,
  descriptor('../invalid'),
  'x'.repeat(65537),
])(
  'rejects malformed, duplicate, aliased or oversized source without partial identity promotion',
  (text) => {
    expect(() => serviceDeclarations(repo, 'catalog-info.yaml', revision, text)).toThrow();
  },
);

test('does not follow locations, substitutions, or promote libraries to services', () => {
  const text = `apiVersion: backstage.io/v1alpha1\nkind: Location\nspec:\n  targets: [https://private.example/metadata]\n---\n${descriptor('library').replace('type: service', 'type: library')}`;
  expect(serviceDeclarations(repo, 'catalog-info.yaml', revision, text)).toEqual({
    entities: [],
    relations: [],
  });
});

test('normalizes repeated dependency references without duplicate relation identities', () => {
  const result = serviceDeclarations(
    repo,
    'catalog-info.yaml',
    revision,
    descriptor('checkout', '  dependsOn: [component:commerce/db, db, db, COMPONENT:COMMERCE/DB]'),
  );
  expect(result.relations).toHaveLength(2);
  expect(new Set(result.relations.map(topologyRelationKey)).size).toBe(result.relations.length);
  expect(result.relations.filter((edge) => edge.kind === 'depends_on')).toEqual([
    expect.objectContaining({ to: expect.objectContaining({ id: '["commerce","db"]' }) }),
  ]);
});
