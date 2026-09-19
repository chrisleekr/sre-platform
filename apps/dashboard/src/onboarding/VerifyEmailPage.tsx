import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  browserSessionRequest,
  readSignInRetry,
  useApplicationSession,
} from '../lib/application-session';
import { PublicShell, fieldClass, primaryButton } from './shared';
import { SignInStartNotice } from './SignInStartNotice';

/** Completes mailbox proof before the server creates an authenticated session. */
export function VerifyEmailPage() {
  const session = useApplicationSession();
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const [proof, setProof] = useState<{ recipient: string; expiresAt: number; resendAt: number }>();
  const [now, setNow] = useState(Date.now());
  const [notice, setNotice] = useState('');
  const retry = readSignInRetry();
  useEffect(() => {
    let live = true;
    void browserSessionRequest<NonNullable<typeof proof>>('mailbox')
      .then((value) => {
        if (live) setProof(value);
      })
      .catch((cause) => {
        if (live)
          setError(cause instanceof Error ? cause.message : 'Email verification is unavailable.');
      });
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  async function resend() {
    if (busy.current) return;
    busy.current = true;
    setSaving(true);
    setError(undefined);
    setNotice('');
    try {
      const next = await browserSessionRequest<{ expiresAt: number; resendAt: number }>(
        'resend-email',
        {},
      );
      setProof((current) => (current ? { ...current, ...next } : current));
      setCode('');
      setNotice('A new code was sent. The previous code no longer works.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The code could not be sent.');
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy.current) return;
    busy.current = true;
    setSaving(true);
    setError(undefined);
    try {
      const result = await browserSessionRequest<{ returnTo: string }>('verify-email', { code });
      await session.refresh();
      navigate(result.returnTo, { replace: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Email verification failed. Try again.');
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }
  return (
    <PublicShell>
      <h1 className="text-2xl font-medium">Check your work email</h1>
      {(session.error || session.isStarting) && (
        <SignInStartNotice
          error={session.error?.message}
          pending={session.isStarting}
          onRetry={
            retry ? () => session.signIn({ providerId: retry.providerId }, retry) : undefined
          }
        />
      )}
      <p className="mt-3 text-sm leading-6 text-ink-muted">
        Your directory confirmed your identity but did not verify your email address. Enter the
        eight-digit code
        {proof ? (
          <>
            {' '}
            sent to <strong>{proof.recipient}</strong>
          </>
        ) : (
          ' sent to your work email'
        )}
        .
      </p>
      {proof && (
        <p className="mt-2 text-sm text-ink-muted">
          {proof.expiresAt > now
            ? `Expires at ${new Date(proof.expiresAt).toLocaleTimeString()}.`
            : 'This code has expired. Restart the same sign-in to receive another.'}
        </p>
      )}
      <form className="mt-5" onSubmit={(event) => void submit(event)}>
        <label htmlFor="mailbox-code" className="text-sm font-medium">
          Verification code
        </label>
        <input
          id="mailbox-code"
          autoComplete="one-time-code"
          inputMode="numeric"
          pattern="[0-9]{8}"
          maxLength={8}
          required
          className={fieldClass}
          value={code}
          onChange={(event) => setCode(event.target.value)}
        />
        {error && (
          <p role="alert" className="mt-3 text-sm text-critical">
            {error}
          </p>
        )}
        <button
          type="submit"
          className={`${primaryButton} mt-4`}
          disabled={saving || session.isStarting || code.length !== 8}
        >
          {saving ? 'Verifying…' : 'Verify email and continue'}
        </button>
      </form>
      <p role="status" className="mt-3 text-sm text-success">
        {notice}
      </p>
      <p className="mt-5 text-sm text-ink-muted">No email? Check your spam folder.</p>
      <div className="mt-2 flex flex-wrap gap-4 text-sm">
        <button
          type="button"
          className="font-semibold text-accent underline disabled:text-ink-muted"
          disabled={
            saving || session.isStarting || !proof || proof.resendAt > now || proof.expiresAt <= now
          }
          onClick={() => void resend()}
        >
          {proof && proof.resendAt > now
            ? `Send another code in ${Math.ceil((proof.resendAt - now) / 1_000)}s`
            : 'Send another code'}
        </button>
        {retry ? (
          <button
            type="button"
            className="font-semibold text-accent underline"
            disabled={saving || session.isStarting}
            onClick={() => session.signIn({ providerId: retry.providerId }, retry)}
          >
            Restart this sign-in
          </button>
        ) : (
          <Link className="font-semibold text-accent underline" to="/sign-in">
            Return to sign-in
          </Link>
        )}
      </div>
    </PublicShell>
  );
}
