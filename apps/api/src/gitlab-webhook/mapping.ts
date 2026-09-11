import { createHmac, timingSafeEqual } from 'node:crypto';
import type { GitLabProjectInput, NewDeploy } from '@sre/db';

const SIGNATURE_MAX_AGE_SECONDS = 5 * 60;

export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function identifier(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return value.trim();
  return undefined;
}

function date(value: unknown): Date | undefined {
  const parsed = typeof value === 'string' ? new Date(value) : undefined;
  return parsed && Number.isFinite(parsed.getTime()) ? parsed : undefined;
}

export function sameSecret(supplied: string, expected: string): boolean {
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function validSigningTokenRequest(
  token: string,
  messageId: string,
  timestamp: string,
  body: string,
  suppliedSignatures: string,
  now = Date.now(),
): 'valid' | 'stale' | 'invalid' {
  if (!/^\d+$/.test(timestamp)) return 'invalid';
  const seconds = Number(timestamp);
  if (!Number.isSafeInteger(seconds)) return 'invalid';
  if (Math.abs(Math.floor(now / 1000) - seconds) > SIGNATURE_MAX_AGE_SECONDS) return 'stale';
  let key: Buffer;
  try {
    key = Buffer.from(token.slice('whsec_'.length), 'base64');
  } catch {
    return 'invalid';
  }
  if (!token.startsWith('whsec_') || key.byteLength !== 32) return 'invalid';
  const expected = `v1,${createHmac('sha256', key)
    .update(`${messageId}.${timestamp}.${body}`)
    .digest('base64')}`;
  return suppliedSignatures.split(' ').some((signature) => sameSecret(signature, expected))
    ? 'valid'
    : 'invalid';
}

function projectObject(payload: Record<string, unknown>): Record<string, unknown> {
  const project = object(payload.project);
  return Object.keys(project).length > 0 ? project : object(payload.repository);
}

export function projectPath(payload: Record<string, unknown>): string | undefined {
  return string(projectObject(payload).path_with_namespace) ?? string(payload.path_with_namespace);
}

export function projectId(payload: Record<string, unknown>): string | undefined {
  return identifier(projectObject(payload).id) ?? identifier(payload.project_id);
}

export function withinGroup(fullPath: string | undefined, groupPath: string): boolean {
  if (!fullPath) return true;
  const project = fullPath.toLowerCase();
  const group = groupPath.toLowerCase();
  return project.startsWith(`${group}/`);
}

export function eventAction(
  eventType: string,
  payload: Record<string, unknown>,
): string | undefined {
  const attributes = object(payload.object_attributes);
  if (eventType === 'pipeline') return string(attributes.status);
  if (eventType === 'job') return string(payload.build_status);
  if (eventType === 'deployment') return string(payload.status);
  return string(attributes.action) ?? string(payload.event_name);
}

export function eventRef(eventType: string, payload: Record<string, unknown>): string | undefined {
  const attributes = object(payload.object_attributes);
  if (eventType === 'push' || eventType === 'tag_push') return string(payload.ref);
  if (eventType === 'pipeline') return string(attributes.ref);
  if (eventType === 'job') return string(payload.ref);
  return string(attributes.source_branch) ?? string(attributes.target_branch);
}

export function eventSha(eventType: string, payload: Record<string, unknown>): string | undefined {
  const attributes = object(payload.object_attributes);
  if (eventType === 'push' || eventType === 'tag_push') return string(payload.after);
  if (eventType === 'pipeline') return string(attributes.sha);
  if (eventType === 'job') return string(object(payload.commit).id);
  if (eventType === 'deployment') return string(payload.short_sha);
  if (eventType === 'merge_request') return string(object(attributes.last_commit).id);
  return string(payload.commit_sha);
}

export function eventSummary(
  eventType: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const attributes = object(payload.object_attributes);
  if (eventType === 'push' || eventType === 'tag_push') {
    return {
      ref: string(payload.ref),
      before: string(payload.before),
      after: string(payload.after),
      commitCount:
        typeof payload.total_commits_count === 'number' ? payload.total_commits_count : undefined,
    };
  }
  if (eventType === 'merge_request') {
    return {
      iid: attributes.iid,
      title: string(attributes.title),
      state: string(attributes.state),
      action: string(attributes.action),
      sourceBranch: string(attributes.source_branch),
      targetBranch: string(attributes.target_branch),
      url: string(attributes.url),
    };
  }
  if (eventType === 'pipeline') {
    return {
      id: attributes.id,
      status: string(attributes.status),
      ref: string(attributes.ref),
      sha: string(attributes.sha),
      source: string(attributes.source),
    };
  }
  if (eventType === 'job') {
    return {
      id: payload.build_id,
      name: string(payload.build_name),
      stage: string(payload.build_stage),
      status: string(payload.build_status),
      failureReason: string(payload.build_failure_reason),
    };
  }
  if (eventType === 'deployment') {
    return {
      deploymentId: identifier(payload.deployment_id),
      status: string(payload.status),
      environment: string(payload.environment),
      environmentTier: string(payload.environment_tier),
      environmentUrl: string(payload.environment_external_url),
      commitTitle: string(payload.commit_title),
    };
  }
  if (eventType === 'release') {
    return {
      tag: string(payload.tag),
      name: string(payload.name),
      description: string(payload.description)?.slice(0, 500),
      url: string(payload.url),
    };
  }
  if (eventType === 'resource_access_token') {
    return {
      expiresAt: string(attributes.expires_at),
      tokenId: identifier(attributes.id),
    };
  }
  return { eventName: string(payload.event_name) };
}

export function eventOccurredAt(
  eventType: string,
  payload: Record<string, unknown>,
  fallback: Date,
): Date {
  const attributes = object(payload.object_attributes);
  const value =
    (eventType === 'deployment' ? payload.status_changed_at : undefined) ??
    attributes.updated_at ??
    attributes.created_at ??
    payload.event_time ??
    payload.build_finished_at ??
    payload.build_started_at;
  return date(value) ?? fallback;
}

export function projectInput(
  payload: Record<string, unknown>,
  groupId: string,
): GitLabProjectInput | null {
  const project = projectObject(payload);
  const id = projectId(payload);
  const name = string(project.name) ?? string(payload.name);
  const fullPath = projectPath(payload);
  const webUrl = string(project.web_url) ?? string(project.homepage);
  if (!id || !name || !fullPath || !webUrl) return null;
  const lastActivityAt = date(project.last_activity_at);
  return {
    groupId,
    projectId: id,
    name,
    fullPath,
    defaultBranch: string(project.default_branch),
    visibility: string(project.visibility) ?? string(payload.project_visibility),
    archived: project.archived === true,
    webUrl,
    ...(lastActivityAt ? { lastActivityAt } : {}),
  };
}

export function deploymentRow(
  eventType: string,
  payload: Record<string, unknown>,
  fullPath: string | undefined,
  occurredAt: Date,
): NewDeploy | null {
  if (eventType !== 'deployment' || !fullPath) return null;
  const providerId = identifier(payload.deployment_id);
  const sha = string(payload.short_sha);
  if (!providerId || !sha) return null;
  return {
    source: 'gitlab',
    providerId,
    repo: fullPath,
    ref: null,
    environment: string(payload.environment) ?? null,
    transientEnvironment: false,
    actor: string(object(payload.user).username) ?? null,
    sha,
    service: null,
    status: string(payload.status) ?? 'pending',
    url:
      string(payload.environment_external_url) ??
      string(payload.deployable_url) ??
      string(payload.commit_url) ??
      null,
    deployedAt: occurredAt,
    providerCreatedAt: null,
    providerUpdatedAt: occurredAt,
  };
}
