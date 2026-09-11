/**
 * The documentation screenshot list.
 *
 * One entry per dashboard view the guide explains. Desktop captures retain the existing
 * `<file>-<theme>.png` names; narrow captures add `-mobile` before the theme.
 */
export interface Shot {
  /** Base file name, without theme suffix or extension. */
  file: string;
  /** Route to visit. `:incident` is replaced with the demo incident id. */
  path: string;
  /** Element that must be visible before the shot is taken. */
  waitFor: string;
  /** Skip the signed-in session, for the sign-in screen. */
  anonymous?: boolean;
  /** Button to press before the shot, by visible text. */
  click?: string;
  /** Viewport names where the optional button is rendered. Defaults to every viewport. */
  clickSizes?: string[];
  /** Heading that proves the requested state rendered before capture. */
  expectedHeading?: string;
  /** Non-sensitive tab state needed to reach a resumable public step. */
  sessionStorage?: Record<string, string>;
}

export const SCREENSHOT_MATRIX = [
  { name: 'desktop', viewport: { width: 1440, height: 960 }, themes: ['light', 'dark'] },
  { name: 'mobile', viewport: { width: 390, height: 844 }, themes: ['light', 'dark'] },
] as const;

export const SHOTS: Shot[] = [
  { file: 'landing', path: '/', waitFor: 'main', anonymous: true },
  { file: 'sign-in', path: '/sign-in', waitFor: 'main', anonymous: true },
  {
    file: 'workspace-sign-in',
    path: '/local-dev',
    waitFor: 'main',
    anonymous: true,
    expectedHeading: 'Local dev (dev@example.test)',
  },
  { file: 'login', path: '/login', waitFor: 'main', anonymous: true },
  {
    file: 'get-started-workspace',
    path: '/get-started',
    waitFor: 'main',
    anonymous: true,
    expectedHeading: 'Create your workspace',
  },
  {
    file: 'get-started-sign-in',
    path: '/get-started',
    waitFor: 'main',
    anonymous: true,
    expectedHeading: 'Connect company sign-in',
    sessionStorage: {
      'sre-platform.workspace-draft': JSON.stringify({
        requestedName: 'Acme Engineering',
        slug: 'acme-engineering',
      }),
    },
  },
  { file: 'members', path: '/w/settings/members', waitFor: 'main' },
  { file: 'domain', path: '/w/settings/domains/demo', waitFor: 'main' },
  { file: 'account-menu', path: '/w', waitFor: 'main', click: 'Account menu' },
  { file: 'notifications', path: '/w/notifications', waitFor: 'main' },
  { file: 'overview', path: '/w', waitFor: 'main' },
  { file: 'incidents', path: '/w/incidents', waitFor: 'main' },
  { file: 'incident-detail', path: '/w/incidents/:incident', waitFor: 'main' },
  { file: 'infrastructure', path: '/w/infrastructure', waitFor: 'main' },
  { file: 'deployments', path: '/w/deployments', waitFor: 'main' },
  { file: 'changes', path: '/w/changes', waitFor: 'main' },
  {
    file: 'topology',
    path: '/w/topology',
    waitFor: 'main',
    click: 'Fit services',
    clickSizes: ['desktop'],
  },
  { file: 'connectors', path: '/w/connectors', waitFor: 'main' },
  { file: 'inbound', path: '/w/surfaces', waitFor: 'main' },
  { file: 'usage', path: '/w/usage', waitFor: 'main' },
  { file: 'settings', path: '/w/settings', waitFor: 'main' },
  { file: 'admin-registrations', path: '/admin', waitFor: 'main' },
  { file: 'admin-workspaces', path: '/admin/workspaces', waitFor: 'main' },
  { file: 'admin-users', path: '/admin/users', waitFor: 'main' },
  { file: 'admin-providers', path: '/admin/providers', waitFor: 'main' },
  { file: 'admin-settings', path: '/admin/settings', waitFor: 'main' },
  { file: 'admin-audit', path: '/admin/audit', waitFor: 'main' },
];

/** One step of a connect wizard, captured as its own image. */
export interface WizardStep {
  /** Base file name for this step. */
  file: string;
  /** Text inputs to fill before the shot, by accessible label. */
  fill?: [label: string, value: string][];
  /** Radios or checkboxes to select before the shot, by accessible name. */
  choose?: string[];
  /** Selector that must be visible before the shot, for a step that loads data. */
  waitFor?: string;
  /** Button that moves to the next step. Absent on the last step captured. */
  advance?: string;
}

export interface Wizard {
  /** Catalog button that opens the wizard. */
  open: string;
  /** Page the button lives on. Defaults to the connector catalog. */
  route?: string;
  /**
   * The wizard's complete step sequence, exactly as its progress bar renders it.
   *
   * Asserted against the live UI on every run. Renaming, adding, or removing a step in the product
   * fails the capture, which is what stops the guide's step-by-step pages drifting away from the
   * screens they describe.
   */
  names: string[];
  steps: WizardStep[];
  /**
   * Control-plane responses to fulfil in the browser, by URL fragment.
   *
   * GitLab and GitHub gate their middle steps on a provider lookup: GitHub pins its API host in
   * code and GitLab demands publicly trusted HTTPS, so neither can be pointed at a local stub
   * without weakening a guard that exists for good reason. Fulfilling the platform's own discovery
   * response in the page instead leaves every guard intact and still renders the real UI.
   */
  intercept?: { url: string; json: unknown }[];
}

const GITLAB_DISCOVERY = {
  group: {
    id: 42,
    name: 'Acme',
    fullPath: 'acme',
    webUrl: 'https://gitlab.example.com/acme',
  },
  instance: { version: '19.1.0', enterprise: false },
  projects: [
    'acme/checkout-api',
    'acme/payments-gateway',
    'acme/orders-service',
    'acme/inventory-service',
    'acme/platform/notification-worker',
  ].map((pathWithNamespace, index) => ({
    id: 1000 + index,
    name: pathWithNamespace.split('/').pop(),
    pathWithNamespace,
    webUrl: `https://gitlab.example.com/${pathWithNamespace}`,
    defaultBranch: 'main',
    visibility: 'private',
    archived: false,
  })),
};

const GITHUB_INSTALLATIONS = {
  installations: [
    {
      id: 51234567,
      accountLogin: 'acme',
      accountType: 'Organization',
      repositorySelection: 'all',
      permissions: { contents: 'read', metadata: 'read', deployments: 'read', actions: 'read' },
      appSlug: 'acme-sre-platform',
    },
  ],
};

const GITHUB_REPOSITORIES = {
  repositories: [
    'checkout-api',
    'payments-gateway',
    'orders-service',
    'inventory-service',
    'notification-worker',
  ].map((name, index) => ({
    id: 2000 + index,
    owner: 'acme',
    name,
    fullName: `acme/${name}`,
    defaultBranch: 'main',
    private: true,
    archived: false,
    webUrl: `https://github.com/acme/${name}`,
  })),
};

/**
 * The connect wizards, walked one step at a time.
 *
 * Only steps reachable without a live third-party system are listed. A step that renders solely
 * from provider data (GitLab project discovery, a GitHub App installation) and the final Verify
 * step of every wizard both need credentials against a real system, so they are described in prose
 * rather than captured from invented data.
 *
 * Field values are examples matching each field's own placeholder. None is a credential: the walk
 * always stops before Save and verify, so nothing is ever submitted.
 */
export const WIZARDS: Wizard[] = [
  {
    open: 'Connect Slack',
    route: '/w/connectors?connection=slack',
    // The demo tenant already has Slack connected, so the first-run screen the guide describes is
    // only reachable by answering the surfaces list as it looks before anything is connected.
    intercept: [{ url: '/surfaces', json: { surfaces: [] } }],
    names: ['Credentials', 'Review', 'Verify'],
    steps: [
      {
        file: 'connect-slack-1-credentials',
        fill: [
          ['App token', 'xapp-1-A012BCDEF34-0000000000000-example'],
          ['Bot token', 'xoxb-0000000000-0000000000000-exampletokenvalue'],
        ],
        advance: 'Next',
      },
      { file: 'connect-slack-2-review' },
    ],
  },
  {
    open: 'Add Kubernetes',
    names: ['Cluster', 'Access', 'Credentials', 'Review', 'Verify'],
    steps: [
      {
        file: 'add-kubernetes-1-cluster',
        fill: [
          ['Cluster name', 'prod-us-east'],
          ['API server URL', 'https://api.k8s.example.com'],
        ],
        advance: 'Continue',
      },
      // The install command is generated by the platform, so this step has to finish loading
      // before it reads as anything but a skeleton.
      {
        file: 'add-kubernetes-2-access',
        choose: ['Create dedicated access'],
        waitFor: 'dialog[open] pre',
        advance: 'Continue',
      },
      {
        file: 'add-kubernetes-3-credentials',
        fill: [['Service account token', 'eyJhbGciOiJSUzI1NiIsImtpZCI6ImV4YW1wbGUifQ.example']],
        advance: 'Review',
      },
      { file: 'add-kubernetes-4-review' },
    ],
  },
  {
    open: 'Add Prometheus & Alertmanager',
    names: ['Metrics endpoint', 'Metrics credential', 'Alertmanager delivery', 'Review', 'Verify'],
    intercept: [
      {
        url: '/connectors/prometheus/prepare-delivery',
        json: {
          setupId: '00000000-0000-4000-8000-000000000099',
          webhookPath: '/webhooks/alertmanager/00000000-0000-4000-8000-000000000099',
          smeeUrl: 'https://smee.io/example-development-channel',
        },
      },
    ],
    steps: [
      {
        file: 'add-prometheus-1-endpoint',
        fill: [['Prometheus base URL', 'https://prometheus.example.com']],
        advance: 'Continue',
      },
      { file: 'add-prometheus-2-credential', advance: 'Continue' },
      // "Configure later" is the reads-only path, and the only one that advances without a live
      // Slack channel and relay.
      { file: 'add-prometheus-3-delivery', choose: ['Configure later'], advance: 'Review' },
      { file: 'add-prometheus-4-review' },
    ],
  },
  {
    open: 'Add Argo CD',
    names: ['Server', 'Projects', 'Access & tokens', 'Review', 'Verify'],
    steps: [
      {
        file: 'add-argocd-1-server',
        fill: [['Argo CD server URL', 'https://argocd.example.com']],
        advance: 'Continue',
      },
      {
        file: 'add-argocd-2-projects',
        fill: [
          ['Argo CD project 1', 'production'],
          ['Argo CD application 1.1', 'checkout-api'],
        ],
        advance: 'Continue',
      },
      {
        file: 'add-argocd-3-access',
        choose: ['Generate dedicated access'],
        fill: [['Argo CD token for production', 'argocd.example.token']],
        advance: 'Review',
      },
      { file: 'add-argocd-4-review' },
    ],
  },
  {
    open: 'Add Datadog',
    names: ['Connection', 'Credentials', 'Review', 'Verify'],
    steps: [
      { file: 'add-datadog-1-connection', advance: 'Credentials' },
      {
        file: 'add-datadog-2-credentials',
        fill: [
          ['API key', 'datadog-example-api-key'],
          ['Application key', 'datadog-example-application-key'],
        ],
        advance: 'Review',
      },
      { file: 'add-datadog-3-review' },
    ],
  },
  {
    open: 'Add Grafana',
    names: ['Connection', 'Credentials', 'Review', 'Verify'],
    steps: [
      {
        file: 'add-grafana-1-connection',
        fill: [['Grafana base URL', 'https://grafana.example.com']],
        advance: 'Credentials',
      },
      {
        file: 'add-grafana-2-credentials',
        fill: [['Service account token', 'grafana-example-service-account-token']],
        advance: 'Review',
      },
      { file: 'add-grafana-3-review' },
    ],
  },
  {
    open: 'Add StatusCake',
    names: ['API token', 'Review', 'Verify'],
    steps: [
      {
        file: 'add-statuscake-1-token',
        fill: [['API token', 'statuscake-example-api-token']],
        advance: 'Review',
      },
      { file: 'add-statuscake-2-review' },
    ],
  },
  {
    open: 'Add GitLab',
    names: ['Scope & access', 'Projects', 'Events', 'Review', 'Verify'],
    intercept: [
      { url: '/connectors/gitlab/projects', json: GITLAB_DISCOVERY },
      {
        url: '/connectors/gitlab/prepare-delivery',
        json: {
          setupId: '00000000-0000-4000-8000-000000000099',
          webhookPath: '/webhooks/gitlab/00000000-0000-4000-8000-000000000099',
          smeeUrl: 'https://smee.io/example-development-channel',
        },
      },
    ],
    steps: [
      {
        file: 'add-gitlab-1-scope',
        fill: [
          ['GitLab URL', 'https://gitlab.example.com'],
          ['Top-level group full path', 'acme'],
          ['Read-only access token', 'glpat-example-read-only-token'],
        ],
        advance: 'Check access and discover projects',
      },
      { file: 'add-gitlab-2-projects', advance: 'Configure event sync' },
      { file: 'add-gitlab-3-events', advance: 'Review' },
      { file: 'add-gitlab-4-review' },
    ],
  },
  {
    open: 'Add GitHub App',
    names: ['App', 'Installation', 'Coverage', 'Review', 'Verify'],
    intercept: [
      { url: '/connectors/github/installations', json: GITHUB_INSTALLATIONS },
      { url: '/connectors/github/repositories', json: GITHUB_REPOSITORIES },
      {
        url: '/connectors/github/prepare-delivery',
        json: {
          setupId: '00000000-0000-4000-8000-000000000099',
          webhookPath: '/webhooks/github/00000000-0000-4000-8000-000000000099',
          smeeUrl: 'https://smee.io/example-development-channel',
        },
      },
    ],
    steps: [
      {
        file: 'add-github-1-app',
        // The dedicated-App path leaves for github.com to create the App. The existing-App path
        // is the same wizard without that redirect, so it is the one that can be walked.
        // Pinning the delivery mode as well, so the shot does not change shape depending on
        // whether the harness happens to look like a local or a deployed environment.
        choose: ['Existing dedicated App', 'Smee relay'],
        fill: [
          ['Smee channel URL', 'https://smee.io/example-development-channel'],
          ['GitHub App ID or client ID', '123456'],
          [
            'Private key (PEM)',
            '-----BEGIN RSA PRIVATE KEY-----\nexample\n-----END RSA PRIVATE KEY-----',
          ],
          ['Webhook secret', 'github-example-webhook-secret'],
        ],
        advance: 'Check existing App',
      },
      { file: 'add-github-2-installation', advance: 'Review repository coverage' },
      { file: 'add-github-3-coverage', advance: 'Review connection' },
      { file: 'add-github-4-review' },
    ],
  },
];
