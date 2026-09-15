import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  OAuthError,
  OAuthErrorCode,
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  requireBearerAuth,
  type AuthInfo,
} from '@modelcontextprotocol/server';
import {
  connectorTools,
  makeDbAuditSink,
  makeDbConnectorProvider,
  makeInvestigatorMcpServer,
  makeInvestigateCodeTool,
  makeResolveEntityContextTool,
  makeSearchIncidentEvidenceTool,
  type ToolContext,
} from '@sre/agent-tools';
import { getActiveOidcProviderById, getIncidentSummary, type Db, type SecretStore } from '@sre/db';
import type { ConnectorRegistry } from '@sre/connectors';
import { resolveTenantFromToken, type AuthDeps } from './auth';
import { UUID_RE } from './incidents/support';

const MAX_MCP_REQUEST_BYTES = 1024 * 1024;
/**
 * One answer for every unusable provider or identifier, so a caller cannot learn WHY a provider is
 * unusable: disabled, non-OIDC and unknown are the same refusal. A usable provider still answers
 * 200, because RFC 9728 discovery is an existence signal by design and a v4 provider id is not
 * guessable. A malformed id short-circuits before the query, which separates only "is a UUID" from
 * "is not", which the caller already knows for free.
 */
const RESOURCE_NOT_FOUND = { error: 'protected resource not found' } as const;

interface McpPrincipal {
  tenantId: string;
  incidentId: string;
  service: string;
}

function principal(authInfo: AuthInfo | undefined): McpPrincipal {
  const extra = authInfo?.extra;
  if (
    !extra ||
    typeof extra.tenantId !== 'string' ||
    typeof extra.incidentId !== 'string' ||
    typeof extra.service !== 'string'
  )
    throw new Error('missing MCP incident principal');
  return {
    tenantId: extra.tenantId,
    incidentId: extra.incidentId,
    service: extra.service,
  };
}

export function mcpRoutes(deps: {
  auth: AuthDeps;
  db: Db;
  registry: ConnectorRegistry;
  secrets: SecretStore;
}) {
  const router = new Hono();
  const connectorProvider = makeDbConnectorProvider({
    db: deps.db,
    registry: deps.registry,
    secrets: deps.secrets,
  });
  const audit = makeDbAuditSink({ db: deps.db });
  const handler = createMcpHandler(async ({ authInfo }) => {
    const identity = principal(authInfo);
    const connectors = await connectorProvider(identity.tenantId)();
    const connectorToolSet = connectors
      .filter(
        (connector) =>
          connector.capabilities?.availability !== 'incomplete' &&
          connector.capabilities?.investigation !== 'none',
      )
      .flatMap(connectorTools);
    const tools = [
      makeSearchIncidentEvidenceTool({ db: deps.db }),
      makeInvestigateCodeTool({ db: deps.db }),
      makeResolveEntityContextTool({ db: deps.db }),
      ...connectorToolSet,
    ];
    const context: ToolContext = {
      ...identity,
      resolveConnectors: connectorProvider(identity.tenantId),
      audit,
    };
    return makeInvestigatorMcpServer(tools, context);
  });

  // The resource is addressed per identity provider so its metadata can advertise exactly the one
  // authorization server that can mint a token for it, instead of every provider the deployment has.
  const RESOURCE_PATH = '/mcp/providers/:providerId/incidents/:incidentId';

  for (const path of [
    '/mcp/incidents/:incidentId',
    '/.well-known/oauth-protected-resource/mcp/incidents/:incidentId',
  ]) {
    router.all(path, (c) =>
      c.json(
        {
          error:
            'This MCP address has been retired. Update your client to /mcp/providers/{providerId}/incidents/{incidentId}, using the sign-in method that issued your token.',
        },
        410,
      ),
    );
  }

  /** Resolves the addressed provider, or null for anything a client must not be able to tell apart. */
  async function addressedProvider(providerId: string, incidentId: string) {
    if (!UUID_RE.test(providerId) || !UUID_RE.test(incidentId)) return null;
    return getActiveOidcProviderById(deps.db, providerId);
  }

  // The advertised resource and the one the bearer gate checks the token against must be the same
  // string, so the path is built in one place rather than spelled out at each route.
  function resourceUrl(requestUrl: string, providerId: string, incidentId: string): URL {
    return new URL(`/mcp/providers/${providerId}/incidents/${incidentId}`, requestUrl);
  }

  router.get(`/.well-known/oauth-protected-resource${RESOURCE_PATH}`, async (c) => {
    const incidentId = c.req.param('incidentId');
    const provider = await addressedProvider(c.req.param('providerId'), incidentId);
    if (!provider) return c.json(RESOURCE_NOT_FOUND, 404);
    // Deliberately no incident lookup: metadata describes the resource, and querying it here would
    // turn an unauthenticated discovery document into an incident-existence oracle.
    return c.json({
      // `provider.id`, not the path segment: a uuid literal accepts upper-case hex on input but
      // Postgres always returns the lower-case canonical form, so advertising the raw segment would
      // point clients at a URL whose provider comparison below can never match.
      resource: resourceUrl(c.req.url, provider.id, incidentId).toString(),
      authorization_servers: [provider.issuer],
      bearer_methods_supported: ['header'],
      resource_name: 'SRE Platform incident investigator',
    });
  });

  router.use(
    RESOURCE_PATH,
    bodyLimit({
      maxSize: MAX_MCP_REQUEST_BYTES,
      onError: (c) => c.json({ error: 'payload too large' }, 413),
    }),
  );

  router.all(RESOURCE_PATH, async (c) => {
    const incidentId = c.req.param('incidentId');
    const provider = await addressedProvider(c.req.param('providerId'), incidentId);
    if (!provider) return c.json(RESOURCE_NOT_FOUND, 404);
    // The canonical id the database returned, so an upper-case hex path segment addresses the same
    // resource the metadata document advertises and compares equal to the resolved provider below.
    const providerId = provider.id;
    const resource = resourceUrl(c.req.url, providerId, incidentId);
    const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resource);
    const gate = requireBearerAuth({
      requiredScopes: ['mcp'],
      resourceMetadataUrl,
      verifier: {
        async verifyAccessToken(token): Promise<AuthInfo> {
          const resolution = await resolveTenantFromToken(deps.auth, token);
          // A resolved token always carries an expiry now, so the only failure mode left here
          // is the resolution itself.
          if (!resolution.ok) throw new OAuthError(OAuthErrorCode.InvalidToken, 'invalid token');
          // The path says which provider a client believes it used; `resolution.providerId` is the
          // one that actually verified the token. Comparing them only AFTER resolution succeeded
          // keeps the verifier's fail-closed behaviour intact: when two active providers share an
          // issuer it resolves nothing at all, and the path must never supply the missing answer.
          if (resolution.providerId !== providerId)
            throw new OAuthError(OAuthErrorCode.InvalidToken, 'invalid token');
          return {
            token,
            clientId: resolution.tenant.sub,
            scopes: resolution.scopes,
            expiresAt: resolution.tenant.expiresAt,
            resource,
            extra: { tenantId: resolution.tenant.tenantId },
          };
        },
      },
    });
    const authorization = await gate(c.req.raw);
    if (authorization instanceof Response) return authorization;
    const tenantId = authorization.extra?.tenantId;
    if (typeof tenantId !== 'string') return c.json({ error: 'invalid token context' }, 401);
    const incident = await getIncidentSummary(deps.db, tenantId, incidentId);
    if (!incident) return c.json({ error: 'incident not found' }, 404);
    const authInfo: AuthInfo = {
      ...authorization,
      extra: { tenantId, incidentId, service: incident.service },
    };
    return handler.fetch(c.req.raw, { authInfo });
  });

  return router;
}
