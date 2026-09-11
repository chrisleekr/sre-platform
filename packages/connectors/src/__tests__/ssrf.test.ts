import { describe, expect, it } from 'vitest';
import { assertSafeHttpOrHttpsUrl, assertSafeHttpsUrl, dnsLookup, isBlockedIp } from '../ssrf';

describe('isBlockedIp', () => {
  it('returns true for private/loopback/link-local/CGNAT/ULA/unspecified IPs', () => {
    for (const ip of [
      '127.0.0.1',
      '169.254.169.254',
      '10.0.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '0.0.0.0',
      '100.64.0.1',
      '192.0.0.1',
      '192.0.2.1',
      '198.18.0.1',
      '224.0.0.1',
      '240.0.0.1',
      '::1',
      'fe80::1',
      'fc00::1',
      '::ffff:169.254.169.254',
      '::ffff:a9fe:a9fe', // hex form of 169.254.169.254 (metadata)
      '::ffff:0a00:0001', // hex form of 10.0.0.1 (RFC1918)
      '::',
      '::0',
      '::7f00:1', // IPv4-compatible ::/96 embedding 127.0.0.1
      '2002:a9fe:a9fe::', // 6to4 embedding 169.254.169.254
      '64:ff9b::a9fe:a9fe', // NAT64 embedding 169.254.169.254
      'fec0::1', // deprecated site-local
      'ff02::1', // multicast
    ]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it('returns false for public IPs and near-miss ranges', () => {
    for (const ip of [
      '8.8.8.8',
      '93.184.216.34',
      '2606:2800:220:1:248:1893:25c8:1946',
      '172.15.0.1',
      '172.32.0.1',
      '100.63.255.255', // just below CGNAT 100.64.0.0/10
      '100.128.0.1', // just above CGNAT 100.64.0.0/10
      '192.0.1.1', // public address immediately outside 192.0.0.0/24
    ]) {
      expect(isBlockedIp(ip), ip).toBe(false);
    }
  });
});

describe('dnsLookup', () => {
  it('resolves a real host to an array of addresses', async () => {
    const ips = await dnsLookup('localhost');
    expect(Array.isArray(ips)).toBe(true);
    expect(ips.some((ip) => ip === '127.0.0.1' || ip === '::1')).toBe(true);
  });
});

describe('assertSafeHttpsUrl', () => {
  it('rejects a public name that resolves into private space (DNS rebinding)', async () => {
    await expect(
      assertSafeHttpsUrl('https://evil.example.com', async () => ['169.254.169.254']),
    ).rejects.toThrow(/not allowed|blocked/i);
  });

  it('resolves a public host to a URL', async () => {
    const url = await assertSafeHttpsUrl('https://gitlab.example.com', async () => [
      '93.184.216.34',
    ]);
    expect(url.hostname).toBe('gitlab.example.com');
  });

  it('rejects a literal blocked IP before resolving DNS', async () => {
    await expect(
      assertSafeHttpsUrl('https://169.254.169.254', async () => ['8.8.8.8']),
    ).rejects.toThrow();
  });

  it('rejects a non-https scheme', async () => {
    await expect(
      assertSafeHttpsUrl('http://gitlab.example.com', async () => ['93.184.216.34']),
    ).rejects.toThrow(/https/i);
  });

  it('rejects the localhost name', async () => {
    await expect(
      assertSafeHttpsUrl('https://localhost', async () => ['93.184.216.34']),
    ).rejects.toThrow();
  });

  it('rejects when DNS resolution is empty', async () => {
    await expect(assertSafeHttpsUrl('https://nx.example.com', async () => [])).rejects.toThrow();
  });

  it('rejects an unparseable URL', async () => {
    await expect(assertSafeHttpsUrl('not a url', async () => [])).rejects.toThrow();
  });
});

describe('assertSafeHttpOrHttpsUrl', () => {
  it('accepts HTTP and HTTPS while rejecting other protocols', async () => {
    const lookup = async () => ['93.184.216.34'];
    await expect(
      assertSafeHttpOrHttpsUrl('http://metrics.example.com', lookup),
    ).resolves.toHaveProperty('protocol', 'http:');
    await expect(
      assertSafeHttpOrHttpsUrl('https://metrics.example.com', lookup),
    ).resolves.toHaveProperty('protocol', 'https:');
    await expect(assertSafeHttpOrHttpsUrl('ftp://metrics.example.com', lookup)).rejects.toThrow(
      /http or https/,
    );
  });

  it('allows a literal loopback only with the explicit development option', async () => {
    await expect(assertSafeHttpOrHttpsUrl('http://127.0.0.1:9090')).rejects.toThrow(/not allowed/);
    await expect(
      assertSafeHttpOrHttpsUrl('http://127.0.0.1:9090', undefined, {
        allowedLoopbackOrigins: ['http://127.0.0.1:9090'],
      }),
    ).resolves.toHaveProperty('hostname', '127.0.0.1');
    await expect(
      assertSafeHttpOrHttpsUrl('http://localhost:9090', undefined, {
        allowedLoopbackOrigins: ['http://127.0.0.1:9090'],
      }),
    ).rejects.toThrow(/not allowed/);
  });

  it('still rejects metadata when loopback is allowed', async () => {
    await expect(
      assertSafeHttpOrHttpsUrl('http://169.254.169.254', undefined, {
        allowedLoopbackOrigins: ['http://127.0.0.1:9090'],
      }),
    ).rejects.toThrow(/not allowed/);
  });

  it('combines private-network access with one exact supervised loopback origin', async () => {
    const options = {
      allowPrivate: true,
      allowedLoopbackOrigins: ['http://127.0.0.1:9090'],
    };
    await expect(
      assertSafeHttpOrHttpsUrl('http://metrics.internal', async () => ['10.0.0.8'], options),
    ).resolves.toHaveProperty('hostname', 'metrics.internal');
    await expect(
      assertSafeHttpOrHttpsUrl('http://127.0.0.1:9090', undefined, options),
    ).resolves.toHaveProperty('port', '9090');
    await expect(
      assertSafeHttpOrHttpsUrl('http://127.0.0.1:3000', undefined, options),
    ).rejects.toThrow(/not allowed/);

    for (const target of [
      'http://169.254.169.254',
      'http://[fe80::1]',
      'http://[::ffff:a9fe:a9fe]',
      'http://[2002:a9fe:a9fe::]',
      'http://[64:ff9b::a9fe:a9fe]',
    ]) {
      await expect(assertSafeHttpOrHttpsUrl(target, undefined, options), target).rejects.toThrow(
        /not allowed/,
      );
    }
    await expect(
      assertSafeHttpOrHttpsUrl('http://rebind.example', async () => ['127.0.0.1'], options),
    ).rejects.toThrow(/not allowed/);
  });
});
