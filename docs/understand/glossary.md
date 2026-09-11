# Glossary

The words this product uses, and exactly what each one means here. Terms marked **planned** are
vocabulary for behaviour that is not built yet.

**Admin**
: A workspace role. An admin can rename the workspace, invite people as member or admin, resend or
  revoke invitations, and remove members. An admin cannot remove admins or owners, change roles,
  transfer ownership, or change sign-in methods, work email domains, or deletion. See
  [Members](../use/members.md).

**Affected entity**
: Something an alert suggests is affected, before anyone has confirmed it. It carries where the
  suggestion came from, how confident it is, and how fresh. It stays a suggestion until it is
  matched to a service in your catalog, by the platform or by you.

**Alert cohort**
: Alerts that arrived from the same connection within one short burst window. Being in a cohort
  suggests what is worth comparing. It is never evidence that they share a cause.

**Approval**
: A record that a human accepted or rejected a recommended action. Approving records consent. The
  platform never runs the action itself.

**Blast radius**
: Everything affected when one service fails: its callers, sorted by how the failure reaches them.
  **Direct** means an unbroken chain of synchronous calls, so it is hard down. **Indirect** means it
  is reached across an asynchronous boundary, so it degrades. **Insulated** means a circuit breaker
  protects it. See [Service topology](topology.md).

**Catalog service**
: A service you registered, with an owner, a criticality, dependencies, repositories, deployments,
  and runbooks. A name in an alert is not a catalog service until something maps it to one.

**Causal response group**
: A direct cause and every incident it caused, worked as one response. The group shares recovery and
  lifecycle. Each member keeps its own evidence, conversation, and thread, and rejecting a causal
  link takes that incident back out.

**Connector**
: An integration with one kind of external system, such as Kubernetes or Prometheus. Every connector
  is read-only. See [Connectors](../connectors/index.md).

**Conversation**
: The single record of everything said and found about one incident. Slack and the dashboard are two
  views of it, never two separate conversations.

**Correlation**
: Which incident, if any, an incoming signal belongs to: a new problem, the same problem already
  being worked, or a recovery of an open alert. Decided separately from its disposition.

**Data source**
: One connection of a connector type. Two clusters are two Kubernetes data sources. Renaming one
  never changes its identity.

**Degraded**
: The investigation could not reach a usable conclusion, usually because the model provider was
  unavailable. The incident's own severity and status are unaffected.

**Disposition**
: The single outcome assigned to every incoming signal: investigate, ticket, or log. See
  [SRE doctrine](philosophy.md).

**Error budget**
: How much unreliability a service has left over a window: the gap between its target and what it
  actually did. It enriches, ranks, and reports. It never opens an incident.

**Evidence brief**
: What the platform posts when it cannot run a model: one section per connector you have, gathered
  directly. A connector that fails is skipped rather than failing the whole brief.

**Feedback**
: Your verdict on something the platform concluded. It is recorded alongside the original rather
  than overwriting it, so both the claim and the correction survive.

**Finding**
: One conclusion or blocker, with the evidence behind it and whether it became the incident's
  trusted assessment. A newer finding does not displace a trusted assessment just for being newer.

**Golden signals**
: Latency, traffic, errors, and saturation. Step five of the investigation sequence.

**Incident**
: One problem being worked. It has a conversation, one or more signals, an investigation, and a
  lifecycle.

**Incident lifecycle**
: What a human decided: **open**, **mitigated**, **resolved**, or **closed**. Resolved means recovery
  was verified. Closed means the case was filed without claiming recovery. Every change is explicit
  and recorded. Nothing else stands in for it.

**Incident relation**
: A recorded statement about how two incidents relate: a recurrence, a possible link, an
  evidence-backed direct cause, different causes, a merge, or a split. A merge is a human decision
  and is reversible. It never happens because two names looked similar.

**Incident role** *(planned)*
: Who is holding which responsibility during a live incident: commander, operations, communications,
  planning. Coordination only. It gates nothing.

**Installation sign-in method**
: An OpenID Connect sign-in method configured by a platform administrator for the whole
  installation, usable by every workspace. It selects a workspace through a workspace binding. The
  first one is the staff provider created at bootstrap, and only its identities can be granted
  platform administrator access. On screen: **Identity providers**.

**Investigation progress**
: How far the platform has got: **queued**, **gathering**, **assessed**, or **degraded**. Separate
  from the lifecycle, and never a substitute for it.

**Investigation run**
: One attempt to investigate, reassess, continue, or verify recovery. Each ends explicitly as
  conclusive, inconclusive, blocked by a missing capability, out of budget, or failed.

**Investigation sequence**
: The fixed ten steps the platform works through: blast radius, deploys, logs, code, golden signals,
  infrastructure, runbooks, ranked hypotheses, recommended action, escalation. See
  [How triage works](triage.md).

**Member**
: A workspace role, and the default one. A member can do everything in the workspace that is not
  reserved to owners and admins: investigate and respond to incidents, and read the active member
  list. See [Members](../use/members.md).

**Owner**
: A workspace role. An owner can do everything an admin can, and is the only role that can change
  roles, transfer ownership, remove admins and other owners, and manage workspace sign-in methods,
  work email domains, and workspace deletion. A workspace always keeps at least one active owner.
  See [Members](../use/members.md).

**Platform administrator**
: An installation-wide grant, separate from any workspace role. It gates the platform
  administration area, platform settings, and signal policy control, and it allows a time-limited,
  audited support session inside a workspace. It never implies workspace membership. See
  [Platform administration](../operate/administration.md).

**Postmortem**
: The blameless record of one incident: summary, impact, contributing causes with the evidence they
  cite, detection, resolution, lessons learned, a timeline, and action items typed **prevent**,
  **mitigate**, or **process**, each with an owner and a tracker link. There is one per incident. A
  responder generates it by declaring why the incident deserves one; it is never produced
  automatically, and every generated field passes an identifier guard so no person is named as a
  cause. Different from a runbook: a runbook says how to fix it next time, a postmortem says what
  will change. See [Incident workspace](../dashboard/incident-workspace.md#postmortem).

**Provider alert episode**
: One continuous period of an alert firing. Repeats and updates belong to the same episode. A new
  start time is a new episode, even if the message is word for word identical.

**Ranked hypothesis**
: One candidate cause, with a confidence and the evidence behind it. The platform ranks the set by
  likelihood.

**Recommended action**
: A concrete next step the platform proposes once it has a cause, with the exact command or rollback
  reference and Approve and Deny buttons. Advisory only.

**Recovery verification**
: The check that runs once every alert on an incident has cleared. It reaches one of three
  conclusions: recovered, check again later, or a human is needed. The model never changes the
  lifecycle itself.

**Response root**
: The incident at the top of a causal response group, found by following direct causes. It
  coordinates recovery and lifecycle for the group, and it is the one to work from.

**Resume**
: Continuing an open investigation from a human reply, on either surface. It builds on what was
  already found rather than starting over. Replies to one incident are answered in order.

**Runbook**
: Operational documentation the platform can retrieve during an investigation. The platform can also
  generate one from a resolved incident.

**Service dependency**
: A registered edge in the topology graph: one service calls another. It records whether the call is
  synchronous or asynchronous and whether a circuit breaker protects it, which is what decides blast
  radius. Only registered edges count.

**Signal**
: One durable external alert or human operational message classified as **investigate**, **ticket**,
  or **log**. Investigation signals may attach to an Incident; tickets and logged context can remain
  independent. Provider state is **firing**, **unknown**, or **resolved**.

**Signal source**
: Where a signal came from: a monitor, a platform observation, or a human report. It is where the
  evidence originated, never an assumption about what is broken.

**Suspect**
: A service the failing service calls directly, offered as a candidate cause. The service you were
  paged about may itself be a victim.

**Surface**
: Somewhere the platform talks to people. Today there are two: the dashboard and Slack.

**Tag**
: A free-form word on an incident, with a colon as a separator for hierarchy. Suggestions come from
  your own history, never from a fixed list.

**Tenant**
: The system model's word for a workspace. See **Workspace**.

**Tool**
: One thing the engine can call during an investigation. Every tool that touches your systems is
  read-only, scoped to your workspace, and recorded.

**Triage engine**
: The component that runs an investigation. One model provider per deployment, chosen by you, with
  no failover to another vendor. See [Triage engine](../operate/triage.md).

**Trust boundary**
: The workspace, and only the workspace. Nothing crosses between workspaces. Inside one workspace,
  roles govern administration, not visibility: owners and admins manage members and settings, but
  any member can see any of that workspace's incidents and evidence. The database enforces the
  workspace boundary; it knows nothing of roles.

  It follows that a Slack channel is an organisational convenience, not a privacy control. The
  platform may connect a mention in a public channel to an incident born in a private one, and may
  link someone to a thread they cannot open. Slack shows a non-member nothing of a private channel.

**Trusted assessment**
: The most recent conclusive investigation, promoted to the incident's brief, hypotheses, unknowns,
  next step, and cited evidence. A later run that fails or reaches no conclusion leaves it standing.

**Workspace**
: One organisation using the platform, with its own connections, members, and data. Isolation between
  workspaces is enforced by the database itself, not by application code. The system model and the
  database call this a tenant.

**Workspace binding**
: The exact mapping from one verified token claim value on an installation sign-in method to one
  workspace. A workspace sign-in method carries a binding with no claim value, because it already
  belongs to exactly one workspace. Bindings are added by a platform administrator; the platform
  never infers one from an email address.

**Workspace sign-in method**
: An OpenID Connect sign-in method configured by a workspace owner for one workspace, in
  **Workspace settings → Authentication**. It becomes usable after its work email domain passes DNS
  verification. On screen: **Company sign-in** during setup, **Sign-in methods** in settings.
