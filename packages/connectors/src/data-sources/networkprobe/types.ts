import type { HostLookup } from '../../ssrf';

export interface PeerCertLike {
  subject?: { CN?: string } & Record<string, unknown>;
  issuer?: Record<string, unknown>;
  valid_from?: string;
  valid_to?: string;
  subjectaltname?: string;
  serialNumber?: string;
  fingerprint256?: string;
}

export interface RawTlsResult {
  authorized: boolean;
  authorizationError: string | null;
  protocol: string | null;
  cipher: string | null;
  cert: PeerCertLike;
}

/** HEAD outcome. The tls* fields are null for plain http, where there is no peer to verify. */
export interface HttpHeadResult {
  status: number;
  headers: Record<string, string>;
  tlsAuthorized: boolean | null;
  tlsAuthorizationError: string | null;
  /** True when the query string was dropped because the TLS peer failed verification. */
  queryWithheld: boolean;
}

/** Injectable socket boundary for hermetic resolver, TCP, TLS, and HTTP tests. */
export interface ProbeSocketDeps {
  lookup: HostLookup;
  resolveCname: (host: string) => Promise<string[]>;
  tcpConnect: (ip: string, port: number, timeoutMs: number) => Promise<number>;
  tlsConnect: (
    ip: string,
    servername: string,
    port: number,
    timeoutMs: number,
  ) => Promise<RawTlsResult>;
  httpHead: (
    ip: string,
    hostHeader: string,
    servername: string,
    port: number,
    scheme: 'http' | 'https',
    path: string,
    timeoutMs: number,
  ) => Promise<HttpHeadResult>;
}
