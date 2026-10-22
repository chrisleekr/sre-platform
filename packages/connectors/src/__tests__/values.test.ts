import { describe, expect, test } from 'vitest';
import { decodeBase64Content } from '../values';

const base64 = (value: string | Uint8Array) => Buffer.from(value).toString('base64');

describe('decodeBase64Content', () => {
  test('decodes UTF-8 text and keeps the other fields', () => {
    const text = 'apiVersion: v1\nkind: Secret\n';
    // GitHub wraps Base64 lines; whitespace must not break decoding.
    const content = `${base64(text).slice(0, 8)}\n${base64(text).slice(8)}`;
    expect(decodeBase64Content({ sha: 'abc', encoding: 'base64', content })).toEqual({
      sha: 'abc',
      encoding: 'utf-8',
      content: text,
    });
  });

  test('keeps binary and non-UTF-8 content as Base64', () => {
    const binary = {
      encoding: 'base64',
      content: base64(new Uint8Array([0x89, 0x50, 0x00, 0x47])),
    };
    const latin1 = { encoding: 'base64', content: base64(new Uint8Array([0xff, 0xfe, 0x41])) };
    expect(decodeBase64Content(binary)).toBe(binary);
    expect(decodeBase64Content(latin1)).toBe(latin1);
  });

  test('passes through directory listings and non-Base64 bodies', () => {
    const listing = [{ type: 'file', name: 'a.ts' }];
    const plain = { encoding: 'none', content: '' };
    expect(decodeBase64Content(listing)).toBe(listing);
    expect(decodeBase64Content(plain)).toBe(plain);
  });
});
