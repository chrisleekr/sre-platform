import { scrubSecrets, type ToolDefinition } from '@sre/agent-tools';
import * as z from 'zod';
import type { EvidenceReceipt } from './evidence-closure';
import type { InvestigationEvidence, TriageRuntime } from './types';

const readSchema = z.object({ evidenceId: z.uuid(), offset: z.number().int().min(0).default(0) });
const CHUNK_CHARACTERS = 4_000;

/** Expose admitted durable records without binding any provider or remediation tools.
 * @param runtime - Tenant/incident-bound evidence reader.
 * @param receipts - Records admitted before finalization.
 * @param prior - Authorized context already supplied to the engine.
 */
export function recordedEvidenceTool(
  runtime: TriageRuntime,
  receipts: EvidenceReceipt[],
  prior: InvestigationEvidence[],
): ToolDefinition<z.infer<typeof readSchema>, unknown> {
  const allowed = new Set(receipts.map((receipt) => receipt.evidenceId));
  const cached = new Map(
    prior.flatMap((evidence) => (evidence.id ? [[evidence.id, evidence] as const] : [])),
  );
  return {
    name: 'read_recorded_evidence',
    description:
      'Read a bounded slice of a durable evidence record from this incident by its original evidenceId, including older IDs found by search. Use nextOffset until null. This never queries external providers.',
    inputSchema: readSchema,
    async handler(_ctx, { evidenceId, offset }) {
      // The runtime reader enforces tenant and incident ownership, not prompt-window membership.
      const evidence = runtime.readEvidence
        ? await runtime.readEvidence(evidenceId)
        : allowed.has(evidenceId)
          ? cached.get(evidenceId)
          : null;
      if (!evidence || evidence.id !== evidenceId) return { available: false, reason: 'error' };
      const text = scrubSecrets(JSON.stringify(evidence));
      return {
        available: true,
        data: {
          evidenceId,
          offset,
          totalCharacters: text.length,
          text: text.slice(offset, offset + CHUNK_CHARACTERS),
          nextOffset: offset + CHUNK_CHARACTERS < text.length ? offset + CHUNK_CHARACTERS : null,
        },
      };
    },
  };
}

/** Inventory preserves original IDs even when rendered evidence exceeds prompt capacity.
 * @param receipts - Durable evidence receipts from exploration and prior context.
 */
export function recordedEvidenceInventory(receipts: EvidenceReceipt[]): string {
  return receipts
    .map((receipt) => `${receipt.evidenceId}: ${receipt.tool} (${receipt.outcome})`)
    .join('\n');
}
