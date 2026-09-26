# Service topology

Topology records identities, relationships and their supporting evidence. The optional service
catalog adds ownership, corrections and declared dependencies. Neither discovery nor a declaration
proves customer impact.

Incident queue and workspace ownership use the same current service teams. An explicit incident
service assignment takes precedence over provider candidates and confirmed entity mappings. If
there is no assignment, confirmed mappings take precedence over exact catalog service identities.
The incident's original service supplies ownership only when no service context resolves. A
selected service without a team stays unowned. Conflicting identities for the same candidate key
also stay unowned until a confirmed mapping resolves that key.

Several affected services can contribute distinct teams. Assignment and catalog team changes appear
on the next read without rewriting provider signals or incident history. Removing an explicit
assignment restores the provider mapping policy. Only a workspace owner or administrator can
change these assignments; support impersonation remains read-only.

## Automatic discovery

| Source | Contributes |
| --- | --- |
| Kubernetes | Resources, ownership, routing references and explicit service-to-pod declarations |
| Argo CD | Managed resources and deployment configuration sources |
| GitHub and GitLab | Authorized repositories and service descriptors |
| Prometheus | Scrape targets and runtime references |
| Datadog | Hosts, monitors, Software Catalog declarations, optional APM calls and log traffic |
| Grafana | Dashboard and datasource references |
| StatusCake | Monitor-to-endpoint relationships |

AWS and Confluence discovery are not implemented. Coverage distinguishes unsupported capabilities
from disconnected, disabled and pending sources.

### Service declarations

Pod-level OpenTelemetry service annotations and Datadog `tags.datadoghq.com/service` labels can
declare service-to-pod associations. Service namespace and environment remain part of the identity;
cluster and Kubernetes namespace boundaries stay separate. An absent environment stays unknown.
Generic application labels, workload names and container-specific tags do not establish pod-wide
service identity.

GitHub and GitLab read `catalog-info.yaml` from authorized repository roots or configured component
paths at an immutable default-branch commit. Backstage `Component` descriptors with `spec.type:
service` declare services and component dependencies. A lifecycle such as `production` is not a
deployment environment. **Declared in** records the descriptor path and commit, not a deployed revision.

Repository discovery checks up to five repositories per batch, retaining scan progress. Descriptors
are limited to 64 KiB and fifty YAML documents. Invalid declarations, aliases and duplicate identities
are rejected; location targets and substitutions are not fetched. Only normalized identities,
references and provenance are retained. Dependencies resolve within the same repository catalog,
not by matching names across repositories. Missing descriptors establish empty evidence only after
the same commit remains readable; failures preserve earlier evidence.

Datadog hosts and monitors are independent of APM. Unambiguous service tags can declare associations;
conflicting service or environment tags remain unresolved. Host metadata, monitor queries, messages
and unrelated tags are not retained. Software Catalog uses its own identifiers and namespaces;
catalog services are not merged with APM identities by name. Catalog dependencies remain
**Declared**, not observed calls. Span and catalog failures are reported separately.

### Calls and network evidence

APM calls require paired parent/child spans. Optional Datadog log discovery records sampled ingress
and gRPC requests scoped to this workspace's Kubernetes inventory. Endpoint bindings must cover the
request's observation time. Re-reading an old request does not make it current, and sampled silence
does not remove a dependency. See [Datadog](../connectors/datadog.md#what-it-can-read) for setup and limits.

Runtime calls become logical service calls only when both endpoints have explicit, unambiguous
service bindings. Image-derived log labels, loopback addresses, counters and shared namespaces do
not establish these bindings. Ownership, routing and monitoring links remain separate from calls.

The built-in network probe adds stored investigation evidence to exact HTTP endpoints. DNS matches
the hostname; TCP and TLS also match the port; HTTP matches the full URL. Topology does not send new
probes. Failures, timestamps and source investigations remain visible, but response headers and
certificate identity fields are not copied. An HTTP status from an `https` check keeps its certificate
verdict, so a status from an untrusted peer is shown as such. When that check withheld the URL's path from
an untrusted peer, only the verdict is kept, because the status was measured on a different path. Shared infrastructure does not establish service ownership.

### Coverage and retention

Completeness applies to each collection, not the whole provider. Partial or failed reads retain prior
evidence within storage limits. Observation time remains separate from inventory sightings, so a
returned resource can remain inventoried without its old evidence becoming fresh. Disabling,
replacing or deleting a connection invalidates its previous configuration generation's evidence.

| Limit | Behaviour |
| --- | --- |
| HTTP reads | 2 MiB per response, eight seconds per request, 45 seconds per collection |
| Retained collection | Up to 10,000 entities and 10,000 relationships |
| Serialized data | 4 MB UTF-8 per incoming discovery and per retained collection |
| Immediate pagination | Up to twenty continuations before returning to the periodic schedule |

Dropped facts, response-size limits and exhausted budgets make coverage incomplete. Merely reaching
an inventory limit without dropping facts does not. Retention keeps whole facts, favoring recent
sightings. Authentication, TLS verification and destination restrictions still apply.

Paginated sources retain progress by tenant and connection generation. Continuations read only
available collections whose cursor advanced; they do not restart completed collections.
Partial child-read failures retain coverage gaps without blocking progress. Rate limits pause
immediate continuation and defer the connection's next pass by at least five minutes. A throttled
Grafana dashboard page is read again rather than skipped. The next periodic pass includes every
collection again; Argo CD keeps a cursor for each configured project.

Each connection has at most one waiting pass. Every pass reads the provider's current state, so a
pass that arrives while another waits is absorbed rather than queued behind it. When a periodic
pass meets a waiting page continuation, the waiting pass is widened to read every collection, so the
cycle skips none of them. A slow connection therefore delays its own discovery without multiplying
reads against the other providers.

Only a completed scan without gaps removes unseen old facts. Failed or expired scans retain prior
evidence with its original time. An expired Kubernetes cursor restarts the scan instead of mixing
snapshots. Late results from older attempts cannot overwrite newer reads. See
[Kubernetes pagination](https://kubernetes.io/docs/reference/using-api/api-concepts/#retrieving-large-results-sets-in-chunks).

## Service identity

A catalog service is a logical application, not a namespace or deployment name. Automatic discovery
keeps service and resource identities separate. Similar names, shared infrastructure and shared
repositories do not merge them. Ambiguous references stay unresolved.

Optional catalog runtime mappings identify a Kubernetes connection, namespace, environment and,
where needed, application label. Several environments can belong to one catalog service, but two
clusters with the same namespace remain separate scopes. Environment filters select observations;
they do not rewrite identity. Deployments without an environment do not match a specific filter.

## Evidence and health

Runtime health summarizes collected pods, not service availability or latency. Reliability comes
from configured objectives and measured SLI queries. A topology filter does not rewrite those queries.

Automatic runtime reads match exact provider objects in the current connection generation; they do
not require catalog mappings. The dashboard and investigation tools share this reader. Stale,
failed or incomplete collection cannot establish healthy runtime. Current unhealthy observations
can still support investigation when coverage is partial. Healthy samples alone do not prove recovery.

## Source evidence

Infrastructure incidents retain exact server-observed resource identifiers. Fresh, unambiguous
runtime links may identify their service. Sharing a controller does not implicate sibling services;
without a service link, the resource remains inspectable but service impact stays unknown.

Source resolution follows exact runtime references through controller ownership and Argo CD
management, not sibling workloads. Pod source annotations are declarations; Argo CD paths and
revisions describe deployment configuration. Neither proves image provenance.

Source reads require a currently authorized repository, an immutable recorded revision and a path
inside its associated component. Missing revisions never fall back to a moving branch; ambiguous
identity never falls back to a similarly named repository. Code search supplies candidate paths
that must be read again at the correct revision and within both authorized scopes.

Before returning content, the reader rechecks the association, revision, component, repository
authorization and connection generation. Changed or unverifiable access discards the content and
reports **source changed**. A newer observation of the same unchanged association does not invalidate it.
Human-confirmed catalog context remains usable when that service has no automatic identity.

Bounded source files are redacted before selecting numbered line excerpts, preserving line numbers
without exposing multiline credential fragments. GitHub reads immutable Git trees and regular-file
blobs. Symlinks, submodules, incomplete trees and paths deeper than 32 segments are unavailable.
Source content is untrusted evidence, not permission to change systems or establish mappings.

## Declared relationships

A dependency points from caller to downstream service. A declaration can record environment,
protocol, sync/async behaviour, a circuit breaker, and a reason and confirmation time. Older
declarations without confirmation remain unverified. None is a measured live call.

Unspecified-environment declarations are included conservatively in scoped impact analysis.
They do not prove the call exists in every environment.

## Blast radius

Impact calculation starts from an exact scoped service identity and follows current discovered
calls and catalog declarations to potentially exposed callers. Stale, inferred and unresolved call
edges do not establish current impact. A shared name is ambiguous until an exact identity or scope
resolves it.

Catalog fallback preserves a requested environment. A service name alone cannot establish cluster,
namespace, connection, project or service-namespace scope. If discovery cannot resolve those
constraints, impact stays unavailable rather than broadening to the whole catalog. A manual,
incident-wide catalog assignment is a separate unscoped choice.

Traversal continues beyond async and circuit-breaker boundaries:

| Exposure | Interpretation |
| --- | --- |
| Synchronous | A synchronous path without a declared breaker |
| Dependency behavior unknown | Evidence does not establish sync/async behaviour |
| Async | A path crosses asynchronous processing; impact may be delayed |
| Breaker on path | A path crosses a declared breaker; fallback still needs verification |

Queues may delay impact, and breakers may return errors without useful fallback. Neither proves
protection. Multiple paths retain the least protected result reached within the depth limit;
depth-limited results warn that more callers may exist. The service's own dependencies are listed
as investigation candidates, not confirmed causes. No known callers does not mean no dependencies.

Incident matching uses the same scoped identity rules. Human corrections, structured candidates
and original signals remain separate. Classifier confidence alone does not establish an affected service.

## Historical declarations

History reconstructs retained declarations at a selected time. It does not invent records before
tracking began or present current health, ownership and incidents as historical observations.

See [Topology](../dashboard/topology.md) for the operating workflow.
