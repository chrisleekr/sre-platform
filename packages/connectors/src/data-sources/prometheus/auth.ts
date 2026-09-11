import * as z from 'zod';

/**
 * Bun's fetch accepts a `tls` option the DOM/Node `RequestInit` does not declare (mirrors k8s's
 * K8sFetchInit). `ca`/`rejectUnauthorized` carry server trust (from settings); `cert`/`key` carry a
 * client identity (from the mtls auth strategy). A value of this type is still assignable to RequestInit.
 */
export interface PromFetchInit extends RequestInit {
  tls?: { ca?: string; cert?: string; key?: string; rejectUnauthorized?: boolean };
}

/**
 * Prometheus auth credential — one opaque connector string that is this JSON. A Zod
 * discriminated union on `type` is the extension seam: a new method is one union member plus one
 * strategy plus one factory entry, and nothing at the call sites changes. `none` is a bare
 * unauthenticated backend (common in-cluster); `bearer`/`basic`/`header` ride a request header;
 * `mtls` attaches a client cert/key to the Bun `tls` option. `sigv4` (Amazon Managed Prometheus) is
 * the documented next member — additive-only, no refactor.
 */
export const PromCreds = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('bearer'), token: z.string().min(1) }),
  z.object({ type: z.literal('basic'), username: z.string().min(1), password: z.string().min(1) }),
  z.object({ type: z.literal('header'), name: z.string().min(1), value: z.string().min(1) }),
  z.object({ type: z.literal('mtls'), cert: z.string().min(1), key: z.string().min(1) }),
]);
export type PromCreds = z.infer<typeof PromCreds>;

/**
 * Strategy: attach a credential to an outbound request. Async and init-returning so header-based,
 * transport (mTLS `tls`), and future request-signing (SigV4) methods all fit the one seam without a
 * breaking interface change.
 */
export interface PromAuth {
  apply(init: PromFetchInit): Promise<PromFetchInit>;
}

/** Merge one header without disturbing others. Headers are always constructed as a record here. */
function withHeader(init: PromFetchInit, name: string, value: string): PromFetchInit {
  const headers = (init.headers ?? {}) as Record<string, string>;
  return { ...init, headers: { ...headers, [name]: value } };
}

class NoneAuth implements PromAuth {
  async apply(init: PromFetchInit): Promise<PromFetchInit> {
    return init;
  }
}

class BearerAuth implements PromAuth {
  constructor(private readonly token: string) {}
  async apply(init: PromFetchInit): Promise<PromFetchInit> {
    return withHeader(init, 'Authorization', `Bearer ${this.token}`);
  }
}

class BasicAuth implements PromAuth {
  constructor(
    private readonly username: string,
    private readonly password: string,
  ) {}
  async apply(init: PromFetchInit): Promise<PromFetchInit> {
    const encoded = Buffer.from(`${this.username}:${this.password}`).toString('base64');
    return withHeader(init, 'Authorization', `Basic ${encoded}`);
  }
}

class HeaderAuth implements PromAuth {
  constructor(
    private readonly name: string,
    private readonly value: string,
  ) {}
  async apply(init: PromFetchInit): Promise<PromFetchInit> {
    return withHeader(init, this.name, this.value);
  }
}

class MtlsAuth implements PromAuth {
  constructor(
    private readonly cert: string,
    private readonly key: string,
  ) {}
  async apply(init: PromFetchInit): Promise<PromFetchInit> {
    // Merge the client cert/key into the tls option; server trust (ca) set by the connector is kept.
    return { ...init, tls: { ...init.tls, cert: this.cert, key: this.key } };
  }
}

/**
 * Discriminant → strategy constructor. Keyed by the union's `type`, so the union and this map cannot
 * drift: adding a member without an entry here is a compile error.
 */
type AuthFactory = { [K in PromCreds['type']]: (c: Extract<PromCreds, { type: K }>) => PromAuth };
const FACTORY: AuthFactory = {
  none: () => new NoneAuth(),
  bearer: (c) => new BearerAuth(c.token),
  basic: (c) => new BasicAuth(c.username, c.password),
  header: (c) => new HeaderAuth(c.name, c.value),
  mtls: (c) => new MtlsAuth(c.cert, c.key),
};

/**
 * Resolve the stored credential string to an auth strategy. An empty/absent credential is `none`
 * (unauthenticated). Any other value must be the credential JSON; a malformed one throws rather than
 * silently falling back to unauthenticated (which would send a triage read in the clear).
 */
export function resolveAuth(credential: string): PromAuth {
  const raw = credential.trim();
  if (!raw) return new NoneAuth();
  let creds: PromCreds;
  try {
    creds = PromCreds.parse(JSON.parse(raw));
  } catch {
    throw new Error(
      'prometheus connector: credential must be JSON with a "type" of none|bearer|basic|header|mtls',
    );
  }
  return (FACTORY[creds.type] as (c: PromCreds) => PromAuth)(creds);
}
