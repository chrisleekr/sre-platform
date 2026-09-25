import { boundedSignal } from '../../request-signal';
import { obj, str } from '../../values';

type FetchLike = typeof fetch;

const STATUSCAKE_API = 'https://api.statuscake.com';
const API_TIMEOUT_MS = 8000;
const PAGE_LIMIT = 100;
// 20 pages of 100 bounds one sync to 2,000 tests and 40 list reads.
const MAX_PAGES = 20;
// StatusCake allows a burst of 5 requests per second on every plan.
const WRITE_SPACING_MS = 250;
const GROUP_NAME_PREFIX = 'SRE Platform: ';
const GROUP_NAME_MAX = 80;
const ID_RE = /^[A-Za-z0-9_-]+$/;

/** Maximum uptime tests one connection may select or exclude. */
export const STATUSCAKE_MAX_LISTED_TESTS = 500;

/** How the connection chooses which uptime tests deliver notifications. */
export type StatusCakeSetupMode = 'auto' | 'custom';

/** Parsed notification binding. `null` from {@link statusCakeDelivery} means delivery is off. */
export interface StatusCakeDelivery {
  mode: StatusCakeSetupMode;
  selected: string[];
  excluded: string[];
  receiverOrigin?: string;
}

function ids(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((id): id is string => typeof id === 'string' && ID_RE.test(id))
    : [];
}

/**
 * Reads the uptime notification binding from stored connection settings.
 * @param settings - Stored StatusCake connection settings.
 */
export function statusCakeDelivery(settings: unknown): StatusCakeDelivery | null {
  const s = obj(settings);
  if (s.eventTransport !== 'direct') return null;
  const receiverOrigin = str(s.receiverOrigin);
  return {
    // Rows saved before setup modes existed listed their tests explicitly.
    mode: s.setupMode === 'auto' ? 'auto' : 'custom',
    selected: ids(s.uptimeMonitorIds),
    excluded: ids(s.excludedMonitorIds),
    ...(receiverOrigin ? { receiverOrigin } : {}),
  };
}

/**
 * Whether an uptime test may deliver notifications through this connection.
 * @param settings - Stored StatusCake connection settings.
 * @param monitorId - StatusCake uptime test ID from the webhook path.
 */
export function statusCakeMonitorBound(settings: unknown, monitorId: string): boolean {
  const delivery = statusCakeDelivery(settings);
  if (!delivery || !ID_RE.test(monitorId)) return false;
  return delivery.mode === 'auto'
    ? !delivery.excluded.includes(monitorId)
    : delivery.selected.includes(monitorId);
}

/** Setup failure with a stable category for the operator. */
export class StatusCakeSetupError extends Error {
  constructor(
    readonly category:
      'rate_limited' | 'permission_denied' | 'provider_rejected' | 'unreachable' | 'not_found',
    message: string,
  ) {
    super(message);
  }
}

/** Authenticated StatusCake v1 client limited to the calls setup needs. */
export interface StatusCakeSetupApi {
  get(path: string, query?: Record<string, string | number>): Promise<unknown>;
  send(
    method: 'POST' | 'PUT' | 'DELETE',
    path: string,
    form?: Array<[string, string]>,
  ): Promise<unknown>;
}

function failure(status: number, body: unknown): StatusCakeSetupError {
  if (status === 429)
    return new StatusCakeSetupError(
      'rate_limited',
      'StatusCake rate limit reached. Setup resumes on the next sync.',
    );
  if (status === 401 || status === 403)
    return new StatusCakeSetupError(
      'permission_denied',
      'StatusCake rejected the API token for this change.',
    );
  if (status === 404) return new StatusCakeSetupError('not_found', 'StatusCake has no such item.');
  const message = str(obj(body).message)?.slice(0, 200);
  return new StatusCakeSetupError(
    'provider_rejected',
    `StatusCake refused the change (${status})${message ? `: ${message}` : ''}.`,
  );
}

/**
 * Builds a setup client pinned to the StatusCake API origin.
 * @param token - Modern StatusCake bearer API token.
 * @param fetchImpl - HTTP transport.
 */
export function statusCakeSetupApi(
  token: string,
  fetchImpl: FetchLike = fetch,
): StatusCakeSetupApi {
  const call = async (method: string, path: string, body?: URLSearchParams) => {
    if (!/^\/v1\/[A-Za-z0-9_/-]+$/.test(path))
      throw new Error('statuscake setup: invalid API path');
    let res: Response;
    try {
      res = await fetchImpl(
        `${STATUSCAKE_API}${path}${method === 'GET' && body ? `?${body}` : ''}`,
        {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            ...(method !== 'GET' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
          },
          ...(method !== 'GET' && body ? { body: body.toString() } : {}),
          signal: boundedSignal(API_TIMEOUT_MS),
          redirect: 'error',
        },
      );
    } catch {
      throw new StatusCakeSetupError('unreachable', 'StatusCake did not respond.');
    }
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!res.ok) throw failure(res.status, parsed);
    return parsed;
  };
  return {
    get: (path, query) =>
      call(
        'GET',
        path,
        query
          ? new URLSearchParams(
              Object.entries(query).map(([k, v]): [string, string] => [k, String(v)]),
            )
          : undefined,
      ),
    send: (method, path, form) => call(method, path, new URLSearchParams(form ?? [])),
  };
}

/** One uptime test as setup sees it. */
export interface StatusCakeUptimeTest {
  id: string;
  name: string;
  url?: string;
  status?: string;
  paused: boolean;
  contactGroups: string[];
}

interface ContactGroup {
  id: string;
  name?: string;
  pingUrl?: string;
}

async function listAll(api: StatusCakeSetupApi, path: string): Promise<unknown[]> {
  const items: unknown[] = [];
  for (let page = 1; ; page++) {
    const body = obj(await api.get(path, { page, limit: PAGE_LIMIT }));
    const data = Array.isArray(body.data) ? body.data : [];
    items.push(...data);
    const pageCount = Number(obj(body.metadata).page_count);
    if (data.length < PAGE_LIMIT || !Number.isFinite(pageCount) || page >= pageCount) return items;
    // A partial list would read as deleted tests and missing groups, so refuse to act on one.
    if (page >= MAX_PAGES)
      throw new StatusCakeSetupError(
        'provider_rejected',
        'This StatusCake account has more than 2,000 uptime tests or contact groups, which setup cannot read in full, so nothing was changed.',
      );
  }
}

function providerId(value: unknown): string | undefined {
  const id = typeof value === 'number' ? String(value) : str(value);
  return id && ID_RE.test(id) ? id : undefined;
}

function toTest(raw: unknown): StatusCakeUptimeTest | undefined {
  const t = obj(raw);
  const id = providerId(t.id);
  if (!id) return undefined;
  const url = str(t.website_url);
  const status = str(t.status);
  return {
    id,
    name: str(t.name) ?? id,
    ...(url ? { url } : {}),
    ...(status ? { status } : {}),
    paused: t.paused === true,
    contactGroups: Array.isArray(t.contact_groups)
      ? t.contact_groups.map(providerId).filter((g): g is string => Boolean(g))
      : [],
  };
}

/**
 * Lists every uptime test on the account, bounded to 2,000.
 * @param api - StatusCake setup client.
 */
export async function listStatusCakeUptimeTests(
  api: StatusCakeSetupApi,
): Promise<StatusCakeUptimeTest[]> {
  return (await listAll(api, '/v1/uptime'))
    .map(toTest)
    .filter((t): t is StatusCakeUptimeTest => Boolean(t));
}

/**
 * Builds the per-test receiver address a platform contact group calls.
 *
 * @remarks The test identity rides the path because StatusCake's notification carries no test ID.
 * The platform-generated secret rides `Token` because contact-group ping URLs are GET-only and
 * cannot carry headers.
 * @param origin - Public HTTPS API origin.
 * @param webhookKey - Connection webhook routing key.
 * @param testId - StatusCake uptime test ID.
 * @param secret - Platform-generated webhook secret.
 */
export function statusCakeReceiverUrl(
  origin: string,
  webhookKey: string,
  testId: string,
  secret: string,
): string {
  const url = new URL(
    `/webhooks/statuscake/${encodeURIComponent(webhookKey)}/${encodeURIComponent(testId)}`,
    origin,
  );
  url.searchParams.set('Token', secret);
  return url.toString();
}

/**
 * The test ID a contact group delivers for, when the platform created it for this connection. The
 * name prefix separates it from a group an operator made by hand for the same address.
 */
function ownedTestId(group: ContactGroup, webhookKey: string): string | undefined {
  if (!group.pingUrl || !group.name?.startsWith(GROUP_NAME_PREFIX)) return undefined;
  try {
    const parts = new URL(group.pingUrl).pathname.split('/');
    // ['', 'webhooks', 'statuscake', key, testId]
    return parts.length === 5 &&
      parts[1] === 'webhooks' &&
      parts[2] === 'statuscake' &&
      parts[3] === webhookKey &&
      ID_RE.test(parts[4]!)
      ? parts[4]
      : undefined;
  } catch {
    return undefined;
  }
}

/** Per-test setup outcome. */
export type StatusCakeTestSetupState =
  'ready' | 'created' | 'attached' | 'repaired' | 'removed' | 'missing' | 'not_bound';

/** Result of one setup pass. */
export interface StatusCakeSetupResult {
  tests: Array<StatusCakeUptimeTest & { bound: boolean; state: StatusCakeTestSetupState }>;
  changes: number;
  error?: { category: StatusCakeSetupError['category']; message: string };
}

function groupName(test: StatusCakeUptimeTest): string {
  return `${GROUP_NAME_PREFIX}${test.name}`.slice(0, GROUP_NAME_MAX);
}

/**
 * Brings StatusCake contact groups in line with the connection's binding.
 *
 * @remarks Delivery turned off is a binding with no tests, so a pass removes every group this
 * connection created. Only groups whose ping URL targets this connection's webhook key are created,
 * changed, or deleted. A test's other contact groups are always preserved: StatusCake replaces the
 * whole `contact_groups` list on update, so each change re-reads the test and writes back its current
 * groups plus or minus ours. With `apply` false nothing is written and the result reports what is
 * missing.
 * @param api - StatusCake setup client.
 * @param input - Binding, webhook routing key, receiver origin, secret, and whether to write.
 */
export async function syncStatusCakeContactGroups(
  api: StatusCakeSetupApi,
  input: {
    delivery: StatusCakeDelivery;
    webhookKey: string;
    /** Required only while a test is bound; removal needs neither. */
    origin?: string;
    secret?: string;
    apply: boolean;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<StatusCakeSetupResult> {
  const sleep = input.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let tests: StatusCakeUptimeTest[];
  let rawGroups: unknown[];
  try {
    tests = await listStatusCakeUptimeTests(api);
    rawGroups = await listAll(api, '/v1/contact-groups');
  } catch (error) {
    if (!(error instanceof StatusCakeSetupError)) throw error;
    return { tests: [], changes: 0, error: { category: error.category, message: error.message } };
  }
  const groups = rawGroups
    .map((raw): ContactGroup | undefined => {
      const g = obj(raw);
      const id = providerId(g.id);
      const name = str(g.name);
      const pingUrl = str(g.ping_url);
      return id ? { id, ...(name ? { name } : {}), ...(pingUrl ? { pingUrl } : {}) } : undefined;
    })
    .filter((g): g is ContactGroup => Boolean(g));
  const owned = new Map<string, ContactGroup>();
  const duplicates: ContactGroup[] = [];
  for (const group of groups) {
    const testId = ownedTestId(group, input.webhookKey);
    if (!testId) continue;
    if (owned.has(testId)) duplicates.push(group);
    else owned.set(testId, group);
  }
  const { delivery } = input;
  const isBound = (id: string) =>
    delivery.mode === 'auto' ? !delivery.excluded.includes(id) : delivery.selected.includes(id);
  const result: StatusCakeSetupResult = { tests: [], changes: 0 };
  const write = async (...args: Parameters<StatusCakeSetupApi['send']>) => {
    await api.send(...args);
    result.changes++;
    await sleep(WRITE_SPACING_MS);
  };
  const setGroups = async (testId: string, change: (current: string[]) => string[]) => {
    // Re-read so a contact group added in StatusCake since the list read is not dropped.
    const fresh = obj(obj(await api.get(`/v1/uptime/${testId}`)).data);
    const listed = Array.isArray(fresh.contact_groups) ? fresh.contact_groups : null;
    const current = (listed ?? []).map(providerId);
    // The write below replaces the whole list, so a read that cannot be trusted in full must stop
    // the pass rather than become "no contact groups" and drop the operator's own.
    if (providerId(fresh.id) !== testId || !listed || current.some((g) => !g))
      throw new StatusCakeSetupError(
        'provider_rejected',
        'StatusCake returned an uptime test the platform could not read, so its contact groups were left unchanged.',
      );
    const groups = current as string[];
    const next = change(groups);
    if (next.length === groups.length && next.every((g) => groups.includes(g))) return false;
    // An empty array element clears the list, matching StatusCake's own SDK.
    await write(
      'PUT',
      `/v1/uptime/${testId}`,
      next.length === 0
        ? [['contact_groups[]', '']]
        : next.map((g): [string, string] => ['contact_groups[]', g]),
    );
    return true;
  };
  const byId = new Map(tests.map((t) => [t.id, t]));

  try {
    for (const test of tests) {
      const bound = isBound(test.id);
      const entry = { ...test, bound, state: 'not_bound' as StatusCakeTestSetupState };
      result.tests.push(entry);
      const group = owned.get(test.id);
      if (!bound) {
        if (group && input.apply) {
          await setGroups(test.id, (current) => current.filter((g) => g !== group.id));
          await write('DELETE', `/v1/contact-groups/${group.id}`);
          entry.state = 'removed';
        }
        continue;
      }
      if (!input.origin || !input.secret) {
        entry.state = 'missing';
        continue;
      }
      const pingUrl = statusCakeReceiverUrl(input.origin, input.webhookKey, test.id, input.secret);
      const attached = group ? test.contactGroups.includes(group.id) : false;
      if (group && group.pingUrl === pingUrl && attached) {
        entry.state = 'ready';
        continue;
      }
      if (!input.apply) {
        entry.state = 'missing';
        continue;
      }
      let groupId = group?.id;
      if (!groupId) {
        const created = obj(
          await api.send('POST', '/v1/contact-groups', [
            ['name', groupName(test)],
            ['ping_url', pingUrl],
          ]),
        );
        result.changes++;
        await sleep(WRITE_SPACING_MS);
        groupId = providerId(obj(created.data).new_id);
        if (!groupId)
          throw new StatusCakeSetupError(
            'provider_rejected',
            'StatusCake did not return the new contact group.',
          );
        entry.state = 'created';
      } else if (group!.pingUrl !== pingUrl) {
        await write('PUT', `/v1/contact-groups/${groupId}`, [['ping_url', pingUrl]]);
        entry.state = 'repaired';
      }
      const id = groupId;
      const changed = await setGroups(test.id, (current) =>
        current.includes(id) ? current : [...current, id],
      );
      if (entry.state === 'not_bound') entry.state = changed ? 'attached' : 'ready';
    }
    // Groups for deleted tests, and duplicates from an interrupted earlier pass. A test missing from
    // the list may only have moved between pages while it was read, so StatusCake must confirm it is
    // gone before its group is deleted.
    for (const [testId, group] of owned) {
      if (byId.has(testId) || !input.apply) continue;
      try {
        await api.get(`/v1/uptime/${testId}`);
        continue;
      } catch (error) {
        if (!(error instanceof StatusCakeSetupError) || error.category !== 'not_found') throw error;
      }
      await write('DELETE', `/v1/contact-groups/${group.id}`);
    }
    for (const group of duplicates)
      if (input.apply) await write('DELETE', `/v1/contact-groups/${group.id}`);
  } catch (error) {
    if (!(error instanceof StatusCakeSetupError)) throw error;
    // Idempotent: the next pass resumes from what StatusCake now holds.
    result.error = { category: error.category, message: error.message };
  }
  return result;
}

/**
 * Removes the platform secret from any contact-group ping URL in a StatusCake API response, so a
 * read tool never hands the webhook secret to the model.
 * @param value - Parsed StatusCake API response.
 */
export function redactStatusCakeSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactStatusCakeSecrets);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      key === 'ping_url' && typeof entry === 'string'
        ? entry.replace(/([?&]Token=)[^&#]*/gi, '$1[redacted]')
        : redactStatusCakeSecrets(entry),
    ]),
  );
}
