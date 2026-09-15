# SRE Intelligence Platform

Glossary for the SRE Intelligence Platform — a multi-tenant SaaS that unifies observability, incident triage, and reliability metrics across each tenant's infrastructure. This file is a glossary only.

<!-- --8<-- [start:glossary] -->

## Language

Terms marked _(planned)_ are Edition-2 vocabulary with **no implementation at HEAD**; see "What is not built yet" on the SRE doctrine page.

**Tenant**:
An organisation that signs up to the platform and connects its own infrastructure and observability sources. Each tenant supplies its own connector credentials and its data is isolated by `tenant_id` under Postgres Row-Level Security.
_Avoid_: Org, account, customer, workspace

**Connector**:
A reusable adapter type that normalises one kind of external system (Prometheus, GitHub, Kubernetes, ...) into the platform's canonical schema. A Connector defines capabilities and behaviour; a tenant configures one or more Data Sources of that type.
_Avoid_: Data Source, integration, plugin, configured connector

**Data Source**:
One tenant-owned configured instance of a Connector, with an immutable identity, editable name, settings, credential, lifecycle health, and evidence provenance. Two Prometheus servers or Kubernetes clusters are two Data Sources of the same Connector type; renaming one never changes its identity.
_Avoid_: Connector type, integration, account

**Surface Binding**:
A durable, addressable external-surface conversation for an Incident: the `channel` and the root message's `thread_id`. A binding is optional: a dashboard-origin Incident has a complete Conversation Hub workspace without Slack. When an opener supplies a binding, it is created atomically with the Incident and receives the investigation projection. A merge transfers the other Incident's binding as a source binding; it remains interactive and receives relationship and lifecycle projections, while split restores its primary role. There is no fallback channel: a Slack `thread_ts` means nothing outside the channel that owns its root message.
_Avoid_: Target channel, post target, thread mapping

**Investigation Subject**:
The typed, tenant-owned platform observation that opened an Incident: one infrastructure resource, deployment, connector verification, or topology service. The API accepts only its stable identifiers, resolves and sanitises current evidence server-side, and stores bounded captured/current provenance. Dynamic subjects are synchronised without model work when their canonical material is unchanged.
_Avoid_: Browser snapshot, incident service, Slack alert

**Incident Opening Service**:
`openIncidentWorkspace`, the sole production ingress for creating an Incident. Its tenant transaction writes the Incident, initial Signal, opener audit, and triage work. A typed Investigation Subject is present only for an operator declaration from platform-owned evidence. A Surface Binding is present only when the Incident has an external conversation. Provider adapters supply provider Signals; platform declarations supply platform Signals. Slack's `routeToIncident` and dashboard declaration routes are adapters to this service, not alternate creation paths.
_Avoid_: routeToIncident, incident factory, Slack ingress

**Trust Boundary**:
The tenant is the platform's sole trust boundary: everything inside one tenant is equally trusted to *see*, and nothing crosses between tenants. Every domain table carries `tenant_id` and Postgres RLS — not application code — is what enforces the separation. There is no sub-tenant **visibility** tier: any member of a tenant may see any of that tenant's incidents, tool output and connector-derived data, so per-user read authorization is not a thing the domain models.

There is exactly one sub-tenant **change** tier, and it is drawn by HTTP method rather than by feature, so it cannot drift as routes are added: on the routers that carry durable workspace configuration every safe method passes through, and every method that changes something is reserved to a membership whose role is `owner` or `admin`. That is the whole rule; it needs no per-route list and gains one automatically. Four routers carry it today: data sources, the Slack surface, service level objectives and the service graph. In practice it reaches every configuration action those surfaces offer, including connecting, editing, retesting, probing and disconnecting a Data Source, rotating a connector credential, previewing, authorizing or revoking webhook management, connecting, retesting or disconnecting the Slack surface, subscribing or pausing an inbound Slack channel, defining, retargeting or deleting an objective, and cataloguing a service or declaring a dependency edge — a subscribed channel is the one thing that admits an inbound signal, so choosing one is configuration, not incident work. Every such change is also refused inside an impersonated support session, and so is every other change a member could make: configuration, membership, the workspace name, and the durable incident record itself. The rule a support session obeys is that it may act as a platform operator and never as a member, so the routes that already demand platform-operator rights stay open to it, because impersonation is the only way an operator reaches a tenant context at all, while everything a responder does on their own incidents is refused. Talking is not changing: the conversation arrives over a different ingress and stays open, and a support message is attributed to the operator rather than to a member. Re-checking a domain's verification stays open on the same reasoning, because it reads DNS rather than writing anything. A connector's credentials belong to the tenant, never to the person who entered them; the change tier decides who may replace them, never who may see what they produce. Everything off those routers stays flat, and so does every read on them: incident work, triage dialogue, feedback and reporting are member work, and any member may read the tenant's connections, its Slack surface, its inbound state, its objectives and its service graph. The split is between describing the workspace and working an incident, not between important and unimportant: an objective and an edge are durable statements about the estate, while everything a responder does during an incident is theirs to do.

It follows that, within a tenant, **Slack channels are an organisational convenience, not a security boundary**. Three consequences. Correlation may consolidate a public-channel mention into an incident born in a private channel: the candidate set (`listActiveIncidents`) filters tenant, status and recency, never channel. A human may therefore be told about — and deep-linked to — an incident thread they cannot open; the link carries an opaque channel id, and Slack renders nothing of a private channel's name, members or content to a non-member. And it is the **bot's** channel memberships, not the human's, that bound what can be correlated. Treating a channel as a privacy control is a category error: the tenant is the boundary. A change to this boundary needs a deliberate, recorded decision, not a glossary edit.

The boundary governs **acting**, not only seeing — the distinction is worth stating because it has been re-derived twice. Deciding an Approval is the one place the platform takes a consequential action on a human's say-so, and the decider is authorized by their access to the tenant's Slack workspace and to the channel the prompt was posted in, plus Slack's request signature. The platform does not additionally prove the decider is a member of the tenant, still less an owner or administrator, and that is deliberate rather than an oversight: an Approval records consent to a recommendation a human then executes themselves, so it changes no durable workspace configuration and falls outside the one change tier named above. `author_user_id` on a decision is **attribution, never authorization**: it records who we believe acted, and the decision applies whether or not that resolves.

The accepted cost, stated plainly rather than sold: someone removed from the tenant but still present in its Slack workspace can decide an Approval, and the audit line will honestly say we do not know who. Offboarding from the workspace is the control, and it sits outside the platform. Revisiting this needs a deliberate, recorded decision rather than a patch, because refusing an unproven decider means inverting the platform's rule that identity resolution degrades to null and never blocks: a Slack outage would then refuse approvals at exactly the moment a human is trying to unblock an incident.
_Avoid_: Security boundary, permission scope, ACL

**Triage Engine**:
The pluggable component that drives an AI investigation of an incident. A platform operator selects one active runtime/provider/model in Settings; a worker resolves that durable setting at the start of every invocation, so a change needs no restart and never changes a run already in progress. Claude uses the Agent SDK with only tenant-scoped audited MCP tools; OpenAI uses the platform's bounded tool loop. There is no cross-provider fallback.
_Avoid_: Orchestrator, agent runner, LLM client

**LLM Invocation**:
One durable model-backed unit of work, such as classify, investigate, resume, recovery verification, image interpretation, or runbook generation. It snapshots the runtime, provider, model, custom token prices, and setting version before the provider is called; completion records request count, every token bucket, configured cost, provider estimate when available, failure category, and telemetry completeness. It belongs to one tenant under RLS and to an Incident when the work is incident-scoped. The provider estimate is not a billing statement.
_Avoid_: Chat message, provider log, invoice

**Provider Telemetry**:
Claude Agent SDK native OTLP log records linked to one LLM Invocation. Each run owns an authenticated receiver bound to loopback. Standard log attributes are recursively secret-redacted before tenant-scoped persistence; raw API request and response bodies stay disabled because arbitrary prompts and tool results cannot be made safe by best-effort scrubbing. A capture failure is a durable trace gap and marks the invocation telemetry incomplete. This is an operational trace, not an attested audit trail.
_Avoid_: Cost ledger, tool-call audit, billing record

**Conversation Hub**:
The single canonical per-incident message log (Postgres + Valkey pub/sub) that the triage engine reads and writes. Slack and the dashboard are thin adapters projecting it and feeding human input back.
_Avoid_: Thread, channel, transcript

**Incident Lifecycle**:
The responder-owned operational state of an Incident: `open`, `mitigated`, `resolved`, or `closed`. Every change is an explicit, version-fenced command that appends an audit line to the Conversation Hub. `resolved` means recovery was verified; `closed` means the case was filed without asserting recovery. A later firing signal may reopen either terminal state. Investigation progress and signal state never implicitly stand in for lifecycle.
_Avoid_: Alert status, investigation status, workflow status

**Investigation Progress**:
The Triage Engine's independent work state: `queued`, `gathering`, `assessed`, or `degraded`. `assessed` means a Trusted Assessment exists; it does not mean the latest Investigation Run succeeded or the service recovered. `degraded` means an initial investigation ended without a promotable assessment. A failed or inconclusive newer run never demotes an existing Trusted Assessment. Investigation Progress does not change the Incident Lifecycle.
_Avoid_: Incident status, alert status, resolution

**Investigation Run**:
One immutable attempt to investigate, reassess, resume, or verify recovery. Exploration has a bounded turn budget followed by at most one terminal-only finalizer when evidence was recorded. Every durable run ends as `conclusive`, `inconclusive`, `blocked_missing_capability`, `budget_exhausted`, or `failed`. A valid structured findings report selects the first three explicitly; reaching the exploration cap without a report is budget exhaustion; invalid finalization or engine failure is failed. The latest run is operational history, not automatically the current responder brief.
_Avoid_: Assessment, LLM invocation, tool call, conversation turn

**Trusted Assessment**:
The most recent conclusive Investigation Run promoted atomically to the Incident's responder brief, hypotheses, unknowns, next step, and cited evidence. Its run pointer and projection remain unchanged when a later run is inconclusive, blocked, budget-exhausted, or failed. An assessed record created before the Investigation Run ledger may have no run pointer until a new conclusive run replaces it.
_Avoid_: Latest run, finalizer output, recovery result

**Incident Finding**:
An immutable Conversation Hub conclusion or blocker with structured provenance: the Investigation Run, evidence references, promotion decision, and any reason it did not become the Trusted Assessment. It is the common source for the dashboard timeline and concise surface projection. A Finding never replaces the Trusted Assessment merely because it is newer.
_Avoid_: Chat answer, current assessment, Slack message

**Incident Feedback**:
An append-only, attributed responder verdict on a Finding, Affected Entity Candidate, correlation decision, or Signal noise decision. It records confirmation, correction, grouping, separation, noise, or not-noise without rewriting the original evidence. Accuracy and toil analysis consume this ledger rather than creating a parallel feedback event stream.
_Avoid_: Message edit, annotation, analytics event

**Incident Signal**:
One durable external alert identity attached to an Incident. Its current state is `firing`, `unknown`, or `resolved`; observations are `opened`, `updated`, `resolved`, or `refired`. A cleared signal starts recovery verification; it does not resolve the Incident by itself.
_Avoid_: Incident, lifecycle transition, conversation message

**Signal Source**:
The monitor, platform observation, connector-produced observation, or human report that produced an Incident Signal. It identifies where evidence came from and is never assumed to be the system affected by that evidence.
_Avoid_: Affected service, alert name, affected entity

**Affected Entity Candidate**:
A typed, source-proposed entity that may be affected by an Incident Signal, carrying stable identity, scope, provenance, confidence, freshness, and completeness. It remains evidence until tenant catalog resolution or a responder correction maps it to a Catalog Service.
_Avoid_: Service, Signal Source, confirmed impact

**Entity Mapping**:
An attributed tenant-local decision that relates an Affected Entity Candidate to a Catalog Service and can be corrected without rewriting the original signal evidence.
_Avoid_: Name guess, global alias, provider rule

**Entity Capability Gap**:
A typed statement that the platform lacks a connector capability, cannot currently access it, or has it only for the wrong scope needed to investigate an Affected Entity Candidate. It names the missing capability and the operator action that can make the evidence available.
_Avoid_: Unknown, tool error, inconclusive result

**Provider Alert Episode**:
One continuous firing interval identified by its Data Source, provider fingerprint, and provider start time. Transport repeats and material updates belong to the same episode; a later start time is a new episode even when its name and rendered message are identical.
_Avoid_: Duplicate alert, recurrence, Slack message

**Alert Cohort**:
A time-bounded candidate set of independently investigated Provider Alert Episodes from one Data Source. Membership suggests what to compare; it is never evidence that the episodes share a cause.
_Avoid_: Incident group, merged incident, root cause

**Incident Relation**:
An auditable statement between two Incidents. Provider recurrence is immutable episode lineage; possible relation, different cause, merge, and split are evidence-backed causal decisions that may supersede one another without erasing that lineage. A merge is a reversible responder correction, not a result of timing or name similarity alone.
_Avoid_: Deduplication, correlation score, Alert Cohort

**Recovery Verification**:
A Triage Engine run started after all known Incident Signals clear. It checks current evidence and records a recovery proposal. The model has no lifecycle authority. A deterministic policy may resolve the Incident only when auto-resolve is enabled for the run, the proposal is `recovered`, the Incident is still `open` or `mitigated`, at least one Signal is attached and every one of them has cleared, and no Approval is awaiting a decision; the transition is then applied under a lifecycle-version fence. Severity, ownership, and remaining unknowns are not part of that gate. Every other result leaves lifecycle unchanged for a responder.
_Avoid_: Auto-resolve, alert clear, close

**Triage Tool**:
A function the Triage Engine calls during an investigation. Three kinds. Each Data Source exposes its own **granular** tools via `tools()`, namespaced by Connector type and immutable Data Source identity, and bound per tenant, so multiple sources of the same type remain distinct. Eleven **platform** tools are fixed and bound for every tenant because they read platform-owned stores or compose tenant-owned connector capabilities: `fetch_blast_radius`, `search_runbooks`, `fetch_recent_deploys`, `search_incident_evidence`, `investigate_code`, `resolve_entity_context`, `fetch_slo_status`, `read_topology_runtime`, `read_topology_sources`, `read_topology_endpoint_evidence`, and `read_topology_source_file`. The topology tools read attributed runtime, repository, and audited endpoint evidence; source-file reads require admitted repositories and pinned revisions. A third kind, the **terminal** tools (`report_findings`, `report_recovery`, `respond`, `stay_silent`, `suggest_action`), is bound by the loop itself and ends the run rather than returning context; `runLoop` intercepts the call instead of dispatching it. Engine-agnostic by design: the layer carries no provider SDK, so the same tenant tools and terminal sets bind through the Claude and OpenAI adapters.
_Avoid_: Function call, plugin, skill, action

**Recommended Action**:
An advisory L2 or L3 recommendation emitted by the resume-only `suggest_action` terminal after an RCA exists. It contains an explanation and the exact command or rollback reference; code supplies fixed Approve and Deny decisions. The worker secret-scrubs the human-visible content, then the existing Approval row and linked Conversation Hub messages preserve that exact post-scrub recommendation and its first decision across Slack and the dashboard. Approval records consent only: a human executes the recommendation, and the platform acquires no write credential and performs no tenant-infrastructure mutation. These approval records and append-only Hub messages are the business audit; Tool-Call Audit remains for dispatched read tools.
_Avoid_: Automated action, execution request, remediation job

**Tool Availability**:
Whether a tool run returned data or threw. `available: true` carries the data; `available: false` means `error` — the handler or connector threw and `runTool` caught it, surfacing no raw failure text (CWE-209). There is no third outcome: an **empty store is data** (an empty list, an unmapped blast radius), and a tool the tenant cannot serve is never bound in the first place, so absence from the tool surface — not a result value — expresses it. Emptiness is a first-class result, not an exception.
_Avoid_: Status, readiness, enabled, coming soon

**Audit Sink**:
The port that records one entry per tool run — tool, tenant, incident, input, latency, and outcome (`data` or `error`).
_Avoid_: Logger, tracer, telemetry

**Tool-Call Audit**:
The durable record of triage tool runs — one `agent_tool_calls` row per run (tool, tenant, incident, redacted input, latency, outcome) written by the Postgres-backed Audit Sink under Row-Level Security. The input is redacted before storage so connector credentials never persist (CWE-532).
_Avoid_: Tool log, call history, trace, telemetry

**Runbook**:
A tenant's operational documentation — incident-response procedures and remediation steps — ingested into the knowledge corpus so the Triage Engine can retrieve it during an investigation. Retrieved via the `search_runbooks` tool, not a connector.
_Avoid_: Playbook, wiki page, doc

**Knowledge Chunk**:
One embedded passage of a tenant's runbook corpus — `source`, optional `title`, `content`, and a local-model embedding — stored in `knowledge_chunks` under Row-Level Security. `search_runbooks` ranks a tenant's chunks by cosine similarity to a query (pgvector RAG).
_Avoid_: Document, vector row, embedding record

**Postmortem** _(planned)_:
The blameless record of a resolved Incident: summary, impact, contributing causes, trigger, resolution, detection, lessons learned, timeline, and Action Items. Distinct from a **Runbook** — a runbook says how to fix the problem next time, a postmortem says what will be changed so it does not recur. Generated from the incident's hub transcript and evidence store, then human-edited. Never names an individual as a cause (Google SRE Ch 15). Written when a tenant's configured trigger fires, not on every incident.
_Avoid_: RCA document, incident report, retro

**Action Item** _(planned)_:
One committed follow-up on a Postmortem, typed `prevent` | `mitigate` | `process`, carrying an owner and an external tracker link, tracked to a terminal state. The link is stored and rendered only: validated to `http:`/`https:` via WHATWG `new URL` before persistence, and **never fetched server-side** — polling a tenant-supplied URL from the control plane is SSRF and would need the resolve-once/`isBlockedIp`/pin guard, plus a recorded decision. The unit that makes a postmortem worth writing; an untracked action item is a defect, not a nicety.
_Avoid_: Todo, follow-up, remediation task

**Disposition** _(planned)_:
The single outcome the classifier assigns every ingested signal: `investigate` (urgent, actionable, user-visible now — opens an Incident and spends an engine run), `ticket` (real but not urgent — recorded for human review, no LLM spend), or `log` (not a reliability problem — recorded as a system of record). Google SRE Ch 1's three kinds of valid monitoring output. `investigate` is never the default, and nothing is dropped without a record. Today the classifier instead emits a **Correlation Verdict** — `not_worthy` | `belongs_to` | `new_incident` | `resolves_signal` (`apps/triage-worker/src/engine/correlation.ts`). `resolves_signal` selects a same-producer, same-channel unresolved signal and is applied only when the message independently corroborates recovery and signal identity; `not_worthy` drops the signal with no record.
_Avoid_: Severity, priority. (Not "relevance"/"verdict": `report_relevance` and `CorrelationVerdict` are shipped identifiers.)

**SLO** (Service Level Objective):
A reliability target for a Service, defined by an SLI type (`availability` | `latency`), a `target` fraction (e.g. 0.999), and a rolling compliance window in days. A **contract we hold ourselves to**, not a customer-facing SLA. A Service may have several. Tenant-scoped under RLS, created and edited through the objectives API only; the Error budgets panel reports objectives and cannot create or edit them.
_Avoid_: SLA (that is the external, penalty-bearing contract), goal, threshold

**SLI** (Service Level Indicator):
The measured **bad-event ratio** over a window — errors/total for `availability`, slow-requests/total (slower than `threshold_ms`) for `latency`. Both resolve to one ratio in [0,1]; the tenant's metrics backend computes it (we push the query down, we do not store samples).
_Avoid_: Metric, measurement, signal

**Burn Rate**:
How fast the Error Budget is being consumed: `bad-ratio-over-window / (1 − target)`. `1` means on track to spend exactly the whole budget across one compliance window; `14.4` means a 30-day budget would be gone in about 50 hours. Computed over a short window (default 1h) for the live figure.
_Avoid_: Consumption rate, spend rate, velocity

**Burn Event**:
The single row a scheduled evaluation persists for one SLO (`budget_pct`, `burn_rate`, `window`, timestamp). The budget and burn time series the dashboard, the opener brief and the deploy stamp all read. A successful evaluation writes exactly one, and a failed one writes none. Besides the burn event an evaluation records only its own outcome on the objective row (`last_eval_error`, `eval_failing_since`), and only when that outcome changes, which is what distinguishes an objective whose query is failing from one that has simply never run without turning a definition table into a write-heavy one. No SLI sample is ever stored, and no evaluation enqueues work or opens an Incident. Burn events are pruned past the read window, so the table does not grow with a tenant's age.
_Avoid_: Sample, reading, measurement, breach

**Exhaustion Projection**:
Time until the remaining Error Budget reaches zero at the current Burn Rate: `budget_remaining × window_days / burn_rate`. Computed on read, not stored. Null when not burning.
_Avoid_: ETA, forecast, prediction, depletion time

**Error Budget**:
The remaining allowance of unreliability for a service over a window — the gap between its SLO and its measured SLI ratio. A **read model only**: it enriches an incident's opener brief, stamps deploys advisory-risky, and feeds the Error budgets panel. Ranking services and feeding reports are _(planned)_, not built. It never opens an Incident and is not an ingress to the Incident Opening Service. A fast-burn condition requiring response enters through the tenant's authenticated alert provider or subscribed Slack channel. Computed by pushing the ratio query down to the tenant's own metrics backend; the platform stores definitions and burn events, never SLI samples.
_Avoid_: SLO budget, reliability budget, burn budget

**Incident Tag** _(planned)_:
Free-form single-word metadata on an Incident, where a colon is a semantic separator promoting hierarchical namespaces (`cause:network:switch`, `action:rollback`, `bogus`). Prefixes are suggested from the tenant's own historical usage, never a fixed enum — a predetermined list yields worse data (Google SRE Ch 16). The substrate for cross-incident analysis.
_Avoid_: Category, label, classification, taxonomy

**Incident Role** _(planned)_:
Who holds which responsibility during a live Incident, after the Incident Command System: **commander** (holds high-level state, holds every role not delegated), **ops** (the only party modifying the system), **comms** (periodic stakeholder updates), **planning** (longer-term issues, bug filing, handoffs). Held by a member of the tenant, recorded on the Incident, and transferred only by an explicit acknowledged handoff. An Incident Role is **incident coordination, never authorization**: it gates nothing anyone may see or decide during the incident, because members of a tenant see the same things. It is also independent of the membership role that reserves durable workspace configuration to an owner or administrator (see **Trust Boundary**): holding commander confers no configuration authority, and holding `admin` confers no incident role. "The only party modifying the system" is a human convention among responders — the platform does not mutate tenant infrastructure. Separately confirmed repository issue actions may use scoped issue-write credentials. Gating an Approval on a role would be an authorization check built on an identity the platform does not verify, and needs a deliberate, recorded decision. Google SRE Ch 14.
_Avoid_: Assignee, owner, responder role, permission

**Golden Signals**:
The four service-health signals a senior-SRE investigation examines for anomalies — latency, traffic, errors, and saturation (Google SRE). Step 5 of the Triage Engine's Investigation Sequence, named in the engine-agnostic system prompt; the engine examines them with whichever of the tenant's bound tools can serve them.
_Avoid_: The four signals, metrics, KPIs

**Investigation Sequence**:
The ordered ten-step methodology the Triage Engine follows during an investigation — blast radius, deploy correlation, logs, code evidence, golden signals, infrastructure, runbooks, rank hypotheses, recommended action, escalation. Encoded once in the engine-agnostic system prompt (`TRIAGE_SYSTEM_PROMPT`) that both the Claude and OpenAI bindings load.
_Avoid_: Triage steps, playbook, checklist, workflow

**Ranked Hypothesis**:
One candidate root cause the Triage Engine proposes during an investigation — a hypothesis, a confidence, and the evidence behind it. The engine ranks the set by likelihood; it persists on the incident as `ranked_hypotheses` alongside the RCA summary.
_Avoid_: Theory, guess, candidate cause, finding

**Metric Subscriber**:
A per-incident watcher in the triage worker that polls a service's metrics and posts to the Conversation Hub only when a tracked metric moves at or above a threshold (20%) versus its previous reading. The metric source and the hub append are injected ports, so it runs without live infrastructure. At most one subscriber per incident, owned by a Metric Subscriber Manager. **Not wired at HEAD**: the manager has no caller outside its own tests, so nothing subscribes on incident open or unsubscribes on resolution yet.
_Avoid_: Metric watcher, poller, monitor, alerter

**Degrade-and-Redeliver**:
The triage worker's response when its LLM provider is unavailable: it posts an Evidence Brief and an escalation to the Conversation Hub, marks an initial investigation `degraded`, and redelivers the job until the provider recovers and the investigation completes. A reassessment or resume retains an existing Trusted Assessment and its `assessed` progress. Incident Lifecycle is unchanged. One provider, no cross-provider fallback.
_Avoid_: Fallback, failover, circuit breaker, retry loop

**Evidence Brief**:
The assembled context the worker posts to the Conversation Hub when AI triage cannot complete — one section per connector the tenant has, each gathered deterministically via `fetchTriageContext` without the engine, so a human still has something real during a provider outage. A connector that throws is skipped rather than failing the brief; when none is live the brief says so. For an initial incident, `degraded` Investigation Progress means this brief stands in for a full assessment until the provider recovers; for a later failed run, the prior Trusted Assessment remains current.
_Avoid_: Summary, report, RCA, findings

**Resume**:
Continuing an open investigation from a human reply on any surface. The surface's `ingest` writes the reply to the Conversation Hub and enqueues a durable resume unit of work; the triage worker reconstructs prior context from the hub transcript and runs the Triage Engine's `resume`, building on earlier findings rather than starting over. The hub is the session — there is no engine-local state. Runs are serialized per incident, so concurrent replies are answered in hub order.
_Avoid_: Reply, retry, follow-up, continuation

**Catalog Service**:
A tenant-registered operational service with ownership, criticality, dependencies, repositories, deployments, and runbook context. A Signal Source or Affected Entity Candidate is not a Catalog Service until catalog resolution or an Entity Mapping establishes that relationship.
_Avoid_: Service guess, monitor job, namespace, app label

**Service Dependency**:
A declared call from a registered caller to a registered dependency, with environment scope and attributed confirmation evidence. Synchronous, asynchronous and circuit-breaker properties describe possible exposure, not proven outages or protection.
_Avoid_: Edge, link, relation, connection

**Blast Radius**:
The potential exposure of services reachable through service-call evidence or dependency declarations, including services beyond asynchronous and circuit-breaker boundaries. It is bounded by available relationship evidence and traversal depth, and does not establish observed customer impact.
_Avoid_: Impact, fallout, scope

**Runtime Mapping**:
A responder-confirmed association between a logical Catalog Service and resources in a specific connection, namespace and environment, optionally selected by an application label. Equal names do not establish this association.
_Avoid_: Namespace service, automatic identity match

**Collection Coverage**:
Evidence of whether a source's current inventory is complete, partial, unavailable or of unknown completeness. Healthy returned resources cannot establish healthy runtime when relevant collection coverage is missing.
_Avoid_: Service availability, dependency completeness

**Discovered Resource**:
An identifiable workload, repository, endpoint or other operational entity reported by a connected system. A discovered resource does not imply a confirmed logical service identity.
_Avoid_: Service guess, automatically registered service

**Resource Relationship**:
A directed, typed association between discovered resources, supported by attributed observations or declarations. Ownership, deployment, routing and monitoring relationships do not imply that one service calls another.
_Avoid_: Untyped edge, name match

**Declared Dependency**:
An attributed assertion that one identified service requires another. It describes possible dependency exposure without claiming that traffic was observed or that the dependency is synchronous.
_Avoid_: Observed call, confirmed outage, ownership

**Service Declaration**:
An attributed source statement identifying a logical service and its declared dependencies. It does not establish a deployed instance, runtime health or observed traffic.
_Avoid_: Running service, observed call

**Runtime Association**:
Evidence that an identified service executes on a particular runtime resource. It is distinct from controller ownership, network routing and a call to a dependency.
_Avoid_: Ownership, service name match

**Suspect**:
A direct (one-hop) `downstream` dependency of the failing Service, surfaced alongside the Blast Radius as a candidate root cause — the failing Service may itself be a victim of one of the things it calls. Not tiered.
_Avoid_: Cause, culprit, dependency (when you mean the candidate-cause framing)

<!-- --8<-- [end:glossary] -->
