import { describe, expect, it } from 'vitest';
import { sanitizeGitLab } from '../sanitize';

describe('sanitizeGitLab', () => {
  it('redacts CI variable values, keeps keys', () => {
    const out = sanitizeGitLab('/api/v4/projects/1/variables', [
      { key: 'DB_PASSWORD', value: 's3cr3t', protected: true },
    ]) as Array<Record<string, unknown>>;
    expect(out[0]?.key).toBe('DB_PASSWORD');
    expect(out[0]?.value).toBe('[REDACTED]');
    expect(out[0]?.protected).toBe(true);
  });

  it('redacts access token values', () => {
    const out = sanitizeGitLab('/api/v4/projects/1/access_tokens', [
      { id: 3, name: 'ci', token: 'glpat-abc' },
    ]) as Array<Record<string, unknown>>;
    expect(out[0]?.token).toBe('[REDACTED]');
    expect(out[0]?.name).toBe('ci');
  });

  it('redacts webhook token and url', () => {
    const out = sanitizeGitLab('/api/v4/projects/1/hooks', [
      { id: 1, url: 'https://x/y?secret=1', token: 't' },
    ]) as Array<Record<string, unknown>>;
    expect(out[0]?.url).toBe('[REDACTED]');
    expect(out[0]?.token).toBe('[REDACTED]');
  });

  it('redacts integration properties values', () => {
    const out = sanitizeGitLab('/api/v4/projects/1/integrations/slack', {
      slug: 'slack',
      properties: { webhook: 'https://hooks/x', token: 'z' },
    }) as Record<string, Record<string, unknown>>;
    expect((out.properties as Record<string, unknown>)?.webhook).toBe('[REDACTED]');
    expect(out.slug).toBe('slack');
  });

  it('leaves non-sensitive endpoints untouched', () => {
    const commits = [{ short_id: 'abc', title: 'fix', author_name: 'A' }];
    expect(sanitizeGitLab('/api/v4/projects/1/repository/commits', commits)).toEqual(commits);
  });

  it('never throws on a malformed body', () => {
    expect(() => sanitizeGitLab('/api/v4/projects/1/variables', null)).not.toThrow();
    expect(sanitizeGitLab('/api/v4/projects/1/variables', 'oops')).toBe('oops');
  });

  it('redacts nested pipeline schedule variable values, keeps keys', () => {
    const out = sanitizeGitLab('/api/v4/projects/1/pipeline_schedules/5', {
      id: 5,
      variables: [{ key: 'K', value: 'secret' }],
    }) as Record<string, unknown>;
    const variables = out.variables as Array<Record<string, unknown>>;
    expect(variables[0]?.value).toBe('[REDACTED]');
    expect(variables[0]?.key).toBe('K');
  });

  it('redacts runners_token on project detail, keeps other fields', () => {
    const out = sanitizeGitLab('/api/v4/projects/1', {
      id: 1,
      name: 'p',
      runners_token: 'glrt-x',
    }) as Record<string, unknown>;
    expect(out.runners_token).toBe('[REDACTED]');
    expect(out.name).toBe('p');
  });

  it('does not redact runners_token spuriously on a project sub-resource', () => {
    const pipelines = [{ id: 9, status: 'failed' }];
    expect(sanitizeGitLab('/api/v4/projects/1/pipelines', pipelines)).toEqual(pipelines);
  });

  it('redacts every value in a multi-item array on a sensitive path, keeps keys', () => {
    const out = sanitizeGitLab('/api/v4/projects/1/variables', [
      { key: 'A', value: '1' },
      { key: 'B', value: '2' },
    ]) as Array<Record<string, unknown>>;
    expect(out[0]?.value).toBe('[REDACTED]');
    expect(out[0]?.key).toBe('A');
    expect(out[1]?.value).toBe('[REDACTED]');
    expect(out[1]?.key).toBe('B');
  });

  it('redacts trigger token values', () => {
    const out = sanitizeGitLab('/api/v4/projects/1/triggers', [{ id: 1, token: 't' }]) as Array<
      Record<string, unknown>
    >;
    expect(out[0]?.token).toBe('[REDACTED]');
  });

  it('redacts impersonation token values, keeps other fields', () => {
    const out = sanitizeGitLab('/api/v4/users/7/impersonation_tokens', [
      { id: 3, name: 'ci-bot', token: 'glpat-imp' },
    ]) as Array<Record<string, unknown>>;
    expect(out[0]?.token).toBe('[REDACTED]');
    expect(out[0]?.name).toBe('ci-bot');
  });

  it('redacts cluster-agent token values', () => {
    const out = sanitizeGitLab('/api/v4/projects/1/cluster_agents/2/tokens', [
      { id: 5, token: 'glagent-x' },
    ]) as Array<Record<string, unknown>>;
    expect(out[0]?.token).toBe('[REDACTED]');
  });

  it('leaves a non-token path untouched (no regression)', () => {
    const commits = [{ short_id: 'abc', title: 'fix', author_name: 'A' }];
    expect(sanitizeGitLab('/api/v4/projects/1/repository/commits', commits)).toEqual(commits);
  });

  it('redacts runner registration token values on the standalone /runners endpoint', () => {
    const out = sanitizeGitLab('/api/v4/projects/1/runners', [{ id: 1, token: 'glrt-x' }]) as Array<
      Record<string, unknown>
    >;
    expect(out[0]?.token).toBe('[REDACTED]');
  });
});
