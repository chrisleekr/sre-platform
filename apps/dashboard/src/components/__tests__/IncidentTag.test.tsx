// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';

const incidentTagModule = ['..', 'IncidentTag'].join('/');

const loadIncidentTag = () => import(/* @vite-ignore */ incidentTagModule);

describe('IncidentTag links', () => {
  test('renders an HTTPS rule and encodes the substituted tag value', async () => {
    const { IncidentTag } = await loadIncidentTag();
    render(
      <IncidentTag
        tag="bug:ABC/123?from=slack"
        linkRules={[{ prefix: 'bug', urlTemplate: 'https://tracker.example/issues/{value}' }]}
      />,
    );

    expect(screen.getByRole('link', { name: 'bug:ABC/123?from=slack' })).toHaveAttribute(
      'href',
      'https://tracker.example/issues/ABC%2F123%3Ffrom%3Dslack',
    );
  });

  test.each([
    ['unmatched', 'runbook:checkout', []],
    [
      'insecure HTTP',
      'bug:123',
      [{ prefix: 'bug', urlTemplate: 'http://tracker.example/issues/{value}' }],
    ],
    [
      'missing substitution',
      'bug:123',
      [{ prefix: 'bug', urlTemplate: 'https://tracker.example/issues/static' }],
    ],
  ])('renders %s rules as plain text', async (_name, tag, linkRules) => {
    const { IncidentTag } = await loadIncidentTag();
    render(<IncidentTag tag={tag} linkRules={linkRules} />);
    expect(screen.getByText(tag)).toBeDefined();
    expect(screen.queryByRole('link')).toBeNull();
  });
});
