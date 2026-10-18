import { expect, test } from 'vitest';
import { providerLinks } from '../provider-links';
import type { InvestigationEvidence } from '../types';

const sha = '3391576ad9e41f223355bf10d612178f196e1a4e';
const other = '8759f2b6090db5a77db473d092a14dac4b25f03b';

function record(tool: string, output: unknown, outcome = 'data'): InvestigationEvidence {
  return { id: crypto.randomUUID(), tool, input: {}, output, createdAt: new Date(), outcome };
}

test('collects GitLab and GitHub commit pages and the Argo CD application page', () => {
  const links = providerLinks(
    [
      record('gitlab_abc_list_commits', [
        {
          id: sha,
          short_id: '3391576a',
          web_url: `https://gitlab.example.com/g/app/-/commit/${sha}`,
        },
      ]),
      record('github_def_compare_commits', {
        commits: [{ sha: other, html_url: `https://github.com/o/app/commit/${other}` }],
      }),
      record('argocd_xyz_get_application', {
        metadata: { name: 'trading-bot', namespace: 'argocd' },
        webUrl: 'https://argocd.example.com/applications/argocd/trading-bot',
      }),
    ],
    `Rollout ${sha.slice(0, 7)} followed ${other}.`,
  );
  expect(links).toEqual([
    { label: '3391576a', url: `https://gitlab.example.com/g/app/-/commit/${sha}` },
    { label: '8759f2b6', url: `https://github.com/o/app/commit/${other}` },
    { label: 'trading-bot', url: 'https://argocd.example.com/applications/argocd/trading-bot' },
  ]);
});

test('ignores URLs a commit author or an unrelated tool could control', () => {
  const links = providerLinks(
    [
      // A link inside the commit message, and a web_url that does not end in the commit's own SHA.
      record('gitlab_abc_list_commits', [
        { id: sha, message: 'see https://evil.example/x', web_url: 'https://evil.example/x' },
        { id: other, web_url: `http://gitlab.example.com/g/app/-/commit/${other}` },
      ]),
      // Same shape from a tool that is not a git connector.
      record('kubernetes_k8s_get_resource', {
        id: sha,
        web_url: `https://gitlab.example.com/g/app/-/commit/${sha}`,
      }),
      // A failed read and an Argo app with a credentialed URL.
      record(
        'gitlab_abc_get_commit',
        { id: sha, web_url: `https://gitlab.example.com/g/app/-/commit/${sha}` },
        'error',
      ),
      record('argocd_xyz_get_application', {
        metadata: { name: 'api' },
        webUrl: 'https://user:pw@argocd.example.com/applications/argocd/api',
      }),
    ],
    `${sha} and ${other}`,
  );
  expect(links).toEqual([]);
});

const listed = Array.from({ length: 20 }, (_, index) => {
  const id = (index + 16).toString(16).padStart(2, '0').repeat(20);
  return { id, web_url: `https://gitlab.example.com/g/app/-/commit/${id}` };
});

test('keeps the first link per label and stops at eight named commits', () => {
  const links = providerLinks(
    [record('gitlab_abc_list_commits', [...listed, { ...listed[0], web_url: listed[1]!.web_url }])],
    listed.map((commit) => commit.id).join(' '),
  );
  expect(links).toHaveLength(8);
  expect(links[0]).toEqual({ label: listed[0]!.id.slice(0, 8), url: listed[0]!.web_url });
});

test('a long commit list keeps the named commit and the application link', () => {
  const named = listed[12]!;
  const links = providerLinks(
    [
      record('gitlab_abc_list_commits', listed),
      record('argocd_xyz_get_application', {
        metadata: { name: 'trading-bot' },
        webUrl: 'https://argocd.example.com/applications/argocd/trading-bot',
      }),
    ],
    `The rollout of ${named.id.slice(0, 7)} restarted trading-bot.`,
  );
  expect(links).toEqual([
    { label: named.id.slice(0, 8), url: named.web_url },
    { label: 'trading-bot', url: 'https://argocd.example.com/applications/argocd/trading-bot' },
  ]);
});

test('a commit the finding never names is not linked', () => {
  expect(
    providerLinks([record('gitlab_abc_list_commits', listed)], 'Memory pressure on the node.'),
  ).toEqual([]);
});
