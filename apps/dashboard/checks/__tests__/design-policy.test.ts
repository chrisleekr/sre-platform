import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { inspectDesignPolicy } from '../design-policy';

describe('design policy regression cases', () => {
  test.each([
    '<button className="rounded-full" />',
    '<select className="rounded-lg" />',
    '<input className="focus:outline-none" />',
    '<section className="bg-slate-900" />',
    '<section className="bg-[#101010]" />',
    '<section style={{ color: "#ffffff" }} />',
    '<path stroke="rgb(0 0 0)" />',
    '<section className="hover:shadow-lg" />',
    '<button className="sre-action px-4" />',
    '<button className="sre-action sm:px-8" />',
    '<button className="sre-action sm:disabled:opacity-100" />',
    '<button className="sre-action bg-critical" />',
    '<button className="sre-action hover:bg-critical" />',
    '<button className="sre-action-primary" />',
    'const style = "rounded-full"; const View = () => <button className={style} />;',
    '<button className={`rounded-md ${active ? "bg-blue-500" : "bg-surface"}`} />',
  ])('rejects conflicting styles: %s', (source) => {
    expect(inspectDesignPolicy(source).length).toBeGreaterThan(0);
  });

  test.each([
    '<button className="sre-action sre-action-primary mt-2 w-full" />',
    '<button className="sre-action sre-action-danger min-h-11" />',
    '<button className="sre-action aria-pressed:bg-line" />',
    '<button className="rounded-md text-ink-muted" />',
    '<input className="sre-field w-full" />',
    '<path stroke="var(--sre-info)" />',
    '<span className="rounded-full bg-critical-soft text-critical" />',
    '<section className="rounded-lg border border-line bg-surface shadow-none" />',
    '<a href="#main-content" className="sre-action bg-surface" />',
  ])('allows semantic controls and distinct data roles: %s', (source) => {
    expect(inspectDesignPolicy(source)).toEqual([]);
  });
});

test('all dashboard components obey the static design policy', () => {
  const root = resolve('apps/dashboard/src');
  const violations = readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((path) => path.endsWith('.tsx') && !path.includes('__tests__'))
    .flatMap((path) =>
      inspectDesignPolicy(readFileSync(resolve(root, path), 'utf8')).map(
        (violation) => `${path}:${violation.line} ${violation.rule}: ${violation.value}`,
      ),
    );
  expect(violations).toEqual([]);
});
