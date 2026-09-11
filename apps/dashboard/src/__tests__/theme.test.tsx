// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Script } from 'node:vm';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ThemeControl } from '../components/ThemeControl';
import { THEME_STORAGE_KEY, ThemeProvider } from '../theme';

let dark = false;
const mediaListeners = new Set<(event: MediaQueryListEvent) => void>();
const storage = new Map<string, string>();
const indexHtml = readFileSync(resolve(process.cwd(), 'apps/dashboard/index.html'), 'utf8');

function loadBootstrapSource(): string {
  const source = indexHtml.match(/<script>\s*([\s\S]*?)\s*<\/script>/)?.[1];
  if (!source) throw new Error('Theme bootstrap script is missing from index.html.');
  return source;
}

const bootstrapSource = loadBootstrapSource();

function runThemeBootstrap() {
  new Script(bootstrapSource).runInNewContext({ document, window });
}

function emitSystemTheme(matches: boolean) {
  dark = matches;
  act(() => {
    for (const listener of mediaListeners) listener({ matches } as MediaQueryListEvent);
  });
}

beforeEach(() => {
  dark = false;
  mediaListeners.clear();
  storage.clear();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      get length() {
        return storage.size;
      },
      clear: () => storage.clear(),
      getItem: (key: string) => storage.get(key) ?? null,
      key: (index: number) => [...storage.keys()][index] ?? null,
      removeItem: (key: string) => storage.delete(key),
      setItem: (key: string, value: string) => storage.set(key, value),
    } satisfies Storage,
  });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({
      matches: dark,
      media: '(prefers-color-scheme: dark)',
      onchange: null,
      addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) =>
        mediaListeners.add(listener),
      removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) =>
        mediaListeners.delete(listener),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  document.head.innerHTML = '<meta id="theme-color" name="theme-color" content="#f3f6f8" />';
});

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-theme-preference');
  document.documentElement.removeAttribute('style');
});

describe('ThemeProvider', () => {
  test('uses the system preference by default and follows operating-system changes', () => {
    render(
      <ThemeProvider>
        <ThemeControl />
      </ThemeProvider>,
    );

    expect((screen.getByRole('combobox', { name: 'Appearance' }) as HTMLSelectElement).value).toBe(
      'system',
    );
    expect(screen.queryByRole('button', { name: 'System' })).toBeNull();
    expect(document.documentElement.dataset.theme).toBe('light');

    emitSystemTheme(true);

    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  test('persists an explicit choice and exposes it through the appearance control', () => {
    render(
      <ThemeProvider>
        <ThemeControl />
      </ThemeProvider>,
    );

    fireEvent.change(screen.getByRole('combobox', { name: 'Appearance' }), {
      target: { value: 'dark' },
    });

    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');
    expect(document.querySelector<HTMLMetaElement>('#theme-color')?.content).toBe('#091116');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect((screen.getByRole('combobox', { name: 'Appearance' }) as HTMLSelectElement).value).toBe(
      'dark',
    );

    fireEvent.change(screen.getByRole('combobox', { name: 'Appearance' }), {
      target: { value: 'system' },
    });
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.documentElement.dataset.themePreference).toBe('system');
    expect(document.documentElement.style.colorScheme).toBe('light');
    expect(document.querySelector<HTMLMetaElement>('#theme-color')?.content).toBe('#f3f6f8');
  });

  test('restores a stored choice without waiting for an effect', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    render(
      <ThemeProvider>
        <ThemeControl />
      </ThemeProvider>,
    );

    expect((screen.getByRole('combobox', { name: 'Appearance' }) as HTMLSelectElement).value).toBe(
      'dark',
    );
    expect(document.documentElement.dataset.themePreference).toBe('dark');
  });

  test('still applies a tab-local choice when browser storage is unavailable', () => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: () => {
          throw new Error('storage unavailable');
        },
        setItem: () => {
          throw new Error('storage unavailable');
        },
        removeItem: () => {
          throw new Error('storage unavailable');
        },
      } as unknown as Storage,
    });

    render(
      <ThemeProvider>
        <ThemeControl />
      </ThemeProvider>,
    );

    fireEvent.change(screen.getByRole('combobox', { name: 'Appearance' }), {
      target: { value: 'dark' },
    });

    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.dataset.themePreference).toBe('dark');
    expect((screen.getByRole('combobox', { name: 'Appearance' }) as HTMLSelectElement).value).toBe(
      'dark',
    );
  });
});

describe('pre-render theme bootstrap', () => {
  test('applies a stored dark preference before React mounts', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');

    runThemeBootstrap();

    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.dataset.themePreference).toBe('dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');
    expect(document.querySelector<HTMLMetaElement>('#theme-color')?.content).toBe('#091116');
  });

  test.each([
    [null, true, 'dark'],
    ['invalid', true, 'dark'],
    [null, false, 'light'],
  ])('resolves %s against system dark=%s as %s', (stored, systemDark, expected) => {
    dark = systemDark;
    if (stored) window.localStorage.setItem(THEME_STORAGE_KEY, stored);

    runThemeBootstrap();

    expect(document.documentElement.dataset.theme).toBe(expected);
    expect(document.documentElement.dataset.themePreference).toBe('system');
    expect(document.documentElement.style.colorScheme).toBe(expected);
    expect(document.querySelector<HTMLMetaElement>('#theme-color')?.content).toBe(
      expected === 'dark' ? '#091116' : '#f3f6f8',
    );
  });

  test('falls back to light when storage is unavailable', () => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get: () => {
        throw new Error('storage unavailable');
      },
    });

    runThemeBootstrap();

    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.documentElement.dataset.themePreference).toBe('system');
    expect(document.documentElement.style.colorScheme).toBe('light');
    expect(document.querySelector<HTMLMetaElement>('#theme-color')?.content).toBe('#f3f6f8');
  });
});
