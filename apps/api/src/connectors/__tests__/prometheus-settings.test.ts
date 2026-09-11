import { expect, test } from 'vitest';

import { EPISODE_GROUPING_WINDOW_DEFAULT_SEC, INCIDENT_MAX_AGE_DEFAULT_SEC } from '@sre/contracts';

import { episodeGroupingPolicy } from '../../alertmanager-webhook/normalize';
import { parsePrometheusSettings } from '../observability-argocd';

const base = {
  baseUrl: 'https://prometheus.example',
  authType: 'none',
  eventTransport: 'none',
};

test('applies bounded episode correlation defaults to legacy Prometheus settings', () => {
  expect(parsePrometheusSettings(base)).toMatchObject({
    episodeGroupingWindowSec: EPISODE_GROUPING_WINDOW_DEFAULT_SEC,
    maxIncidentAgeSec: INCIDENT_MAX_AGE_DEFAULT_SEC,
  });
});

test.each([
  { episodeGroupingWindowSec: 299 },
  { episodeGroupingWindowSec: 3_601 },
  { maxIncidentAgeSec: 3_599 },
  { maxIncidentAgeSec: 86_401 },
])(
  'rejects unsafe episode correlation bounds: $episodeGroupingWindowSec $maxIncidentAgeSec',
  (over) => {
    expect(parsePrometheusSettings({ ...base, ...over })).toBeNull();
  },
);

test('accepts an explicit grouping policy within the documented bounds', () => {
  expect(
    parsePrometheusSettings({
      ...base,
      episodeGroupingWindowSec: 15 * 60,
      maxIncidentAgeSec: 6 * 60 * 60,
    }),
  ).toMatchObject({ episodeGroupingWindowSec: 900, maxIncidentAgeSec: 21_600 });
});

test('runtime routing falls back safely when legacy stored bounds are invalid', () => {
  expect(episodeGroupingPolicy({ episodeGroupingWindowSec: -1, maxIncidentAgeSec: 1 })).toEqual({
    groupingWindowMs: EPISODE_GROUPING_WINDOW_DEFAULT_SEC * 1_000,
    maxIncidentAgeMs: INCIDENT_MAX_AGE_DEFAULT_SEC * 1_000,
  });
});
