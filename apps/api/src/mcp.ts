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
import { getIncidentSummary, listActiveProviders, type Db, type SecretStore } from '@sre/db';
import type { ConnectorRegistry } from '@sre/connectors';
import { resolveTenantFromToken, type AuthDeps } from './auth';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_MCP_REQUEST_BYTES = 1024 * 1024;

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

  router.get('/.well-known/oauth-protected-resource/mcp/incidents/:incidentId', async (c) => {
    const resource = new URL(`/mcp/incidents/${c.req.param('incidentId')}`, c.req.url).toString();
    const providers = (await listActiveProviders(deps.db)).filter(
      (provider) => provider.kind === 'oidc',
    );
    return c.json({
      resource,
      authorization_servers: providers.map((provider) => provider.issuer),
      bearer_methods_supported: ['header'],
      resource_name: 'SRE Platform incident investigator',
    });
  });

  router.use(
    '/mcp/incidents/:incidentId',
    bodyLimit({
      maxSize: MAX_MCP_REQUEST_BYTES,
      onError: (c) => c.json({ error: 'payload too large' }, 413),
    }),
  );

  router.all('/mcp/incidents/:incidentId', async (c) => {
    const incidentId = c.req.param('incidentId');
    if (!UUID_RE.test(incidentId)) return c.json({ error: 'invalid incident id' }, 400);
    const resource = new URL(`/mcp/incidents/${incidentId}`, c.req.url);
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
