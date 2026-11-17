import { describe, expect, test } from 'vitest';
import { activityLine } from '../fanout-support';
import { createFixture } from './fanout.fixture';

const { msg } = createFixture();

describe('activityLine', () => {
  test('drops the connector instance key from the activity line', () => {
    // The instance key is 22 chars and may contain `_` and `-`, so it must not leak into Slack text.
    const key = 'Ab_cd-EFghIJklMNopQRsU';
    expect(key).toHaveLength(22);
    const step = (content: string) => activityLine(msg({ kind: 'tool_step', content }));
    expect(step(`statuscake_${key}_get_uptime_periods {"id":"77"}`)).toBe(
      '🔍 Running statuscake get uptime periods…',
    );
    expect(step('read_topology_endpoint_evidence {"id":"77"}')).toBe(
      '🔍 Running read topology endpoint evidence…',
    );
    expect(step('search_incident_evidence {"q":"x"}')).toBe('🔍 Running search incident evidence…');
    expect(step('get_logs {"s":"x"}')).toBe('🔍 Running get logs…');
  });
});
