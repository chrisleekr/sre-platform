import { encodeForModel } from './toon';
import type { ToolResult } from '@sre/agent-tools';
import type { EvidenceReceipt } from './evidence-closure';

/**
 * Cap on the characters of one rendered tool result fed back to the model.
 *
 * Both engine runtimes render through `renderModelToolResult`, so the cap lives beside it rather
 * than beside either caller: two independent definitions agreed by coincidence, and a substantial
 * minority of real tool results sit exactly at this value, so a silent divergence would change what
 * one runtime shows the model and not the other.
 *
 * Env-tunable so the budget can rise once TOON's tabular compaction frees room. Guarded like its
 * siblings (`EVIDENCE_BUDGET_CHARS`, `triageContextWindowMin`): a non-numeric or non-positive env
 * must fall back, never yield NaN, since `encoded.length <= NaN` is false and would send every
 * payload down the truncation branch.
 */
const DEFAULT_TOOL_RESULT_MAX_CHARS = 6000;

/** Resolve the per-result character cap both engine runtimes render against. */
export function toolResultMaxChars(): number {
  const configured = Number(process.env.TOOL_RESULT_MAX_CHARS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_TOOL_RESULT_MAX_CHARS;
}

export interface ModelToolResult {
  content: string;
  isError: boolean;
  receipt: EvidenceReceipt;
}

/** Render one safe, bounded model result without presenting a cut payload as complete data. */
export function renderModelToolResult(
  tool: string,
  result: ToolResult<unknown>,
  maxCharacters: number,
): ModelToolResult {
  if (!result.available) {
    return {
      content: `error: tool failed; evidenceId: ${result.evidenceId}`,
      isError: true,
      receipt: { evidenceId: result.evidenceId, tool, outcome: 'unavailable' },
    };
  }

  const encoded = encodeForModel({ evidenceId: result.evidenceId, data: result.data });
  if (encoded.length <= maxCharacters) {
    return {
      content: encoded,
      isError: false,
      receipt: { evidenceId: result.evidenceId, tool, outcome: 'complete' },
    };
  }

  const header =
    `evidenceId: ${result.evidenceId}\n` +
    'completeness: truncated\n' +
    `totalCharacters: ${encoded.length}\n` +
    'instruction: narrow the query or reduce its limit before claiming absence\n' +
    'dataExcerpt:\n';
  const excerpt = encoded.slice(0, Math.max(0, maxCharacters - header.length));
  return {
    content: `${header}${excerpt}`.slice(0, maxCharacters),
    isError: false,
    receipt: { evidenceId: result.evidenceId, tool, outcome: 'partial' },
  };
}
