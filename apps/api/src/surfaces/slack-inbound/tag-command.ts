import {
  addIncidentTagTx,
  listIncidentTagsTx,
  removeIncidentTagByValueTx,
  withTenant,
  type Tx,
} from '@sre/db';
import type { HubMessage } from '@sre/hub';
import type { SlackInboundDeps } from './contracts';
import { incidentAcceptsReplyTx } from './support';

export type IncidentTagCommand =
  { kind: 'add'; tag: string } | { kind: 'remove'; tag: string } | { kind: 'list' };

interface IncidentTagCommandInput {
  deps: SlackInboundDeps;
  tenantId: string;
  incidentId: string;
  content: string;
  authorUserId: string | null;
  command: IncidentTagCommand;
}

/** Parses only explicit incident-tag commands from a Slack mention. */
export function parseIncidentTagCommand(content: string): IncidentTagCommand | null {
  const text = content.trim();
  if (/^tags[.!]?$/i.test(text)) return { kind: 'list' };
  const add = /^tag\s+(.+)$/i.exec(text);
  if (add) return { kind: 'add', tag: add[1]!.trim() };
  const remove = /^untag\s+(.+)$/i.exec(text);
  return remove ? { kind: 'remove', tag: remove[1]!.trim() } : null;
}

/** Executes a tag command and appends its attributed audit messages atomically. */
export function executeIncidentTagCommand(input: IncidentTagCommandInput) {
  const { deps, tenantId, incidentId, content, authorUserId } = input;
  return withTenant(deps.appDb, tenantId, async (tx: Tx) => {
    if (!(await incidentAcceptsReplyTx(tx, tenantId, incidentId)))
      return { archived: true as const };
    const human = await deps.hub.appendTx(tx, tenantId, incidentId, {
      author: 'human',
      content,
      originSurface: 'slack',
      authorUserId,
    });
    const response = await deps.hub.appendTx(tx, tenantId, incidentId, {
      author: 'system',
      kind: 'text',
      content: await commandResponse(tx, input),
    });
    return { archived: false as const, messages: [human, response] satisfies HubMessage[] };
  });
}

async function commandResponse(tx: Tx, input: IncidentTagCommandInput): Promise<string> {
  const { tenantId, incidentId, authorUserId, command } = input;
  if (command.kind === 'list') {
    const tags = await listIncidentTagsTx(tx, tenantId, incidentId);
    return tags.length === 0
      ? 'No tags applied.'
      : `Tags: ${tags.map((row) => row.tag).join(', ')}`;
  }
  if (!authorUserId) return 'Tag not changed: this Slack user is not mapped to a tenant member.';
  try {
    if (command.kind === 'add') {
      const applied = await addIncidentTagTx(tx, tenantId, {
        incidentId,
        tag: command.tag,
        actorUserId: authorUserId,
        source: 'slack',
      });
      return `Tag applied: ${applied.tag}`;
    }
    const removed = await removeIncidentTagByValueTx(tx, tenantId, incidentId, command.tag);
    return removed ? `Tag removed: ${command.tag}` : `Tag not found: ${command.tag}`;
  } catch (error) {
    return `Tag not changed: ${error instanceof Error ? error.message : 'invalid tag'}`;
  }
}
