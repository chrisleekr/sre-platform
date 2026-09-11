import { expect, test } from 'vitest';
import { parseGitLabSettings, publicGitLabSettings } from '../connectors/provider-state';

const settings = {
  baseUrl: 'https://gitlab.example.com',
  groupId: 7,
  groupPath: 'platform',
  eventTransport: 'direct',
};
test.each(['group', 'projects'] as const)(
  'retains %s webhook scope in saved and public settings',
  (hookScope) => {
    expect(parseGitLabSettings({ ...settings, hookScope })).toMatchObject({ hookScope });
    expect(publicGitLabSettings({ ...settings, hookScope }, null)).toMatchObject({ hookScope });
  },
);
test('does not invent an unknown legacy hook scope or accept invalid scope', () => {
  expect(parseGitLabSettings(settings)).not.toHaveProperty('hookScope');
  expect(parseGitLabSettings({ ...settings, hookScope: 'all' })).toBeNull();
});
test.each(['group', 'managed_projects', 'system'] as const)(
  'preserves %s strategy independently of transport',
  (eventStrategy) => {
    for (const eventTransport of ['direct', 'smee', 'none']) {
      expect(
        publicGitLabSettings({ ...settings, eventTransport, eventStrategy }, null),
      ).toMatchObject({ eventStrategy, eventTransport });
    }
  },
);
test('does not enroll legacy connectors in managed hooks', () => {
  expect(parseGitLabSettings({ ...settings, hookScope: 'projects' })).not.toHaveProperty(
    'eventStrategy',
  );
  expect(parseGitLabSettings({ ...settings, eventStrategy: 'instance' })).toBeNull();
});
