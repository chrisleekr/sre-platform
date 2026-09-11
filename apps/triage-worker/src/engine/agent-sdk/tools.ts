import {
  tool as sdkTool,
  type SDKMessage,
  type SdkMcpToolDefinition,
} from '@anthropic-ai/claude-agent-sdk';
import { redactInput, runTool, type ToolDefinition } from '@sre/agent-tools';
import * as z from 'zod';
import { evidenceClosureDecision, type EvidenceReceipt } from '../evidence-closure';
import { REPORT_FINDINGS_NAME, parseReportFindings, reportFindingsTool } from '../report-findings';
import { REPORT_RECOVERY_NAME, parseReportRecovery, reportRecoveryTool } from '../report-recovery';
import { RESPOND_NAME, parseRespond, respondTool } from '../respond';
import { STAY_SILENT_NAME, parseStaySilent, staySilentTool } from '../stay-silent';
import {
  SUGGEST_ACTION_NAME,
  buildRecommendedAction,
  suggestActionSchema,
  suggestActionTool,
} from '../suggest-action';
import { renderModelToolResult, toolResultMaxChars } from '../tool-result';
import type { TriageResult, TriageRuntime } from '../types';

function zodShape(definition: ToolDefinition<any, any>): z.ZodRawShape {
  if (!(definition.inputSchema instanceof z.ZodObject))
    throw new Error(`Agent SDK tool schema must be an object: ${definition.name}`);
  return definition.inputSchema.shape;
}

export const TERMINALS = {
  [REPORT_FINDINGS_NAME]: reportFindingsTool,
  [RESPOND_NAME]: respondTool,
  [STAY_SILENT_NAME]: staySilentTool,
  [SUGGEST_ACTION_NAME]: suggestActionTool,
  [REPORT_RECOVERY_NAME]: reportRecoveryTool,
} as const;

export type TerminalName = keyof typeof TERMINALS;

export interface TerminalCall {
  name: TerminalName;
  input: unknown;
}

export function terminalResult(
  name: TerminalName,
  input: unknown,
  provider: string,
  sessionId: string,
  model: string,
  turnBudget: number,
): TriageResult {
  const base = {
    provider,
    sessionId,
    model,
    outcome: 'conclusive' as const,
    turnBudget,
    confidence: 0,
    rankedHypotheses: [],
  };
  if (name === REPORT_RECOVERY_NAME) {
    const recovery = parseReportRecovery(input);
    return {
      ...base,
      disposition: 'recovery',
      summary: recovery.summary,
      recovery: {
        outcome: recovery.outcome,
        recovered: recovery.recovered,
        evidence: recovery.evidence,
        evidenceIds: recovery.evidenceIds,
        unknowns: recovery.unknowns,
        nextStep: recovery.nextStep,
        recheckAfterMinutes: recovery.recheckAfterMinutes,
        scheduleReason: recovery.scheduleReason,
      },
    };
  }
  if (name === SUGGEST_ACTION_NAME) {
    const { prompt, options } = buildRecommendedAction(suggestActionSchema.parse(input));
    return { ...base, disposition: 'approval', summary: prompt, approval: { prompt, options } };
  }
  if (name === RESPOND_NAME) {
    const response = parseRespond(input);
    return {
      ...base,
      disposition: 'reply',
      summary: response.summary,
      detail: response.detail,
      replyPurpose: response.purpose,
      evidenceIds: response.evidenceIds,
    };
  }
  if (name === STAY_SILENT_NAME)
    return { ...base, disposition: 'silent', summary: parseStaySilent(input).reason ?? '' };
  const findings = parseReportFindings(input);
  return {
    ...base,
    outcome: findings.outcome,
    ...(findings.outcome === 'conclusive' ? { disposition: 'rca' as const } : {}),
    summary: findings.summary,
    confidence: findings.confidence,
    rankedHypotheses: findings.rankedHypotheses,
    causalFindings: findings.causalFindings,
    causeTagSuggestions: findings.causeTagSuggestions,
    currentState: findings.currentState,
    impact: findings.impact,
    evidenceIds: findings.evidenceIds,
    unknowns: findings.unknowns,
    nextStep: findings.nextStep,
  };
}

export function degradedResult(
  path: 'investigate' | 'resume' | 'recovery',
  provider: string,
  sessionId: string,
  model: string,
  outcome: 'inconclusive' | 'budget_exhausted' | 'failed' = 'inconclusive',
  turnBudget = 0,
): TriageResult {
  return {
    provider,
    sessionId,
    model,
    outcome,
    turnBudget,
    evidenceReceipts: [],
    summary:
      outcome === 'failed'
        ? 'Investigation finalization failed.'
        : outcome === 'inconclusive'
          ? 'Investigation ended without a terminal conclusion.'
          : path === 'recovery'
            ? 'Recovery verification exhausted its investigation budget.'
            : 'Investigation exhausted its turn budget without a terminal conclusion.',
    confidence: 0,
    rankedHypotheses: [],
  };
}

export function assistantText(messages: SDKMessage[]): string[] {
  const text: string[] = [];
  for (const message of messages) {
    if (message.type !== 'assistant') continue;
    for (const block of message.message.content)
      if (block.type === 'text' && block.text.trim()) text.push(block.text);
  }
  return text;
}

function terminalKey(call: TerminalCall): string {
  const parsed = TERMINALS[call.name].inputSchema.safeParse(call.input);
  return `${call.name}\0${JSON.stringify(parsed.success ? parsed.data : call.input)}`;
}

export function terminalFromAssistantMessages(
  messages: SDKMessage[],
  terminalNames: TerminalName[],
  accepted: TerminalCall[],
): { observedToolCalls: boolean; conclusion?: TerminalCall } {
  const terminalSet = new Set<string>(terminalNames);
  const acceptedSet = new Set(accepted.map(terminalKey));
  const turns = new Map<string, TerminalCall[]>();
  let observedToolCalls = false;
  for (const message of messages) {
    if (message.type !== 'assistant') continue;
    const turnId = `${message.parent_tool_use_id ?? 'root'}\0${message.message.id}`;
    const calls = turns.get(turnId) ?? [];
    for (const block of message.message.content) {
      if (block.type !== 'tool_use') continue;
      const name = block.name.replace(/^mcp__sre__/, '');
      observedToolCalls = true;
      calls.push({ name: name as TerminalName, input: block.input });
    }
    if (calls.length > 0) turns.set(turnId, calls);
  }
  let conclusion: TerminalCall | undefined;
  for (const calls of turns.values()) {
    if (calls.length !== 1 || !terminalSet.has(calls[0]!.name)) {
      conclusion = undefined;
      continue;
    }
    const call = calls[0]!;
    if (acceptedSet.has(terminalKey(call))) conclusion = call;
  }
  return { observedToolCalls, conclusion };
}

export function makeMcpTools(
  runtime: TriageRuntime,
  terminalNames: TerminalName[],
  receipts: EvidenceReceipt[],
  onTerminal: (name: TerminalName, input: unknown) => string,
  onEvidence: () => void,
  evidenceContent: string[] = [],
): { tools: SdkMcpToolDefinition<any>[]; allowed: string[] } {
  const all = [...runtime.tools, ...terminalNames.map((name) => TERMINALS[name])];
  const terminals = new Set<string>(terminalNames);
  return {
    tools: all.map((definition) =>
      sdkTool(
        definition.name,
        definition.description,
        zodShape(definition),
        async (input) => {
          await runtime.onStep(
            'tool_step',
            `${definition.name} ${JSON.stringify(redactInput(input))}`,
          );
          const parsed = definition.inputSchema.safeParse(input);
          if (!parsed.success)
            return {
              content: [{ type: 'text', text: 'error: invalid tool input' }],
              isError: true,
            };
          if (terminals.has(definition.name)) {
            return {
              content: [
                { type: 'text', text: onTerminal(definition.name as TerminalName, parsed.data) },
              ],
            };
          }
          onEvidence();
          const rendered = renderModelToolResult(
            definition.name,
            await runTool(definition, runtime.ctx, parsed.data),
            toolResultMaxChars(),
          );
          receipts.push(rendered.receipt);
          runtime.onEvidenceReceipt?.(rendered.receipt);
          evidenceContent.push(rendered.content);
          return {
            content: [{ type: 'text', text: rendered.content }],
            ...(rendered.isError ? { isError: true } : {}),
          };
        },
        { alwaysLoad: true },
      ),
    ),
    allowed: all.map((definition) => `mcp__sre__${definition.name}`),
  };
}

export function terminalController(
  runtime: TriageRuntime,
  terminalNames: TerminalName[],
  receipts: EvidenceReceipt[],
) {
  let terminal: TerminalCall | undefined;
  const acceptedTerminals: TerminalCall[] = [];
  let fallbackDraft: { name: typeof REPORT_FINDINGS_NAME; input: unknown } | undefined;
  let challengeUsed = false;
  let evidenceUsed = false;
  const mcp = makeMcpTools(
    runtime,
    terminalNames,
    receipts,
    (name, input) => {
      if (name === STAY_SILENT_NAME && evidenceUsed)
        return 'Evidence was gathered for this human turn. Give the responder a visible conclusion with respond, report_findings, or suggest_action.';
      if (name === REPORT_FINDINGS_NAME) {
        const findings = parseReportFindings(input);
        const closure = evidenceClosureDecision(findings.unknowns, receipts, {
          challengeUsed,
          canContinue: true,
        });
        if (closure.challenge) {
          challengeUsed = true;
          fallbackDraft = { name, input };
          return closure.message!;
        }
      }
      terminal = { name, input };
      acceptedTerminals.push(terminal);
      return 'Investigation conclusion recorded.';
    },
    () => {
      evidenceUsed = true;
      terminal = undefined;
    },
  );
  return {
    mcp,
    acceptedTerminals,
    fallbackDraft: () => fallbackDraft,
    terminal: () => terminal,
    evidenceUsed: () => evidenceUsed,
  };
}
