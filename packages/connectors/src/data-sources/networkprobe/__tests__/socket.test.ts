import { describe, expect, test } from 'vitest';
import { headRequestTarget, headSliceIfComplete, parseHttpHead } from '../socket';

// ---------------- parseHttpHead ----------------

describe('parseHttpHead', () => {
  test('parses status and headers, stops at the blank line (no body)', () => {
    const r = parseHttpHead(
      'HTTP/1.1 301 Moved Permanently\r\nLocation: https://x.example/\r\nServer: nginx\r\n\r\n<html>body',
    );
    expect(r.status).toBe(301);
    expect(r.headers.location).toBe('https://x.example/');
    expect(r.headers.server).toBe('nginx');
    expect(JSON.stringify(r)).not.toContain('body');
  });

  test('accumulates repeated headers rather than clobbering', () => {
    const r = parseHttpHead('HTTP/1.1 200 OK\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\n\r\n');
    expect(r.headers['set-cookie']).toBe('a=1, b=2');
  });

  test('returns status 0 when the status line has no code', () => {
    expect(parseHttpHead('garbage\r\n\r\n').status).toBe(0);
  });
});

// ---------------- headSliceIfComplete (the 64 KB cap guard) ----------------

describe('headSliceIfComplete', () => {
  test('returns the slice up to the blank-line boundary', () => {
    expect(headSliceIfComplete('HTTP/1.1 200 OK\r\nA: b\r\n\r\nBODY')).toBe(
      'HTTP/1.1 200 OK\r\nA: b',
    );
  });

  test('returns null while the head is still incomplete', () => {
    expect(headSliceIfComplete('HTTP/1.1 200 OK\r\nA: b\r\n')).toBeNull();
  });

  test('caps at 64 KB when a hostile host never sends the blank line', () => {
    const flood = 'X'.repeat(70 * 1024); // no CRLFCRLF ever
    const head = headSliceIfComplete(flood);
    expect(head).not.toBeNull();
    expect(head!.length).toBe(64 * 1024);
  });
});

// ---------------- headRequestTarget (target withheld from an unverified peer) ----------------

describe('headRequestTarget', () => {
  test('sends the full path and query to a verified peer', () => {
    expect(headRequestTarget('/health?token=s', true)).toEqual({
      target: '/health?token=s',
      targetWithheld: false,
    });
  });

  test('sends only / to an unverified peer, since path and query can both carry a credential', () => {
    expect(headRequestTarget('/health?token=s', false)).toEqual({
      target: '/',
      targetWithheld: true,
    });
    expect(headRequestTarget('/services/T0/B0/secret', false)).toEqual({
      target: '/',
      targetWithheld: true,
    });
  });

  test('reports nothing withheld when the target is already /', () => {
    expect(headRequestTarget('/', false)).toEqual({ target: '/', targetWithheld: false });
  });
});
