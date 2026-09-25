import type { Hono } from 'hono';
import type { AuthVariables } from './auth';
import type { AppDeps } from './app';
import { alertmanagerWebhookRoutes } from './alertmanager-webhook';
import { statusCakeLifecycleWebhookRoutes } from './statuscake-lifecycle-webhook';
import { providerLifecycleWebhookRoutes } from './provider-lifecycle-webhook';

/** Public provider routes authenticate their own event credentials before tenant writes. */
export function registerProviderLifecycleRoutes(
  app: Hono<{ Variables: AuthVariables }>,
  deps: AppDeps,
): void {
  if (!deps.adminDb || !deps.alertmanager) return;
  const native = {
    adminDb: deps.adminDb,
    appDb: deps.appDb,
    secrets: deps.secrets,
    ...deps.alertmanager,
    log: deps.log,
  };
  app.route('/webhooks/alertmanager', alertmanagerWebhookRoutes(native));
  app.route('/webhooks/statuscake', statusCakeLifecycleWebhookRoutes(native));
  for (const provider of ['datadog', 'grafana'] as const)
    app.route(
      `/webhooks/${provider}`,
      providerLifecycleWebhookRoutes(native, provider, deps.registry),
    );
}
