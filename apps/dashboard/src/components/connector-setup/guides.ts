import type { ManagedConnectorType } from '../connectorPresentation';

export interface ConnectorGuide {
  prerequisite: string;
  steps: readonly string[];
  verification: string;
  documentation: string;
}

export const CONNECTOR_GUIDES: Record<ManagedConnectorType | 'slack', ConnectorGuide> = {
  github: {
    prerequisite:
      'Permission to manage a dedicated GitHub App and install it on the target account or organization.',
    steps: [
      'Choose New dedicated App to let GitHub generate its credentials, or Existing dedicated App to supply your own. Do not reuse an App whose webhook belongs to another integration.',
      'For an existing App, open account or organization Settings → Developer settings → GitHub Apps → Edit. Copy its App ID or client ID, not an installation ID or OAuth client secret.',
      'Use your existing private key PEM and webhook secret if available. If you no longer have the key, generate a replacement under Private keys. Paste the complete PEM, including BEGIN and END lines. The webhook secret must match GitHub and contain at least 16 characters.',
      'Grant Contents read access. Add read access to Pull requests, Actions, and Deployments for that evidence. Remove write permissions. Install the App on the repositories you want to investigate and accept any permission updates.',
      'For an existing App, copy the Webhook URL shown below into GitHub and keep SSL verification enabled. The address is ready before saving. Check the installation and coverage, save in SRE Platform, then redeliver a ping from Advanced → Recent Deliveries. New dedicated Apps receive their webhook configuration automatically.',
    ],
    verification:
      'Code access and event delivery are separate checks. A successful repository read does not prove GitHub can deliver a webhook. Check the first signed event on the connector card.',
    documentation:
      'https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app',
  },
  gitlab: {
    prerequisite:
      'A group-scoped read_api token with Reporter access. Configuring hooks separately requires Maintainer access to projects or Owner access to the group.',
    steps: [
      'Enter the GitLab instance URL, such as https://gitlab.example.com, and the group path, such as acme/platform. Do not paste a project URL into either field.',
      'Reuse an existing valid read-only group token, or create one using the instructions below if needed. When editing this connection, leave the token blank to keep it. Check access to discover projects and subgroups.',
      'Review the coverage, then choose event delivery. Public delivery uses the platform’s configured API automatically. Use Smee for local development, or Configure later for code access only.',
      'Save and verify. If configuring events, review and run the generated hook command using your own authorized GitLab CLI session. The stored read-only token cannot create hooks.',
      'Send a Push event from the GitLab hook Test menu. Check the connector card for the first authenticated delivery. Re-run project-hook setup when adding projects; group hooks cover the group when supported.',
    ],
    verification:
      'If code access succeeds but no events arrive, check the hook URL, signing configuration, selected events, and delivery response in GitLab. Follow the wizard’s instance-version checks.',
    documentation: 'https://docs.gitlab.com/user/project/integrations/webhooks/',
  },
  kubernetes: {
    prerequisite:
      'An existing read-only service account token, or kubectl permission to install dedicated access. The platform server must be able to reach the cluster API.',
    steps: [
      'Confirm the target with kubectl config current-context. Enter a cluster name, its HTTPS API server address, and optionally one namespace. This is the Kubernetes API, not a dashboard URL.',
      'In Access, choose Use existing access if read-only RBAC is already installed. Existing connections can keep their stored credential. Choose Create dedicated access only when you need new permissions.',
      'In Credentials, paste your existing service account token and cluster CA if needed. The dedicated-access path provides installation and credential commands. Never use your personal kubeconfig or an administrator token.',
      'Use system certificate trust or the cluster CA. Disabling certificate verification is not a fix for an unreachable API.',
      'Review the scope, save, and verify. Reusing access does not modify RBAC. Only remove dedicated resources when no other connection or application uses them.',
    ],
    verification:
      'Verification checks connectivity and allowed reads. For a timeout, check server-side routing and network policies. For forbidden reads, compare the installed RBAC with the selected namespace.',
    documentation:
      'https://kubernetes.io/docs/reference/access-authn-authz/service-accounts-admin/',
  },
  argocd: {
    prerequisite:
      'An Argo CD HTTPS endpoint, or an internal HTTP endpoint with explicit risk acknowledgement, and dedicated project-role tokens or permission to install roles for the selected AppProjects.',
    steps: [
      'Enter the Argo CD server URL, such as https://argocd.example.com, without an application page path. Choose system trust or supply its private CA.',
      'Use an authenticated Argo CD CLI to list projects. Select only the projects and applications this workspace needs. Match the applications-in-any-namespace option to your Argo CD configuration.',
      'In Access, choose Use existing project access and enter the dedicated role name used in each selected project. Paste one existing token per project, or leave it blank to keep an unchanged stored token. Do not use a global admin token.',
      'Choose Generate dedicated access only if you need a new role. Run the displayed commands yourself. A role already assigned to another data source cannot be reused here; manage that connection instead.',
      'Review the application scope, save, and check each project’s verification result. A token for one project does not grant access to another.',
    ],
    verification:
      'Application reads are verified per project. If access fails, check token expiry, project name, application pattern, and certificate trust. No incoming webhook is required.',
    documentation: 'https://argo-cd.readthedocs.io/en/stable/user-guide/projects/',
  },
  datadog: {
    prerequisite:
      'Your Datadog site, an organization API key, and a scoped application key. Existing valid keys can be reused.',
    steps: [
      'Select the site where your Datadog organization lives, not the location of your monitored servers. For example, app.datadoghq.eu uses datadoghq.eu.',
      'Reuse your existing API key and scoped application key. Create new keys only if needed; leave both fields blank when editing to keep the stored pair.',
      'If creating an API key, open Datadog Organization Settings → API Keys.',
      'If creating an application key, open Organization Settings → Application Keys and use a dedicated service account where available. Grant the read permissions needed for monitors, metrics, logs, spans, and events; do not grant write access for this connector.',
      'Paste the API key and application key into their separate fields. A browser client token is not an API key. Save the application key securely when created.',
      'Review and save. Verification checks the API key and an authenticated monitor read; other tools also depend on their own permissions and your Datadog plan.',
    ],
    verification:
      'For authentication failures, check that both keys belong to the selected site and organization. A permission error requires the relevant read scope, not a different endpoint. No webhook is required.',
    documentation: 'https://docs.datadoghq.com/account_management/api-app-keys/',
  },
  grafana: {
    prerequisite:
      'The Grafana URL and a service account token for the target organization. Existing read-only service accounts and tokens can be reused.',
    steps: [
      'Enter your Grafana instance URL, such as https://grafana.example.com, not a dashboard /d/ link, Prometheus URL, or Grafana Cloud metrics ingestion endpoint.',
      'Reuse a service account with Viewer access to the required resources. If needed, create one in Administration → Users and access → Service accounts.',
      'Paste an existing service account token in Credentials, or generate one if needed. When editing, leave it blank to keep the stored token. Do not use a user password or Cloud telemetry access-policy token.',
      'For a private CA, paste the CA certificate. Confirm the platform server can reach Grafana, then review, save, and verify.',
    ],
    verification:
      'A successful authentication check does not grant access to restricted folders. Check resource permissions if a particular dashboard or alert is unavailable. Raw backend metrics require their own connector; no webhook is required here.',
    documentation: 'https://grafana.com/docs/grafana/latest/administration/service-accounts/',
  },
  prometheus: {
    prerequisite:
      'A Prometheus HTTP API reachable from the platform, plus its read credential if required. Alertmanager delivery is a separate optional setup.',
    steps: [
      'Enter the Prometheus server base URL, such as https://prometheus.example.com. Do not enter an Alertmanager address, graph page, or /api/v1/query path.',
      'Choose the authentication actually required by that endpoint or its proxy. Paste the matching credential in the next step. Use your private CA for internal certificates.',
      'For Alertmanager delivery, first connect Slack and choose the incident channel. Choose public API delivery for a deployed platform, Smee for local development, or Configure later to keep metrics access only.',
      'Save and verify metrics access. If enabling Alertmanager delivery, copy the generated receiver configuration, including send_resolved, into the existing receiver. Keep existing Slack delivery and routing intact.',
      'Have your monitoring administrator validate and reload Alertmanager configuration. Check the connector card after the first authenticated notification; a metrics read alone does not verify event delivery.',
    ],
    verification:
      'Check metrics authentication separately from Alertmanager delivery. No notification received does not mean the API credential is wrong. Keep receiver tokens out of source control.',
    documentation: 'https://prometheus.io/docs/alerting/latest/configuration/',
  },
  statuscake: {
    prerequisite: 'A StatusCake API bearer token for the account containing your monitoring tests.',
    steps: [
      'Reuse a valid StatusCake API token. If needed, create one in Integrations → API. When editing, leave it blank to keep the stored token.',
      'Paste the token below. Do not enter a legacy username/API-key pair or a notification webhook URL. The API host is selected by the platform.',
      'Review and save. Verification reads the uptime-test listing; investigation can then request supported monitoring evidence.',
    ],
    verification:
      'If rejected, check token validity and account access. An empty test list can be legitimate. This is read-only investigation access, not incoming alert delivery; no webhook is required.',
    documentation: 'https://developers.statuscake.com/api/',
  },
  slack: {
    prerequisite:
      'An existing Slack App dedicated to this connection, or permission to create one. Socket Mode uses an outbound connection, so no public webhook URL is needed.',
    steps: [
      'Open your existing App at api.slack.com/apps, or create one if needed. Do not share it with another active Socket Mode consumer. Under OAuth & Permissions, check bot scopes: app_mentions:read, channels:history, channels:read, chat:write, files:read, and users:read. Add groups:read and groups:history for private channels, and users:read.email for email attribution.',
      'Enable Socket Mode. Reuse an app-level token with connections:write, or generate one in Basic Information → App-Level Tokens. Paste this xapp- token into App token; leave it blank when editing to keep it.',
      'Enable Event Subscriptions and subscribe to bot events message.channels and app_mention; add message.groups for private channels. Enable Interactivity for message buttons.',
      'Install or reinstall the App after changing scopes. From OAuth & Permissions, copy the Bot User OAuth Token, starting xoxb-, into Bot token. Both tokens must belong to the same App.',
      'Save and verify, invite the bot to the intended channels, then select the channels to listen to in the platform. Send a test message in a subscribed channel and check its receipt.',
    ],
    verification:
      'Valid tokens do not prove channel delivery. Check Socket Mode, event subscriptions, bot channel membership, and the platform’s channel selection if messages are missing.',
    documentation: 'https://docs.slack.dev/apis/events-api/using-socket-mode/',
  },
};
