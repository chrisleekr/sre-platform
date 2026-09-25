import { runTool, redactInput, type ToolContext, type ToolDefinition } from '@sre/agent-tools';
import { REPORT_FINDINGS_NAME, parseReportFindings, reportFindingsTool } from './report-findings';
import { RESPOND_NAME, parseRespond, respondTool } from './respond';
import { STAY_SILENT_NAME, parseStaySilent, staySilentTool } from './stay-silent';
import {
  SUGGEST_ACTION_NAME,
  buildRecommendedAction,
  suggestActionSchema,
  suggestActionTool,
} from './suggest-action';
import { REPORT_RECOVERY_NAME, parseReportRecovery, reportRecoveryTool } from './report-recovery';
import type {
  RankedHypothesis,
  TerminalOutcome,
  TranscriptKind,
  TriageResult,
  TriageRuntime,
} from './types';
import type { InvestigationGap } from '@sre/contracts';
import { evidenceClosureDecision, type EvidenceReceipt } from './evidence-closure';
import { renderModelToolResult, toolResultMaxChars } from './tool-result';
import { recordedEvidenceTool, recordedEvidenceInventory } from './recorded-evidence';

/** The engine-local terminal tools the loop intercepts. */
export type TerminalName =
  | typeof REPORT_FINDINGS_NAME
  | typeof RESPOND_NAME
  | typeof STAY_SILENT_NAME
  | typeof SUGGEST_ACTION_NAME
  | typeof REPORT_RECOVERY_NAME;

const TERMINAL_BY_NAME: Record<TerminalName, ToolDefinition<any, any>> = {
  [REPORT_FINDINGS_NAME]: reportFindingsTool,
  [RESPOND_NAME]: respondTool,
  [STAY_SILENT_NAME]: staySilentTool,
  [SUGGEST_ACTION_NAME]: suggestActionTool,
  [REPORT_RECOVERY_NAME]: reportRecoveryTool,
};

/**
 * The provider seam. Messages are opaque `unknown` to the loop: only the provider
 * builds and reads them, so the same loop core drives Claude Messages and OpenAI Chat Completions.
 */
export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
  /** The provider could not decode the model's arguments into a value. */
  invalidInput?: boolean;
}

export interface ModelTurn {
  /** Concatenated assistant text for this turn (empty when the turn is pure tool calls). */
  text: string;
  toolCalls: ToolCall[];
  stopReason: string;
  /** The assistant message to append verbatim before the tool results (provider-shaped). */
  assistantMsg: unknown;
}

export interface ToolRunResult {
  id: string;
  content: string;
  isError: boolean;
}

export interface LoopProvider {
  toolSpecs(tools: ToolDefinition<any, any>[]): unknown;
  userMsg(text: string): unknown;
  /**
   * `forceTool` names the terminal tool on a bounded finalization turn. OpenAI sends it as the named
   * tool choice; Claude ignores it because Opus 5.5 rejects forced tool choice, and the loop validates
   * the terminal call itself.
   */
  call(
    system: string,
    messages: unknown[],
    toolSpecs: unknown,
    forceTool?: string,
    signal?: AbortSignal,
  ): Promise<ModelTurn>;
  toolResultMsgs(results: ToolRunResult[]): unknown[];
}

export interface RunLoopArgs {
  provider: LoopProvider;
  system: string;
  initialUser: string;
  tools: ToolDefinition<any, any>[];
  ctx: ToolContext;
  onStep(kind: TranscriptKind, content: string): Promise<void>;
  maxTurns: number;
  /** The caller states the path; the terminal set is a consequence of it, not evidence for it. */
  path: 'investigate' | 'resume' | 'recovery';
  /** The engine provider label recorded on the result (e.g. 'claude'). */
  engineProvider: string;
  sessionId: string;
  model?: string;
  /**
   * Which terminal tools to bind and intercept. Investigate binds `report_findings`; normal resume
   * adds `respond`, `stay_silent`, and `suggest_action`; a cleared-signal resume also adds
   * `report_recovery`; dedicated recovery binds only `report_recovery`.
   */
  terminals?: TerminalName[];
  /** Durable evidence already supplied in the resume/recovery prompt. */
  priorEvidence?: import('./types').InvestigationEvidence[];
  readEvidence?: TriageRuntime['readEvidence'];
  onExecutionMetadata?: TriageRuntime['onExecutionMetadata'];
  onEvidenceReceipt?: TriageRuntime['onEvidenceReceipt'];
  signal?: AbortSignal;
}

const DEGRADED_SUMMARY = 'Investigation did not converge on a root cause.';

function buildResult(
  args: RunLoopArgs,
  fields: {
    disposition?: 'rca' | 'reply' | 'silent';
    summary: string;
    confidence: number;
    rankedHypotheses: RankedHypothesis[];
    unknowns?: InvestigationGap[];
    causalFindings?: TriageResult['causalFindings'];
    causeTagSuggestions?: TriageResult['causeTagSuggestions'];
    nextStep?: string | null;
    detail?: string;
    replyPurpose?: TriageResult['replyPurpose'];
    currentState?: string | null;
    impact?: string | null;
    evidenceIds?: string[];
    outcome: TerminalOutcome;
  },
): TriageResult {
  return {
    provider: args.engineProvider,
    sessionId: args.sessionId,
    model: args.model,
    outcome: fields.outcome,
    turnBudget: args.maxTurns,
    ...(fields.disposition ? { disposition: fields.disposition } : {}),
    detail: fields.detail,
    ...(fields.replyPurpose ? { replyPurpose: fields.replyPurpose } : {}),
    summary: fields.summary,
    confidence: fields.confidence,
    rankedHypotheses: fields.rankedHypotheses,
    ...(fields.currentState !== undefined ? { currentState: fields.currentState } : {}),
    ...(fields.impact !== undefined ? { impact: fields.impact } : {}),
    ...(fields.evidenceIds !== undefined ? { evidenceIds: fields.evidenceIds } : {}),
    ...(fields.unknowns !== undefined ? { unknowns: fields.unknowns } : {}),
    ...(fields.causalFindings !== undefined ? { causalFindings: fields.causalFindings } : {}),
    ...(fields.causeTagSuggestions !== undefined
      ? { causeTagSuggestions: fields.causeTagSuggestions }
      : {}),
    ...(fields.nextStep !== undefined ? { nextStep: fields.nextStep } : {}),
  };
}

/**
 * Map a validated terminal call to a discriminated `TriageResult`. `report_findings` concludes with
 * an RCA, `respond` replies, `stay_silent` records a note, and `suggest_action` creates a recommendation
 * for the existing approval rail. Confidence is RCA-only, so the other dispositions carry 0.
 */
function interpretTerminal(args: RunLoopArgs, call: ToolCall): TriageResult {
  if (call.name === REPORT_RECOVERY_NAME) {
    const recovery = parseReportRecovery(call.input);
    return {
      provider: args.engineProvider,
      sessionId: args.sessionId,
      model: args.model,
      outcome: 'conclusive',
      turnBudget: args.maxTurns,
      disposition: 'recovery',
      summary: recovery.summary,
      confidence: 0,
      rankedHypotheses: [],
      recovery: {
        outcome: recovery.outcome,
        recovered: recovery.recovered,
        evidence: recovery.evidence,
        evidenceIds: recovery.evidenceIds,
        unknowns: recovery.unknowns,
        ...(recovery.questions !== undefined ? { questions: recovery.questions } : {}),
        nextStep: recovery.nextStep,
        recheckAfterMinutes: recovery.recheckAfterMinutes,
        scheduleReason: recovery.scheduleReason,
      },
    };
  }
  if (call.name === SUGGEST_ACTION_NAME) {
    const { prompt, options } = buildRecommendedAction(suggestActionSchema.parse(call.input));
    // The engine returns only the PROPOSAL; the approvals idempotency key is a persistence concern the
    // worker derives from the SCRUBBED prompt/options (worker.ts). Never key on call.id: Anthropic mints a
    // fresh `toolu_*` id on every response, so a redelivered turn keyed on it would open a second approvals
    // row and post a second, undecidable button block for the same action.
    return {
      provider: args.engineProvider,
      sessionId: args.sessionId,
      model: args.model,
      outcome: 'conclusive',
      turnBudget: args.maxTurns,
      disposition: 'approval',
      summary: prompt,
      confidence: 0,
      rankedHypotheses: [],
      approval: { prompt, options },
    };
  }
  if (call.name === RESPOND_NAME) {
    const { summary, detail, purpose, evidenceIds } = parseRespond(call.input);
    return buildResult(args, {
      outcome: 'conclusive',
      disposition: 'reply',
      summary,
      detail,
      replyPurpose: purpose,
      evidenceIds,
      confidence: 0,
      rankedHypotheses: [],
    });
  }
  if (call.name === STAY_SILENT_NAME) {
    const { reason } = parseStaySilent(call.input);
    return buildResult(args, {
      outcome: 'conclusive',
      disposition: 'silent',
      summary: reason ?? '',
      confidence: 0,
      rankedHypotheses: [],
    });
  }
  const findings = parseReportFindings(call.input);
  return buildResult(args, {
    outcome: findings.outcome,
    ...(findings.outcome === 'conclusive' ? { disposition: 'rca' as const } : {}),
    summary: findings.summary,
    confidence: findings.confidence,
    rankedHypotheses: findings.rankedHypotheses,
    currentState: findings.currentState,
    impact: findings.impact,
    evidenceIds: findings.evidenceIds,
    unknowns: findings.unknowns,
    causalFindings: findings.causalFindings,
    causeTagSuggestions: findings.causeTagSuggestions,
    nextStep: findings.nextStep,
  });
}

/**
 * The multi-turn tool-use loop. Binds the tools plus whichever terminals the caller asked
 * for ({@link RunLoopArgs.terminals}, `report_findings` alone by default), then: call the model; stream
 * any assistant text; if the model called ANY bound terminal, conclude on it;
 * otherwise dispatch each tool call through `runTool` (tenant-scoped + audited), append the results,
 * and repeat. The exploration budget never includes the optional one-shot terminal-only finalizer.
 * That finalizer receives only recorded evidence and permitted terminal tools; invalid output is a
 * typed failed run, while provider or audit failures reject so the queue redelivers.
 */
export async function runLoop(args: RunLoopArgs): Promise<TriageResult> {
  const { provider, system, initialUser, tools, ctx, onStep, maxTurns } = args;

  const terminalNames = args.terminals ?? [REPORT_FINDINGS_NAME];
  const terminalTools = terminalNames.map((name) => TERMINAL_BY_NAME[name]);
  const terminalSet = new Set<string>(terminalNames);
  const isResume = args.path === 'resume';
  const isRecovery = args.path === 'recovery';
  const allTools = [...tools, ...terminalTools];
  const specs = provider.toolSpecs(allTools);
  const byName = new Map<string, ToolDefinition<any, any>>(allTools.map((t) => [t.name, t]));
  const messages: unknown[] = [provider.userMsg(initialUser)];
  const receipts: EvidenceReceipt[] = (args.priorEvidence ?? []).flatMap((evidence) =>
    evidence.id
      ? [{ evidenceId: evidence.id, tool: evidence.tool, outcome: 'complete' as const }]
      : [],
  );
  args.onExecutionMetadata?.({
    provider: args.engineProvider,
    model: args.model ?? null,
    sessionId: args.sessionId,
    turnBudget: args.maxTurns,
  });
  for (const receipt of receipts) args.onEvidenceReceipt?.(receipt);
  let challengeUsed = false;
  let evidenceUsed = false;
  let stoppedBeforeBudget = false;
  const finish = (result: TriageResult): TriageResult => ({
    ...result,
    evidenceReceipts: [
      ...new Map(receipts.map((receipt) => [receipt.evidenceId, receipt])).values(),
    ],
  });
  const executeNonTerminal = async (call: ToolCall): Promise<ToolRunResult> => {
    await onStep('tool_step', `${call.name} ${JSON.stringify(redactInput(call.input))}`);
    if (call.invalidInput)
      return { id: call.id, content: 'error: invalid tool input', isError: true };
    const tool = byName.get(call.name);
    if (!tool) return { id: call.id, content: `Unknown tool: ${call.name}`, isError: true };
    if (!tool.inputSchema.safeParse(call.input).success)
      return { id: call.id, content: 'error: invalid tool input', isError: true };
    if (terminalSet.has(call.name))
      return {
        id: call.id,
        content: 'error: investigation conclusion deferred until evidence closure completes',
        isError: true,
      };
    const result = await runTool(tool, ctx, call.input);
    evidenceUsed = true;
    const rendered = renderModelToolResult(tool.name, result, toolResultMaxChars());
    receipts.push(rendered.receipt);
    args.onEvidenceReceipt?.(rendered.receipt);
    return { id: call.id, content: rendered.content, isError: rendered.isError };
  };

  for (let turn = 0; turn < maxTurns; turn++) {
    if (args.signal?.aborted) throw args.signal.reason;
    const modelTurn = await provider.call(system, messages, specs, undefined, args.signal);

    if (modelTurn.text.trim().length > 0) {
      await onStep('text', modelTurn.text);
    }

    // Terminal: the model concluded via one of the bound terminals. Return its disposition, whatever
    // else it called this turn; the WORKER appends the concluding hub message (so it can carry summary).
    const terminal = modelTurn.toolCalls.find((call) => {
      const tool = terminalSet.has(call.name) ? byName.get(call.name) : undefined;
      return !call.invalidInput && !!tool && tool.inputSchema.safeParse(call.input).success;
    });
    if (terminal) {
      const siblingCalls = modelTurn.toolCalls.filter((call) => call.id !== terminal.id);
      let terminalFeedback: string | null = null;
      if (terminal.name === STAY_SILENT_NAME && evidenceUsed) {
        terminalFeedback =
          'Evidence was gathered for this human turn. Give the responder a visible conclusion with respond, report_findings, or suggest_action.';
      }
      if (terminal.name === REPORT_FINDINGS_NAME) {
        const findings = parseReportFindings(terminal.input);
        const closure = evidenceClosureDecision(findings.unknowns, receipts, {
          challengeUsed,
          // A closure needs one evidence turn followed by the reserved terminal turn.
          canContinue: turn <= maxTurns - 3,
        });
        if (closure.challenge) {
          challengeUsed = true;
          terminalFeedback = closure.message;
        }
      }
      if (!terminalFeedback && siblingCalls.length > 0) {
        terminalFeedback =
          'Evidence calls were emitted beside this conclusion. Their results follow. Submit a revised conclusion that cites the durable evidence.';
      }
      if (terminalFeedback) {
        messages.push(modelTurn.assistantMsg);
        const results: ToolRunResult[] = [];
        for (const call of modelTurn.toolCalls) {
          results.push(
            call.id === terminal.id
              ? { id: call.id, content: terminalFeedback, isError: false }
              : await executeNonTerminal(call),
          );
        }
        messages.push(...provider.toolResultMsgs(results));
        continue;
      }
      return finish(interpretTerminal(args, terminal));
    }

    // No tool calls and no terminal: the model stopped early. Degrade below.
    if (modelTurn.toolCalls.length === 0) {
      stoppedBeforeBudget = true;
      break;
    }

    messages.push(modelTurn.assistantMsg);
    const results: ToolRunResult[] = [];
    for (const call of modelTurn.toolCalls) results.push(await executeNonTerminal(call));
    messages.push(...provider.toolResultMsgs(results));
  }

  const finalizerNames: TerminalName[] = isRecovery
    ? [REPORT_RECOVERY_NAME]
    : isResume
      ? terminalNames.filter((name) => name !== STAY_SILENT_NAME)
      : [REPORT_FINDINGS_NAME];
  if ((evidenceUsed || receipts.length > 0) && finalizerNames.length > 0) {
    const finalizers = finalizerNames.map((name) => TERMINAL_BY_NAME[name]);
    const reader = recordedEvidenceTool(
      { ...args, signal: args.signal ?? new AbortController().signal },
      receipts,
      args.priorEvidence ?? [],
    );
    const finalizerTools = [...finalizers, reader];
    messages.push(
      provider.userMsg(
        `Finalize from recorded evidence only. Read earlier records by ID as needed.\n${recordedEvidenceInventory(receipts)}`,
      ),
    );
    for (let finalTurn = 0; finalTurn < 8; finalTurn += 1) {
      if (args.signal?.aborted) throw args.signal.reason;
      const modelTurn = await provider.call(
        system,
        messages,
        provider.toolSpecs(finalizerTools),
        undefined,
        args.signal,
      );
      if (modelTurn.text.trim().length > 0) await onStep('text', modelTurn.text);
      const [call] = modelTurn.toolCalls;
      const finalizer = call ? TERMINAL_BY_NAME[call.name as TerminalName] : undefined;
      if (
        modelTurn.toolCalls.length === 1 &&
        call &&
        finalizerNames.includes(call.name as TerminalName) &&
        !call.invalidInput &&
        finalizer?.inputSchema.safeParse(call.input).success
      ) {
        return finish(interpretTerminal(args, call));
      }
      if (
        !modelTurn.toolCalls.length ||
        modelTurn.toolCalls.some(
          (item) =>
            item.name !== reader.name ||
            item.invalidInput ||
            !reader.inputSchema.safeParse(item.input).success,
        )
      )
        break;
      messages.push(modelTurn.assistantMsg);
      const slices: ToolRunResult[] = [];
      for (const read of modelTurn.toolCalls) {
        const result = await runTool(reader, ctx, reader.inputSchema.parse(read.input));
        slices.push({ id: read.id, content: JSON.stringify(result), isError: !result.available });
      }
      messages.push(...provider.toolResultMsgs(slices));
    }
    return finish(
      buildResult(args, {
        outcome: 'failed',
        summary: 'Investigation finalization failed.',
        confidence: 0,
        rankedHypotheses: [],
      }),
    );
  }

  return finish(
    buildResult(args, {
      outcome: stoppedBeforeBudget ? 'inconclusive' : 'budget_exhausted',
      summary: stoppedBeforeBudget
        ? 'Investigation ended without a terminal conclusion.'
        : DEGRADED_SUMMARY,
      confidence: 0,
      rankedHypotheses: [],
    }),
  );
}
