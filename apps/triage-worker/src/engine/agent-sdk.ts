import { createSdkMcpServer, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { agentSdkOutputSchema } from './agent-sdk/output-schema';
import type { InboundCandidate } from '@sre/connectors';
import type { IncidentSummary } from '@sre/db';
import { randomUUID } from 'node:crypto';
import * as z from 'zod';
import type { AgentSdkConfig } from './agent-sdk/contracts';
import { STRUCTURED_SYSTEM, baseOptions, linkedAbortController, runQuery } from './agent-sdk/query';
import { parseStructuredOutput } from './structured-repair';
import {
  degradedResult,
  makeMcpTools,
  terminalFromAssistantMessages,
  terminalResult,
  type TerminalCall,
  type TerminalName,
} from './agent-sdk/tools';
import {
  CLASSIFY_SYSTEM_PROMPT,
  buildClassifyUserPrompt,
  type Classifier,
  type ClassifyOptions,
} from './classify';
import { correlationVerdictSchema, type ResolutionCandidate } from './correlation';
import { evidenceClosureDecision, type EvidenceReceipt } from './evidence-closure';
import { claudeSupportsVision } from './generator-claude';
import { REPORT_FINDINGS_NAME, parseReportFindings } from './report-findings';
import { REPORT_RECOVERY_NAME } from './report-recovery';
import { RESPOND_NAME } from './respond';
import { recordedEvidenceTool, recordedEvidenceInventory } from './recorded-evidence';
import {
  RECOVERY_SYSTEM_PROMPT,
  REASSESS_SYSTEM_PROMPT,
  TRIAGE_SYSTEM_PROMPT,
  buildInvestigationPrompt,
  buildRecoveryPrompt,
  buildResumePrompt,
  renderEvidence,
  reassessmentTurnBudget,
} from './shared';
import { STAY_SILENT_NAME } from './stay-silent';
import { SUGGEST_ACTION_NAME } from './suggest-action';
import type {
  StructuredGenerationOptions,
  StructuredGenerator,
  ResumeInput,
  TriageEngine,
  TriageResult,
  TriageRuntime,
  VisionModel,
} from './types';

export type { AgentSdkConfig, AgentSdkObservability } from './agent-sdk/contracts';

function terminalNamesFor(
  path: 'investigate' | 'resume' | 'recovery',
  allowResumeRecovery: boolean,
): TerminalName[] {
  const names: TerminalName[] =
    path === 'investigate'
      ? [REPORT_FINDINGS_NAME]
      : path === 'recovery'
        ? [REPORT_RECOVERY_NAME]
        : [REPORT_FINDINGS_NAME, RESPOND_NAME, STAY_SILENT_NAME, SUGGEST_ACTION_NAME];
  if (path === 'resume' && allowResumeRecovery) names.push(REPORT_RECOVERY_NAME);
  return names;
}

function boundedTaskContext(prompt: string, maxCharacters = 16_000): string {
  if (prompt.length <= maxCharacters) return prompt;
  const half = Math.floor(maxCharacters / 2);
  return `${prompt.slice(0, half)}\n\n[Earlier context truncated]\n\n${prompt.slice(-half)}`;
}

async function investigate(
  config: AgentSdkConfig,
  path: 'investigate' | 'resume' | 'recovery',
  prompt: string,
  system: string,
  runtime: TriageRuntime,
  allowResumeRecovery = false,
  priorEvidence: NonNullable<ResumeInput['evidence']> = [],
  turnBudget = config.runtime.maxTurns,
): Promise<TriageResult> {
  const terminalNames = terminalNamesFor(path, allowResumeRecovery);
  let terminal: TerminalCall | undefined;
  const acceptedTerminals: TerminalCall[] = [];
  let challengeUsed = false;
  let evidenceUsed = false;
  const evidenceContent = priorEvidence.length > 0 ? [renderEvidence(priorEvidence)] : [];
  const receipts: EvidenceReceipt[] = priorEvidence.flatMap((evidence) =>
    evidence.id
      ? [{ evidenceId: evidence.id, tool: evidence.tool, outcome: 'complete' as const }]
      : [],
  );
  runtime.onExecutionMetadata?.({
    provider: config.runtime.provider,
    model: config.runtime.model,
    sessionId: `${config.runtime.provider}:${runtime.ctx.incidentId}`,
    turnBudget,
  });
  for (const receipt of receipts) runtime.onEvidenceReceipt?.(receipt);
  const finish = (result: TriageResult): TriageResult => ({
    ...result,
    evidenceReceipts: [
      ...new Map(receipts.map((receipt) => [receipt.evidenceId, receipt])).values(),
    ],
  });
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
    evidenceContent,
  );
  const server = createSdkMcpServer({
    name: 'sre',
    version: '1.0.0',
    alwaysLoad: true,
    tools: mcp.tools,
  });
  const options = baseOptions(config, system);
  options.maxTurns = turnBudget;
  options.mcpServers = { sre: server };
  options.allowedTools = mcp.allowed;
  // The job deadline tells the SDK to kill the CLI subprocess.
  options.abortController = linkedAbortController(runtime.signal);
  const output = await runQuery(config, prompt, options, (text) => runtime.onStep('text', text));
  const sessionId = output.result.session_id;
  const messageConclusion = terminalFromAssistantMessages(
    output.messages,
    terminalNames,
    acceptedTerminals,
  );
  const conclusion = messageConclusion.observedToolCalls ? messageConclusion.conclusion : terminal;
  if (conclusion)
    return finish(
      terminalResult(
        conclusion.name,
        conclusion.input,
        config.runtime.provider,
        sessionId,
        config.runtime.model,
        turnBudget,
      ),
    );

  const finalizerNames: TerminalName[] =
    path === 'recovery'
      ? [REPORT_RECOVERY_NAME]
      : path === 'resume'
        ? terminalNames.filter((name) => name !== STAY_SILENT_NAME)
        : [REPORT_FINDINGS_NAME];
  if ((evidenceUsed || receipts.length > 0) && finalizerNames.length > 0) {
    let finalTerminal: TerminalCall | undefined;
    const accepted: TerminalCall[] = [];
    const finalizerMcp = makeMcpTools(
      { ...runtime, tools: [recordedEvidenceTool(runtime, receipts, priorEvidence)] },
      finalizerNames,
      receipts,
      (name, input) => {
        finalTerminal = { name, input };
        accepted.push(finalTerminal);
        return 'Investigation conclusion recorded.';
      },
      () => undefined,
    );
    const finalizerServer = createSdkMcpServer({
      name: 'sre',
      version: '1.0.0',
      alwaysLoad: true,
      tools: finalizerMcp.tools,
    });
    const finalizerOptions = baseOptions(config, system);
    finalizerOptions.maxTurns = 8;
    finalizerOptions.mcpServers = { sre: finalizerServer };
    finalizerOptions.allowedTools = finalizerMcp.allowed;
    // The job deadline tells the SDK to kill the CLI subprocess.
    finalizerOptions.abortController = linkedAbortController(runtime.signal);
    const recordedEvidence = evidenceContent.join('\n\n').slice(-24_000);
    const finalizerPrompt =
      'Exploration is complete. Submit exactly one permitted terminal conclusion for the original task using only the recorded evidence. Do not request or infer new evidence.\n\n' +
      `Original task:\n${boundedTaskContext(prompt)}\n\nAdmitted evidence inventory (read earlier records by ID when absent below):\n${recordedEvidenceInventory(receipts)}\n\nRecorded evidence:\n` +
      (recordedEvidence ||
        receipts.map((receipt) => `${receipt.tool}: evidenceId ${receipt.evidenceId}`).join('\n'));
    const finalized = await runQuery(config, finalizerPrompt, finalizerOptions, (text) =>
      runtime.onStep('text', text),
    );
    const fromMessages = terminalFromAssistantMessages(
      finalized.messages,
      finalizerNames,
      accepted,
    );
    const acceptedConclusion = fromMessages.observedToolCalls
      ? fromMessages.conclusion
      : finalTerminal;
    if (acceptedConclusion)
      return finish(
        terminalResult(
          acceptedConclusion.name,
          acceptedConclusion.input,
          config.runtime.provider,
          finalized.result.session_id,
          config.runtime.model,
          turnBudget,
        ),
      );
    return finish(
      degradedResult(
        path,
        config.runtime.provider,
        sessionId,
        config.runtime.model,
        'failed',
        turnBudget,
      ),
    );
  }
  return finish(
    degradedResult(
      path,
      config.runtime.provider,
      sessionId,
      config.runtime.model,
      output.result.subtype === 'error_max_turns' ? 'budget_exhausted' : 'inconclusive',
      turnBudget,
    ),
  );
}

/** Create a Claude Agent SDK investigation engine. */
export function makeAgentSdkEngine(config: AgentSdkConfig): TriageEngine {
  return {
    provider: config.runtime.provider,
    investigate: (input, runtime) =>
      investigate(
        config,
        'investigate',
        buildInvestigationPrompt(input),
        input.mode === 'focused' ? REASSESS_SYSTEM_PROMPT : TRIAGE_SYSTEM_PROMPT,
        runtime,
        false,
        input.evidence,
        input.mode === 'focused'
          ? reassessmentTurnBudget(config.runtime.maxTurns)
          : config.runtime.maxTurns,
      ),
    resume: (input, runtime) =>
      investigate(
        config,
        'resume',
        buildResumePrompt(input),
        TRIAGE_SYSTEM_PROMPT,
        runtime,
        input.recoveryContext !== undefined,
        input.evidence,
      ),
    verifyRecovery: (input, runtime) =>
      investigate(
        config,
        'recovery',
        buildRecoveryPrompt(input),
        RECOVERY_SYSTEM_PROMPT,
        runtime,
        false,
        input.evidence,
      ),
  };
}

/** Create the structured-output generator used by classification helpers. */
export function makeAgentSdkGenerator(config: AgentSdkConfig): StructuredGenerator {
  return {
    async generate<T>(
      prompt: string,
      schema: z.ZodType<T>,
      generationOptions?: StructuredGenerationOptions,
    ): Promise<T> {
      const wrapped = z.object({ result: schema });
      const system = generationOptions?.system
        ? `${STRUCTURED_SYSTEM}\n\n${generationOptions.system}`
        : STRUCTURED_SYSTEM;
      if (generationOptions?.signal?.aborted) throw generationOptions.signal.reason;
      const options = baseOptions(config, system);
      options.maxTurns = Math.min(3, config.runtime.maxTurns);
      options.outputFormat = { type: 'json_schema', schema: agentSdkOutputSchema(wrapped) };
      if (generationOptions?.signal)
        options.abortController = linkedAbortController(generationOptions.signal);
      const output = await runQuery(config, prompt, options);
      if (output.result.subtype !== 'success')
        throw new Error('Claude Agent SDK returned no structured output');
      return parseStructuredOutput(wrapped, output.result.structured_output, generationOptions)
        .result;
    },
  };
}

/** Create the incident correlation classifier backed by the structured generator. */
export function makeAgentSdkClassifier(config: AgentSdkConfig): Classifier {
  const generator = makeAgentSdkGenerator(config);
  return {
    async classify(
      candidate: InboundCandidate,
      candidates: IncidentSummary[],
      resolutionCandidates: ResolutionCandidate[] = [],
      options?: ClassifyOptions,
    ) {
      if (options?.signal?.aborted) throw options.signal.reason;
      return generator.generate(
        `${CLASSIFY_SYSTEM_PROMPT}\n\n${buildClassifyUserPrompt(candidate, candidates, resolutionCandidates)}`,
        correlationVerdictSchema,
        { signal: options?.signal },
      );
    },
  };
}

/** Create the Claude vision adapter for human-supplied incident images. */
export function makeAgentSdkVision(config: AgentSdkConfig): VisionModel {
  return {
    provider: config.runtime.provider,
    supportsVision: claudeSupportsVision(config.runtime.model),
    async describeImage(
      bytes: ArrayBuffer,
      mime: string,
      prompt: string,
      options?: { signal?: AbortSignal },
    ): Promise<string> {
      if (options?.signal?.aborted) throw options.signal.reason;
      async function* imagePrompt(): AsyncGenerator<SDKUserMessage> {
        yield {
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: mime as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
                  data: Buffer.from(bytes).toString('base64'),
                },
              },
              { type: 'text', text: prompt },
            ],
          },
          parent_tool_use_id: null,
          uuid: randomUUID(),
        };
      }
      const queryOptions = baseOptions(config, STRUCTURED_SYSTEM);
      if (options?.signal) queryOptions.abortController = linkedAbortController(options.signal);
      const output = await runQuery(config, imagePrompt(), queryOptions);
      if (output.result.subtype !== 'success') throw new Error('Claude Agent SDK vision failed');
      return output.result.result;
    },
  };
}
