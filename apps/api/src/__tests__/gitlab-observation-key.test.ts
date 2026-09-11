import { expect, test } from 'vitest';
import { gitLabRevisionKey } from '@sre/connectors';
import { gitLabWebhookObservationKey } from '../gitlab-webhook/observation-key';

test('matches a pipeline API revision independently of delivery transport', () => {
  const at = '2026-09-08T00:00:00.123456Z';
  expect(
    gitLabWebhookObservationKey(
      'pipeline',
      { project: { id: 7 }, object_attributes: { id: 42, status: 'success', updated_at: at } },
      undefined,
    ),
  ).toBe(gitLabRevisionKey('pipeline', '7', '42', 'success', at));
});

test('matches job and deployment provider timestamps, not local receipt times', () => {
  const at = '2026-09-08T00:00:00Z';
  expect(
    gitLabWebhookObservationKey(
      'job',
      { project_id: 7, build_id: 42, build_status: 'failed', build_finished_at: at },
      undefined,
    ),
  ).toBe(gitLabRevisionKey('job', '7', '42', 'failed', at));
  expect(
    gitLabWebhookObservationKey(
      'deployment',
      { project: { id: 7 }, deployment_id: 42, status: 'success', status_changed_at: at },
      undefined,
    ),
  ).toBe(gitLabRevisionKey('deployment', '7', '42', 'success', at));
});

test('requires matching payloads as well as the correlation UUID for recursive hooks', () => {
  const eventId = '00000000-0000-4000-8000-000000000007';
  const payload = {
    event_name: 'push',
    after: 'abc',
    before: 'def',
    project: { id: 7 },
    ref: 'refs/heads/main',
  };
  const key = gitLabWebhookObservationKey('push', payload, eventId);
  expect(key).toBeDefined();
  expect(gitLabWebhookObservationKey('push', JSON.parse(JSON.stringify(payload)), eventId)).toBe(
    key,
  );
  expect(gitLabWebhookObservationKey('push', { ...payload, after: 'different' }, eventId)).not.toBe(
    key,
  );
  expect(gitLabWebhookObservationKey('push', payload, undefined)).toBeUndefined();
  expect(gitLabWebhookObservationKey('push', payload, 'not-a-uuid')).toBeUndefined();
});

test('does not confuse release publication time with revision time', () => {
  expect(
    gitLabWebhookObservationKey(
      'release',
      {
        project: { id: 7 },
        tag: 'v1',
        released_at: '2026-09-08T00:00:00Z',
        object_attributes: { action: 'update' },
      },
      undefined,
    ),
  ).toBeUndefined();
});
