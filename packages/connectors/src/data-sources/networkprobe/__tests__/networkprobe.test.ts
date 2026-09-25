import { describe, expect, test, vi } from 'vitest';
import type { ConnectorConfig } from '../../../registry';
import type { HostLookup } from '../../../ssrf';
import type { ConnectorTool } from '../../../types';
import {
  headSliceIfComplete,
  makeNetworkProbeConnector,
  mapCert,
  parseHttpHead,
  resolvePublicTarget,
  type ProbeSocketDeps,
} from '../connector';

const PUBLIC_IP = '93.184.216.34';
const PUBLIC_V6 = '2606:2800:220:1:248:1893:25c8:1946';

function cfg(): ConnectorConfig {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    name: 'Network probe',
    tenantId: 't1',
    type: 'networkprobe',
    settings: {},
    getCredential: async () => '',
  };
}

/** Deps recorder: default everything to a public answer; override per test. */
function fakeDeps(over: Partial<ProbeSocketDeps> = {}): {
  deps: Partial<ProbeSocketDeps>;
  tcp: Array<{ ip: string; port: number }>;
  tls: Array<{ ip: string; servername: string; port: number }>;
  http: Array<{
    ip: string;
    hostHeader: string;
    servername: string;
    port: number;
    scheme: string;
    path: string;
  }>;
} {
  const tcp: Array<{ ip: string; port: number }> = [];
  const tls: Array<{ ip: string; servername: string; port: number }> = [];
  const http: Array<{
    ip: string;
    hostHeader: string;
    servername: string;
    port: number;
    scheme: string;
    path: string;
  }> = [];
  const lookup: HostLookup = over.lookup ?? (async () => [PUBLIC_IP]);
  const deps: Partial<ProbeSocketDeps> = {
    lookup,
    resolveCname: over.resolveCname ?? (async () => []),
    tcpConnect:
      over.tcpConnect ??
      (async (ip, port) => {
        tcp.push({ ip, port });
        return 12;
      }),
    tlsConnect:
      over.tlsConnect ??
      (async (ip, servername, port) => {
        tls.push({ ip, servername, port });
        return {
          authorized: true,
          authorizationError: null,
          protocol: 'TLSv1.3',
          cipher: 'TLS_AES_256_GCM_SHA384',
          cert: {
            subject: { CN: 'example.com' },
            issuer: { O: 'CA', CN: 'CA 3' },
            valid_from: 'May 31 00:00:00 2026 GMT',
            valid_to: 'Aug 29 00:00:00 2026 GMT',
            subjectaltname: 'DNS:example.com, DNS:*.example.com',
            serialNumber: 'AABB',
            fingerprint256: 'BE:AB:14',
          },
        };
      }),
    httpHead:
      over.httpHead ??
      (async (ip, hostHeader, servername, port, scheme, path) => {
        http.push({ ip, hostHeader, servername, port, scheme, path });
        return { status: 200, headers: { server: 'nginx' } };
      }),
  };
  return { deps, tcp, tls, http };
}

function toolNamed(deps: Partial<ProbeSocketDeps>, name: string): ConnectorTool {
  const t = makeNetworkProbeConnector(cfg(), deps)
    .tools()
    .find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

// ---------------- resolvePublicTarget (the rebind guard) ----------------

describe('resolvePublicTarget', () => {
  const pub: HostLookup = async () => [PUBLIC_IP];

  test('accepts a public hostname and returns the resolved ips', async () => {
    const r = await resolvePublicTarget('example.com', pub);
    expect(r).toEqual({ host: 'example.com', ips: [PUBLIC_IP] });
  });

  test('accepts a public IP literal without DNS', async () => {
    let called = false;
    const r = await resolvePublicTarget(PUBLIC_IP, async () => {
      called = true;
      return [];
    });
    expect(r.ips).toEqual([PUBLIC_IP]);
    expect(called).toBe(false);
  });

  test('rejects a private IP literal', async () => {
    await expect(resolvePublicTarget('10.0.0.5', pub)).rejects.toThrow(/non-public/);
  });

  test('rejects the cloud-metadata literal', async () => {
    await expect(resolvePublicTarget('169.254.169.254', pub)).rejects.toThrow(/non-public/);
  });

  test('rejects localhost pre-DNS', async () => {
    await expect(resolvePublicTarget('localhost', pub)).rejects.toThrow(/not allowed/);
  });

  test('rejects a host that resolves to ANY private ip (split-DNS rebind)', async () => {
    const split: HostLookup = async () => [PUBLIC_IP, '10.1.2.3'];
    await expect(resolvePublicTarget('rebind.example', split)).rejects.toThrow(/non-public/);
  });

  test('rejects a host that does not resolve', async () => {
    await expect(resolvePublicTarget('nx.example', async () => [])).rejects.toThrow(
      /does not resolve/,
    );
  });

  test('rejects empty and whitespace hosts', async () => {
    await expect(resolvePublicTarget('  ', pub)).rejects.toThrow(/invalid host/);
    await expect(resolvePublicTarget('a b', pub)).rejects.toThrow(/invalid host/);
  });

  test('accepts a public IPv6 literal', async () => {
    const r = await resolvePublicTarget(PUBLIC_V6, pub);
    expect(r.ips).toEqual([PUBLIC_V6]);
  });

  test('rejects non-canonical IPv6 loopback spellings (canonicalize before classify)', async () => {
    // isBlockedIp matches '::1' textually; the expanded/zero-padded forms must be canonicalized first,
    // else they slip the guard and dial ::1 directly.
    await expect(resolvePublicTarget('0:0:0:0:0:0:0:1', pub)).rejects.toThrow(/non-public/);
    await expect(resolvePublicTarget('::01', pub)).rejects.toThrow(/non-public/);
    await expect(resolvePublicTarget('[0:0:0:0:0:0:0:1]', pub)).rejects.toThrow(/non-public/);
  });

  test('rejects a malformed IP literal rather than dialing it', async () => {
    await expect(resolvePublicTarget('999.999.999.999', pub)).rejects.toThrow(/invalid host/);
    await expect(resolvePublicTarget('foo:bar', pub)).rejects.toThrow(/invalid host/);
  });
});

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

// ---------------- mapCert ----------------

describe('mapCert', () => {
  const raw = {
    authorized: false,
    authorizationError: 'CERT_HAS_EXPIRED',
    protocol: 'TLSv1.2',
    cipher: 'ECDHE-RSA-AES128-GCM-SHA256',
    cert: {
      subject: { CN: 'expired.example' },
      issuer: { CN: 'CA' },
      valid_from: 'Jan 01 00:00:00 2026 GMT',
      valid_to: 'Jan 10 00:00:00 2026 GMT',
      subjectaltname: 'DNS:expired.example',
      serialNumber: 'FF',
      fingerprint256: 'AA:BB',
    },
  };

  test('carries the trust verdict and leaf fields', () => {
    const now = Date.parse('Jan 05 00:00:00 2026 GMT');
    const m = mapCert(raw, now);
    expect(m.authorized).toBe(false);
    expect(m.authorizationError).toBe('CERT_HAS_EXPIRED');
    expect(m.subjectAltName).toBe('DNS:expired.example');
    expect(m.fingerprint256).toBe('AA:BB');
    expect(m.protocol).toBe('TLSv1.2');
  });

  test('computes daysToExpiry and expired from valid_to', () => {
    const before = Date.parse('Jan 05 00:00:00 2026 GMT');
    expect(mapCert(raw, before).daysToExpiry).toBe(5);
    expect(mapCert(raw, before).expired).toBe(false);
    const after = Date.parse('Jan 20 00:00:00 2026 GMT');
    expect(mapCert(raw, after).expired).toBe(true);
    expect(mapCert(raw, after).daysToExpiry).toBe(-10);
  });

  test('nulls expiry when valid_to is unparseable', () => {
    const bad = { ...raw, cert: { ...raw.cert, valid_to: 'nonsense' } };
    const m = mapCert(bad, Date.now());
    expect(m.daysToExpiry).toBeNull();
    expect(m.expired).toBeNull();
  });
});

// ---------------- resolve_dns tool ----------------

describe('resolve_dns', () => {
  test('classifies public and private addresses, reports (never blocks) private', async () => {
    const { deps } = fakeDeps({
      lookup: async () => [PUBLIC_IP, '10.0.0.9'],
      resolveCname: async () => ['cdn.example.net'],
    });
    const t = toolNamed(deps, 'resolve_dns');
    const r = (await t.run({ host: 'mixed.example' })) as {
      addresses: Array<{ ip: string; family: string; public: boolean }>;
      cname: string[];
    };
    expect(r.addresses).toEqual([
      { ip: PUBLIC_IP, family: 'IPv4', public: true },
      { ip: '10.0.0.9', family: 'IPv4', public: false },
    ]);
    expect(r.cname).toEqual(['cdn.example.net']);
  });

  test('handles an IP literal without DNS', async () => {
    const { deps } = fakeDeps();
    const t = toolNamed(deps, 'resolve_dns');
    const r = (await t.run({ host: '169.254.169.254' })) as {
      addresses: Array<{ public: boolean }>;
    };
    expect(r.addresses[0]!.public).toBe(false);
  });

  test('canonicalizes a non-canonical IPv6 loopback and flags it non-public', async () => {
    const { deps } = fakeDeps();
    const r = (await toolNamed(deps, 'resolve_dns').run({ host: '0:0:0:0:0:0:0:1' })) as {
      host: string;
      addresses: Array<{ ip: string; public: boolean }>;
    };
    expect(r.host).toBe('::1');
    expect(r.addresses[0]).toMatchObject({ ip: '::1', public: false });
  });

  test('rejects an empty host', async () => {
    const { deps } = fakeDeps();
    await expect(toolNamed(deps, 'resolve_dns').run({ host: '  ' })).rejects.toThrow(
      /invalid host/,
    );
  });
});

// ---------------- check_reachable tool ----------------

describe('check_reachable', () => {
  test('connects to the validated pinned ip and reports latency', async () => {
    const { deps, tcp } = fakeDeps();
    const t = toolNamed(deps, 'check_reachable');
    const r = (await t.run({ host: 'example.com', port: 8443 })) as {
      reachable: boolean;
      targetIp: string;
      port: number;
      latencyMs: number;
    };
    expect(r).toMatchObject({ reachable: true, targetIp: PUBLIC_IP, port: 8443, latencyMs: 12 });
    expect(tcp).toEqual([{ ip: PUBLIC_IP, port: 8443 }]);
  });

  test('defaults the port to 443', async () => {
    const { deps, tcp } = fakeDeps();
    await toolNamed(deps, 'check_reachable').run({ host: 'example.com' });
    expect(tcp[0]!.port).toBe(443);
  });

  test('reports unreachable with the error rather than throwing', async () => {
    const { deps } = fakeDeps({
      tcpConnect: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    const r = (await toolNamed(deps, 'check_reachable').run({ host: 'example.com' })) as {
      reachable: boolean;
      error: string;
    };
    expect(r.reachable).toBe(false);
    expect(r.error).toMatch(/ECONNREFUSED/);
  });

  test('never connects to a private target', async () => {
    const { deps, tcp } = fakeDeps({ lookup: async () => ['10.0.0.1'] });
    await expect(toolNamed(deps, 'check_reachable').run({ host: 'evil.example' })).rejects.toThrow(
      /non-public/,
    );
    expect(tcp).toHaveLength(0);
  });

  test('never dials a non-canonical IPv6 loopback literal', async () => {
    const { deps, tcp } = fakeDeps();
    await expect(
      toolNamed(deps, 'check_reachable').run({ host: '0:0:0:0:0:0:0:1' }),
    ).rejects.toThrow(/non-public/);
    expect(tcp).toHaveLength(0);
  });
});

// ---------------- inspect_tls tool ----------------

describe('inspect_tls', () => {
  test('pins to the validated ip with SNI = hostname and shapes the cert', async () => {
    const { deps, tls } = fakeDeps();
    const r = (await toolNamed(deps, 'inspect_tls').run({ host: 'example.com' })) as {
      authorized: boolean;
      targetIp: string;
      subjectAltName: string;
    };
    expect(tls).toEqual([{ ip: PUBLIC_IP, servername: 'example.com', port: 443 }]);
    expect(r.authorized).toBe(true);
    expect(r.targetIp).toBe(PUBLIC_IP);
    expect(r.subjectAltName).toContain('example.com');
  });

  test('surfaces a broken-cert verdict as data', async () => {
    const { deps } = fakeDeps({
      tlsConnect: async () => ({
        authorized: false,
        authorizationError: 'DEPTH_ZERO_SELF_SIGNED_CERT',
        protocol: 'TLSv1.2',
        cipher: 'x',
        cert: { subject: { CN: 'self' }, valid_to: 'Jan 01 00:00:00 2030 GMT' },
      }),
    });
    const r = (await toolNamed(deps, 'inspect_tls').run({ host: 'self.example' })) as {
      authorized: boolean;
      authorizationError: string;
    };
    expect(r.authorized).toBe(false);
    expect(r.authorizationError).toBe('DEPTH_ZERO_SELF_SIGNED_CERT');
  });

  test('never handshakes with a private target', async () => {
    const { deps, tls } = fakeDeps({ lookup: async () => ['127.0.0.1'] });
    await expect(toolNamed(deps, 'inspect_tls').run({ host: 'evil.example' })).rejects.toThrow(
      /non-public/,
    );
    expect(tls).toHaveLength(0);
  });
});

// ---------------- http_meta tool ----------------

describe('http_meta', () => {
  test('HEADs the pinned ip, passes Host + SNI, returns status + headers', async () => {
    const { deps, http } = fakeDeps();
    const r = (await toolNamed(deps, 'http_meta').run({
      url: 'https://example.com/health?x=1',
    })) as { status: number; headers: Record<string, string>; targetIp: string };
    expect(http).toEqual([
      {
        ip: PUBLIC_IP,
        hostHeader: 'example.com',
        servername: 'example.com',
        port: 443,
        scheme: 'https',
        path: '/health?x=1',
      },
    ]);
    expect(r.status).toBe(200);
    expect(r.headers.server).toBe('nginx');
    expect(r.targetIp).toBe(PUBLIC_IP);
  });

  test('does not follow redirects — returns 3xx + Location', async () => {
    const { deps } = fakeDeps({
      httpHead: async () => ({ status: 302, headers: { location: 'https://elsewhere.example/' } }),
    });
    const r = (await toolNamed(deps, 'http_meta').run({ url: 'http://example.com' })) as {
      status: number;
      headers: Record<string, string>;
    };
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe('https://elsewhere.example/');
  });

  test('supports http scheme and a non-default port', async () => {
    const { deps, http } = fakeDeps();
    await toolNamed(deps, 'http_meta').run({ url: 'http://example.com:8080/' });
    expect(http[0]).toMatchObject({ scheme: 'http', port: 8080, hostHeader: 'example.com:8080' });
  });

  test('rejects a non-http(s) scheme', async () => {
    const { deps } = fakeDeps();
    await expect(toolNamed(deps, 'http_meta').run({ url: 'file:///etc/passwd' })).rejects.toThrow(
      /http or https/,
    );
  });

  test('rejects an unparseable url', async () => {
    const { deps } = fakeDeps();
    await expect(toolNamed(deps, 'http_meta').run({ url: 'not a url' })).rejects.toThrow(
      /invalid url/,
    );
  });

  test('never connects to a url whose host resolves private', async () => {
    const { deps, http } = fakeDeps({ lookup: async () => ['192.168.1.1'] });
    await expect(
      toolNamed(deps, 'http_meta').run({ url: 'https://evil.example/' }),
    ).rejects.toThrow(/non-public/);
    expect(http).toHaveLength(0);
  });
});

// ---------------- connector interface ----------------

describe('makeNetworkProbeConnector', () => {
  test('exposes exactly the four probe tools', () => {
    const names = makeNetworkProbeConnector(cfg())
      .tools()
      .map((t) => t.name)
      .sort();
    expect(names).toEqual(['check_reachable', 'http_meta', 'inspect_tls', 'resolve_dns']);
  });

  test('type', () => {
    const c = makeNetworkProbeConnector(cfg());
    expect(c.type).toBe('networkprobe');
  });

  test('probe is not_applicable (leaves enablement untouched)', async () => {
    const r = await makeNetworkProbeConnector(cfg()).probe();
    expect(r.status).toBe('not_applicable');
    expect(r.reachable).toBe(false);
  });

  test('snapshot throws a permanent-N/A message (not a poller placeholder)', async () => {
    await expect(makeNetworkProbeConnector(cfg()).snapshot()).rejects.toThrow(/on-demand/);
  });

  test('fetchTriageContext returns an on-demand note and never throws', async () => {
    const r = await makeNetworkProbeConnector(cfg()).fetchTriageContext({
      service: 'checkout',
      windowMinutes: 30,
    });
    expect(r.source).toBe('networkprobe');
    expect((r.data as { note: string }).note).toMatch(/on-demand/);
  });
});

describe('tool cancellation', () => {
  test('refuses to start a probe once the investigation is cancelled', async () => {
    const { deps, tcp } = fakeDeps();
    const reason = new Error('investigation cancelled');
    const caller = new AbortController();
    caller.abort(reason);

    await expect(
      toolNamed(deps, 'check_reachable').run({ host: 'example.com' }, { signal: caller.signal }),
    ).rejects.toBe(reason);
    expect(tcp).toHaveLength(0);
  });

  test('releases the caller when the investigation is cancelled mid-probe', async () => {
    let started = false;
    const { deps } = fakeDeps({
      tcpConnect: () => {
        started = true;
        return new Promise<number>(() => undefined);
      },
    });
    const reason = new Error('investigation cancelled');
    const caller = new AbortController();

    const call = toolNamed(deps, 'check_reachable').run(
      { host: 'example.com' },
      { signal: caller.signal },
    );
    await vi.waitFor(() => expect(started).toBe(true));
    caller.abort(reason);

    await expect(call).rejects.toBe(reason);
  });
});
