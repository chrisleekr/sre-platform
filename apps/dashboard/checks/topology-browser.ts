import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';

/** Drive the real discovery hook against the isolated authenticated API. */
export async function verifyTopologyBrowser({
  root,
  token,
  readTopology,
  degradeProvider,
  recordProbeEvidence,
}: {
  root: string;
  token: string;
  readTopology: (
    path: string,
    authorization: string,
    method: string,
    body?: string,
  ) => Promise<Response>;
  degradeProvider: () => Promise<void>;
  recordProbeEvidence: (incidentId: string) => Promise<void>;
}) {
  let vite: Awaited<ReturnType<typeof createServer>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    let failRefresh = false;
    vite = await createServer({
      root: resolve(root, 'apps/dashboard'),
      configFile: resolve(root, 'apps/dashboard/vite.config.ts'),
      envDir: false,
      server: { host: '127.0.0.1', port: 0, strictPort: false },
      plugins: [
        {
          name: 'topology-verification',
          configureServer(server) {
            server.middlewares.use('/__api', (request, response, next) => {
              void (async () => {
                const chunks: Buffer[] = [];
                for await (const chunk of request) chunks.push(Buffer.from(chunk));
                const body = chunks.length ? Buffer.concat(chunks).toString() : undefined;
                const result = failRefresh
                  ? new Response('Unavailable', { status: 503 })
                  : await readTopology(
                      request.url ?? '/',
                      request.headers.authorization ?? '',
                      request.method ?? 'GET',
                      body,
                    );
                response.statusCode = result.status;
                response.setHeader(
                  'Content-Type',
                  result.headers.get('content-type') ?? 'text/plain',
                );
                response.end(await result.text());
              })().catch(next);
            });
            server.middlewares.use('/__topology', (_request, response, next) => {
              void (async () => {
                const html = await server.transformIndexHtml(
                  '/__topology',
                  `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script type="module" src="/@fs/${root}/apps/dashboard/checks/__tests__/topology.fixture.tsx"></script></body></html>`,
                );
                response.setHeader('Content-Type', 'text/html');
                response.end(html);
              })().catch(next);
            });
          },
        },
      ],
    });
    await vite.listen();
    const address = vite.httpServer!.address();
    assert.ok(address && typeof address !== 'string');
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.addInitScript(
      (value) => sessionStorage.setItem('topology-test-token', value),
      token,
    );
    const errors: string[] = [];
    const artifacts = resolve(root, '.vitest/topology-browser');
    await mkdir(artifacts, { recursive: true });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${address.port}/__topology`);
    const map = page.getByRole('region', { name: 'Discovered topology map' });
    await map.getByRole('heading', { name: 'Service dependencies', exact: true }).waitFor();
    await map.getByRole('button', { name: /^Inspect catalog-api · service/ }).click();
    const sourceDetail = page.getByRole('region', { name: 'Selected topology subject' });
    await sourceDetail.getByRole('heading', { name: 'catalog-api', exact: true }).waitFor();
    await map
      .getByRole('button', { name: /catalog-api → depends on → catalog-database/ })
      .waitFor();
    await sourceDetail
      .locator('details')
      .filter({ hasText: 'Service descriptor, not deployed source' })
      .getByText('Declared · Inspect evidence', { exact: true })
      .click();
    await sourceDetail
      .getByText('Service descriptor, not deployed source', { exact: true })
      .waitFor();
    await map.getByRole('button', { name: 'All groups', exact: true }).click();
    await map.getByText(/^Without dependency relationships/).click();
    await map.getByRole('button', { name: /^report-exporter/ }).click();
    const taggedDetail = page.getByRole('region', { name: 'Selected topology subject' });
    await taggedDetail.getByRole('heading', { name: 'report-exporter', exact: true }).waitFor();
    await taggedDetail.getByText('Declared · Inspect evidence', { exact: true }).waitFor();
    await taggedDetail
      .getByRole('region', { name: 'Observed runtime' })
      .getByText('Resource healthy', { exact: true })
      .waitFor();
    await map.getByRole('button', { name: 'All groups', exact: true }).click();
    await map.getByRole('button', { name: /^Inspect checkout · service/ }).click();
    await page
      .getByRole('region', { name: 'Selected topology subject' })
      .getByRole('heading', { name: 'checkout', exact: true })
      .waitFor();
    await map.getByRole('group', { name: 'Topology relationships' }).waitFor();
    for (const width of [360, 768, 1145]) {
      await page.setViewportSize({ width, height: 963 });
      await map.getByRole('button', { name: 'Fit all' }).click();
      assert.ok(
        await map.getByRole('group', { name: 'Topology relationships' }).evaluate((svg) => {
          const canvas = svg.getBoundingClientRect();
          return [...svg.querySelectorAll('[data-map-node]')].every((item) => {
            const node = item.getBoundingClientRect();
            return (
              node.left >= canvas.left - 1 &&
              node.right <= canvas.right + 1 &&
              node.top >= canvas.top - 1 &&
              node.bottom <= canvas.bottom + 1
            );
          });
        }),
        'Fit all must keep every displayed resource inside the canvas',
      );
      await map.getByRole('button', { name: 'Readable view' }).click();
      assert.ok(
        await map.getByRole('group', { name: 'Topology relationships' }).evaluate((svg) => {
          const selected = svg.querySelector('[data-map-node][aria-pressed="true"]');
          const node = selected?.getBoundingClientRect(),
            canvas = svg.getBoundingClientRect();
          return (
            node &&
            node.left >= canvas.left - 1 &&
            node.right <= canvas.right + 1 &&
            node.top >= canvas.top - 1 &&
            node.bottom <= canvas.bottom + 1
          );
        }),
        'The focused resource must stay inside the canvas when the inspector opens',
      );
      assert.ok(
        await map.getByRole('group', { name: 'Topology relationships' }).evaluate((svg) => {
          const names = [
            ...svg.querySelectorAll<SVGTextElement>('[data-map-node] text[font-weight]'),
          ];
          return (
            names.length > 0 &&
            names.every(
              (name) =>
                Number(name.getAttribute('font-size')) * Math.abs(name.getScreenCTM()?.a ?? 0) >=
                11.9,
            )
          );
        }),
        'Map names must remain readable instead of shrinking to fit the full graph',
      );
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        'Map and inspector must not overflow the document',
      );
      await map.screenshot({ path: resolve(artifacts, `map-focused-${width}.png`) });
    }
    await map.getByRole('button', { name: 'All groups', exact: true }).click();
    await map.getByRole('button', { name: /^Inspect settlement · service/ }).click();
    const catalogDetail = page.getByRole('region', { name: 'Selected topology subject' });
    await catalogDetail.getByRole('heading', { name: 'settlement', exact: true }).waitFor();
    await catalogDetail.getByText('Declared · Inspect evidence', { exact: true }).waitFor();
    await map.getByRole('button', { name: /settlement → depends on → bank-gateway/ }).waitFor();
    await map.getByRole('button', { name: 'Resource context', exact: true }).click();
    await map.getByRole('heading', { name: 'Topology overview' }).waitFor();
    await map
      .getByRole('button', {
        name: /Open group production.*cluster: kubernetes-cluster:cluster-one · namespace: production$/,
      })
      .click();
    await map.getByRole('button', { name: /Inspect checkout-api/ }).waitFor();
    await map.getByRole('button', { name: 'Fit all' }).click();
    await map.screenshot({ path: resolve(artifacts, 'map-expanded.png') });
    await page.getByRole('button', { name: 'List', exact: true }).click();
    const subjects = page.getByRole('list', { name: 'Discovered subjects' });
    const detail = page.getByRole('region', { name: 'Selected topology subject' });
    await subjects.getByRole('button', { name: /^batch-reporter service/ }).click();
    await detail.getByRole('heading', { name: 'batch-reporter', exact: true }).waitFor();
    await detail.getByText('Declared · Inspect evidence', { exact: true }).waitFor();
    await detail
      .getByRole('region', { name: 'Observed runtime' })
      .getByText('Resource healthy', { exact: true })
      .waitFor();
    await detail.getByRole('button', { name: 'Back to results', exact: true }).click();
    await subjects
      .getByRole('button', { name: /checkout service · environment: production/ })
      .click();
    await detail.getByRole('heading', { name: 'checkout', exact: true }).waitFor();
    const runtime = detail.getByRole('region', { name: 'Observed runtime' });
    await runtime.getByText('Needs attention', { exact: true }).waitFor();
    await runtime.getByRole('button', { name: 'Investigate', exact: true }).click();
    const declaration = page.waitForResponse((response) =>
      response.url().endsWith('/incidents/from-observation'),
    );
    await page.getByRole('button', { name: 'Start investigation', exact: true }).click();
    const opened = await declaration;
    assert.equal(opened.status(), 201, await opened.text());
    const incidentId = (await opened.json()).incidentId;
    assert.ok(incidentId);
    await recordProbeEvidence(incidentId);
    await page.waitForURL(/\/w\/incidents\//);
    await page.goto(`http://127.0.0.1:${address.port}/__topology?incident=${incidentId}`);
    await page.getByRole('button', { name: 'List', exact: true }).click();
    const incidentScope = page.getByRole('region', { name: 'Incident scope' });
    await incidentScope.getByText('Matched identity', { exact: true }).waitFor();
    assert.equal(
      await incidentScope
        .getByRole('list', { name: 'Incident topology matches' })
        .getByRole('listitem')
        .count(),
      1,
    );
    await incidentScope.getByText('service · environment: production', { exact: true }).waitFor();
    await incidentScope.getByRole('button', { name: 'Inspect checkout', exact: true }).click();
    await detail.getByRole('heading', { name: 'checkout', exact: true }).waitFor();
    await runtime.getByRole('button', { name: 'Open investigation', exact: true }).waitFor();
    await detail
      .getByRole('region', { name: 'Dependency impact' })
      .getByRole('button', { name: 'payments', exact: true })
      .click();
    await detail.getByRole('heading', { name: 'payments', exact: true }).waitFor();
    await detail.getByText('Dependency behavior unknown (1)', { exact: true }).waitFor();
    await page.screenshot({ path: resolve(artifacts, 'scoped-impact.png'), fullPage: true });
    await detail
      .getByRole('region', { name: 'Dependency impact' })
      .getByRole('button', { name: 'checkout', exact: true })
      .click();
    await detail.getByRole('heading', { name: 'checkout', exact: true }).waitFor();
    await detail.getByRole('button', { name: 'checkout-api', exact: true }).click();
    await detail.getByText('Relationships · 4', { exact: true }).waitFor();
    assert.equal(
      await detail
        .getByRole('heading', { name: 'checkout-api', exact: true })
        .evaluate((element) => document.activeElement === element),
      true,
    );
    const applicationSource = detail
      .getByRole('list', { name: 'Subject relationships' })
      .getByRole('listitem')
      .filter({ hasText: 'Pod source declaration' });
    await applicationSource.getByText('Declared · Inspect evidence', { exact: true }).click();
    await applicationSource.getByText('Application source declaration', { exact: true }).waitFor();
    await applicationSource.getByText('a'.repeat(40), { exact: true }).waitFor();
    for (const [width, height] of [
      [1440, 960],
      [768, 900],
      [360, 800],
    ]) {
      await page.setViewportSize({ width: width!, height: height! });
      for (const theme of ['light', 'dark']) {
        await page.evaluate((value) => (document.documentElement.dataset.theme = value), theme);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
          `Overflow at ${width}px ${theme}`,
        );
        await page.screenshot({
          path: resolve(artifacts, `${width}-${theme}.png`),
          fullPage: true,
        });
      }
    }
    await detail.getByRole('button', { name: 'Back to results' }).click();
    await subjects
      .getByRole('button', { name: /^checkout.example.test\/metrics endpoint/ })
      .click();
    const endpoint = detail.getByRole('region', { name: 'Endpoint probe evidence' });
    await endpoint.getByText('HTTP status', { exact: true }).waitFor();
    await endpoint.getByText('503', { exact: true }).waitFor();
    await endpoint.getByText('93.184.216.34', { exact: true }).waitFor();
    const refreshedEvidence = page.waitForResponse((response) =>
      response.url().includes('/topology/endpoint-evidence?'),
    );
    await endpoint.getByRole('button', { name: 'Refresh evidence' }).click();
    assert.equal((await refreshedEvidence).status(), 200);
    await endpoint.getByRole('button', { name: 'Refresh evidence' }).waitFor();
    await page.screenshot({ path: resolve(artifacts, 'endpoint-evidence.png'), fullPage: true });
    await detail.getByRole('button', { name: 'Back to results' }).click();
    await page
      .getByLabel('Scope', { exact: true })
      .selectOption(JSON.stringify(['environment', 'development']));
    assert.equal(await subjects.getByRole('button').count(), 1);
    await subjects.getByRole('button').click();
    await detail
      .getByText('No resolved relationships have been collected for this subject yet.')
      .waitFor();
    await detail.getByRole('button', { name: 'Back to results' }).click();
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await degradeProvider();
    await page.getByRole('button', { name: 'Refresh view' }).click();
    await page.getByText(/Discovery coverage/).click();
    await page.getByText('Connection capabilities and pending sources', { exact: true }).click();
    const capabilities = page.getByRole('list', { name: 'Discovery source capabilities' });
    assert.equal(await capabilities.getByText('Not implemented', { exact: true }).count(), 2);
    await capabilities.getByText('On-demand probe evidence', { exact: true }).waitFor();
    await page.getByText('Access denied. Check the connection permissions.').waitFor();
    assert.ok(
      await subjects.getByRole('button', { name: /monitor/ }).count(),
      'Failed reads must retain monitor evidence',
    );
    failRefresh = true;
    await page.getByRole('button', { name: 'Refresh view' }).click();
    await page
      .getByRole('alert')
      .filter({ hasText: 'last successful discovery snapshot' })
      .waitFor();
    assert.ok(await subjects.getByRole('button').count());
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await vite?.close();
  }
}
