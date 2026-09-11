import type { DbHandle } from '@sre/db';
import type { ConversationHub } from '@sre/hub';
import type { Queue } from '@sre/queue';
import type { Redis } from 'ioredis';
import type { SlackInboundDeps } from '../slack-inbound';

export interface SlackInboundFixtureState {
  admin: DbHandle;
  app: DbHandle;
  redis: Redis;
  hub: ConversationHub;
  baseDeps: SlackInboundDeps;
  tenantId: string;
  tenantB: string;
  slackConfigId: string;
  incidentId: string;
  approvalId: string;
  approvalIdB: string;
  realQueue: Queue;
  coalesceDeps: SlackInboundDeps;
  classifyConfigId: string;
  classifyDeps: SlackInboundDeps;
  classifyShouldThrow: boolean;
  tsSeq: number;
  mentionIncidentId: string;
  resumeIncidentId: string;
  attrMemberUserId: string;
  attrIncidentC1: string;
  attrIncidentC2: string;
  attrIncidentC3: string;
  attrIncidentC4: string;
  attrDeps: SlackInboundDeps;
  usersInfoImpl: (tenantId: string, slackUserId: string) => Promise<string | null>;
  attrIncidentNeg: string;
  attrIncidentRejoin: string;
  attrIncidentMember: string;
  attrIncidentDown: string;
  attrIncidentDownMiss: string;
  brokenRedis: Redis;
  downDeps: SlackInboundDeps;
}

/** Creates the mutable handles shared by the split Slack inbound test suite. */
export function createSlackInboundFixtureState(): SlackInboundFixtureState {
  return {
    admin: undefined as unknown as DbHandle,
    app: undefined as unknown as DbHandle,
    redis: undefined as unknown as Redis,
    hub: undefined as unknown as ConversationHub,
    baseDeps: undefined as unknown as SlackInboundDeps,
    tenantId: '',
    tenantB: '',
    slackConfigId: '',
    incidentId: '',
    approvalId: '',
    approvalIdB: '',
    realQueue: undefined as unknown as Queue,
    coalesceDeps: undefined as unknown as SlackInboundDeps,
    classifyConfigId: '',
    classifyDeps: undefined as unknown as SlackInboundDeps,
    classifyShouldThrow: false,
    tsSeq: 0,
    mentionIncidentId: '',
    resumeIncidentId: '',
    attrMemberUserId: '',
    attrIncidentC1: '',
    attrIncidentC2: '',
    attrIncidentC3: '',
    attrIncidentC4: '',
    attrDeps: undefined as unknown as SlackInboundDeps,
    usersInfoImpl: async () => null,
    attrIncidentNeg: '',
    attrIncidentRejoin: '',
    attrIncidentMember: '',
    attrIncidentDown: '',
    attrIncidentDownMiss: '',
    brokenRedis: undefined as unknown as Redis,
    downDeps: undefined as unknown as SlackInboundDeps,
  };
}
