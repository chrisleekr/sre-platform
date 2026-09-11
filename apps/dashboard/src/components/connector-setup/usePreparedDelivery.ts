import { useEffect, useRef, useState } from 'react';
import type { PrepareDelivery, PreparedDelivery } from '../../lib/connector-delivery';
import { requestErrorMessage } from '../../lib/request-error';

/** Keep an address across step navigation and serialize mode changes without storing secrets in browser storage. */
export function usePreparedDelivery(options: {
  transport: 'direct' | 'smee' | 'none';
  existing: boolean;
  storedSmee: boolean;
  hasSmeeUrl?: boolean;
  initialPath?: string;
  prepare: PrepareDelivery;
}) {
  const latest = useRef(options);
  latest.current = options;
  const cache = useRef<Partial<PreparedDelivery>>({ webhookPath: options.initialPath });
  const pending = useRef<Promise<void> | null>(null);
  const mounted = useRef(false);
  const failure = useRef('');
  const [state, setState] = useState({ ...cache.current, busy: false, error: '' });
  const ensure = async (): Promise<void> => {
    if (!mounted.current) return;
    const current = latest.current;
    if (current.transport === 'none' || failure.current) return;
    if (pending.current) {
      await pending.current;
      return ensure();
    }
    if (current.transport === 'direct' && (cache.current.webhookPath || current.existing)) return;
    const hasChannel = Boolean(cache.current.smeeUrl || current.storedSmee || current.hasSmeeUrl);
    if (current.transport === 'smee' && hasChannel && (cache.current.setupId || current.existing))
      return;
    if (mounted.current) setState({ ...cache.current, busy: true, error: '' });
    pending.current = current
      .prepare({
        transport: current.transport === 'smee' && hasChannel ? 'direct' : current.transport,
        ...(cache.current.setupId ? { setupId: cache.current.setupId } : {}),
      })
      .then((result) => {
        cache.current = { ...cache.current, ...result };
      })
      .catch((cause) => {
        if (
          latest.current.transport === current.transport &&
          latest.current.hasSmeeUrl === current.hasSmeeUrl
        )
          failure.current = requestErrorMessage(
            cause,
            'Could not prepare the webhook address. Retry when the service is available.',
          );
      })
      .finally(() => {
        pending.current = null;
        if (mounted.current) setState({ ...cache.current, busy: false, error: failure.current });
      });
    await pending.current;
  };
  const ensureRef = useRef(ensure);
  ensureRef.current = ensure;
  useEffect(() => {
    mounted.current = true;
    failure.current = '';
    setState({
      ...cache.current,
      busy: Boolean(pending.current) && options.transport !== 'none',
      error: '',
    });
    void ensureRef.current();
    return () => {
      mounted.current = false;
    };
  }, [options.transport, options.hasSmeeUrl]);
  const retry = (): void => {
    failure.current = '';
    void ensureRef.current();
  };
  return { ...state, retry };
}
