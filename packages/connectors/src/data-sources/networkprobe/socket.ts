import net from 'node:net';
import tls from 'node:tls';
import type { HttpHeadResult, PeerCertLike, ProbeSocketDeps, RawTlsResult } from './types';

// Default socket layer for the network probe: thin node:net/tls wiring plus the pure HTTP-head
// helpers it needs. Callers pass an already validated, pinned IP; this module never resolves names.

const MAX_HEAD_BYTES = 64 * 1024; // hostile host cannot stream unbounded response headers

/** A one-shot settle guard: the first call wins, later socket events are ignored. */
function settleOnce(): (fn: () => void) => void {
  let settled = false;
  return (fn) => {
    if (settled) return;
    settled = true;
    fn();
  };
}

/**
 * The response head is complete once the blank-line boundary arrives, or is capped at MAX_HEAD_BYTES so a
 * hostile host cannot stream unbounded headers. Returns the header slice, or null if more data is needed.
 */
export function headSliceIfComplete(buf: string): string | null {
  const boundary = buf.indexOf('\r\n\r\n');
  if (boundary !== -1) return buf.slice(0, boundary);
  if (buf.length >= MAX_HEAD_BYTES) return buf.slice(0, MAX_HEAD_BYTES);
  return null;
}

/** Parse the response head (status line + headers) up to the blank line. Body is never included. */
export function parseHttpHead(text: string): { status: number; headers: Record<string, string> } {
  const head = text.split('\r\n\r\n')[0] ?? text;
  const lines = head.split('\r\n');
  const statusLine = lines.shift() ?? '';
  const status = Number.parseInt(statusLine.split(/\s+/)[1] ?? '', 10);
  const headers: Record<string, string> = {};
  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    // Repeated headers (e.g. set-cookie) accumulate rather than clobber.
    headers[key] = key in headers ? `${headers[key]}, ${value}` : value;
  }
  return { status: Number.isFinite(status) ? status : 0, headers };
}

/**
 * Choose the request target for a HEAD over TLS.
 *
 * @remarks Incident URLs can carry credentials in the query (presigned URLs, `?token=`) or in the
 * path (webhook URLs, `/bot<token>/`), so a peer whose certificate did not verify gets only `/`.
 * @param path - Path plus query string from the probed URL.
 * @param tlsAuthorized - Whether the peer certificate verified.
 */
export function headRequestTarget(
  path: string,
  tlsAuthorized: boolean,
): { target: string; targetWithheld: boolean } {
  if (tlsAuthorized || path === '/') return { target: path, targetWithheld: false };
  return { target: '/', targetWithheld: true };
}

export const defaultTcpConnect: ProbeSocketDeps['tcpConnect'] = (ip, port, timeoutMs) =>
  new Promise<number>((resolve, reject) => {
    const start = performance.now();
    const settle = settleOnce();
    const socket = net.connect({ host: ip, port });
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => {
      const latencyMs = Math.round(performance.now() - start);
      socket.destroy();
      settle(() => resolve(latencyMs));
    });
    socket.on('timeout', () => {
      socket.destroy();
      settle(() => reject(new Error('networkprobe: tcp connect timed out')));
    });
    socket.on('error', (e) => {
      socket.destroy();
      settle(() => reject(e));
    });
  });

export const defaultTlsConnect: ProbeSocketDeps['tlsConnect'] = (ip, servername, port, timeoutMs) =>
  new Promise<RawTlsResult>((resolve, reject) => {
    const settle = settleOnce();
    // rejectUnauthorized:false is the point: complete the handshake on an expired/self-signed/wrong-host
    // cert and REPORT the verdict as data, rather than failing the tool on exactly the certs we diagnose.
    const socket = tls.connect({ host: ip, port, servername, rejectUnauthorized: false });
    socket.setTimeout(timeoutMs);
    socket.on('secureConnect', () => {
      const cert = socket.getPeerCertificate(true) as unknown as PeerCertLike;
      const err = (socket as unknown as { authorizationError?: Error | string }).authorizationError;
      const result: RawTlsResult = {
        authorized: socket.authorized,
        authorizationError: err ? String(err) : null,
        protocol: socket.getProtocol(),
        cipher: socket.getCipher()?.name ?? null,
        cert,
      };
      socket.destroy();
      settle(() => resolve(result));
    });
    socket.on('timeout', () => {
      socket.destroy();
      settle(() => reject(new Error('networkprobe: tls handshake timed out')));
    });
    socket.on('error', (e) => {
      socket.destroy();
      settle(() => reject(e));
    });
  });

export const defaultHttpHead: ProbeSocketDeps['httpHead'] = (
  ip,
  hostHeader,
  servername,
  port,
  scheme,
  path,
  timeoutMs,
) =>
  new Promise<HttpHeadResult>((resolve, reject) => {
    const settle = settleOnce();
    // rejectUnauthorized:false for the same reason as the TLS probe above: a HEAD reachability
    // check must still report the status of a host whose certificate is expired or self-signed.
    // The verdict is returned beside the status, because a peer that fails verification may be an
    // interceptor, not the host, and its status and headers are then unproven.
    const socket =
      scheme === 'https'
        ? tls.connect({ host: ip, port, servername, rejectUnauthorized: false })
        : net.connect({ host: ip, port });
    socket.setTimeout(timeoutMs);
    let tlsAuthorized: boolean | null = null;
    let tlsAuthorizationError: string | null = null;
    let targetWithheld = false;
    const finish = (head: string): HttpHeadResult => ({
      ...parseHttpHead(head),
      tlsAuthorized,
      tlsAuthorizationError,
      targetWithheld,
    });
    const onReady = () => {
      let target = path;
      if (socket instanceof tls.TLSSocket) {
        tlsAuthorized = socket.authorized;
        const err = (socket as unknown as { authorizationError?: Error | string })
          .authorizationError;
        tlsAuthorizationError = err ? String(err) : null;
        ({ target, targetWithheld } = headRequestTarget(path, tlsAuthorized));
      }
      const req =
        `HEAD ${target} HTTP/1.1\r\nHost: ${hostHeader}\r\n` +
        `User-Agent: sre-platform-networkprobe\r\nAccept: */*\r\nConnection: close\r\n\r\n`;
      socket.write(req);
    };
    socket.on(scheme === 'https' ? 'secureConnect' : 'connect', onReady);
    let buf = '';
    socket.on('data', (chunk: Buffer) => {
      buf += chunk.toString('latin1');
      const head = headSliceIfComplete(buf);
      if (head !== null) {
        socket.destroy();
        settle(() => resolve(finish(head)));
      }
    });
    socket.on('timeout', () => {
      socket.destroy();
      settle(() => reject(new Error('networkprobe: http head timed out')));
    });
    socket.on('error', (e) => {
      socket.destroy();
      settle(() => reject(e));
    });
    socket.on('close', () => {
      // A zero-byte close is a connection failure, not a response; surface it as an error rather than a
      // bogus status 0. A partial head (server closed after a short 1xx/4xx) is still a real reply.
      if (buf.length === 0) {
        settle(() => reject(new Error('networkprobe: connection closed with no response')));
        return;
      }
      settle(() => resolve(finish(buf)));
    });
  });
