import { expect, test } from 'vitest';
import { CONNECTOR_TYPES, connectorCapabilities } from '../catalog';
import { defaultRegistry } from '../registry-default';

test.each(CONNECTOR_TYPES)(
  '%s declares alert lifecycle coverage independently of generic events',
  (type) => {
    expect(connectorCapabilities(type)).toHaveProperty('alertLifecycle');
  },
);

test.each(['statuscake', 'datadog', 'grafana', 'prometheus'] as const)(
  '%s exposes executable lifecycle support, not only investigation tools',
  (type) => {
    const connector = defaultRegistry().create({
      id: '00000000-0000-4000-8000-000000000373',
      tenantId: 'lifecycle-acceptance',
      name: `${type} lifecycle acceptance`,
      type,
      settings: {},
      getCredential: async () => 'fixture-only',
    });
    expect(connector).toHaveProperty('alertLifecycle');
    expect(Reflect.get(connector, 'alertLifecycle')).toBeTruthy();
  },
);
