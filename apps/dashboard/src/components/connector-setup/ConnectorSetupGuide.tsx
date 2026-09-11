import { CONNECTOR_GUIDES } from './guides';

/** Keep prerequisites visible while longer provider instructions remain available in place. */
export function ConnectorSetupGuide({ provider }: { provider: keyof typeof CONNECTOR_GUIDES }) {
  const guide = CONNECTOR_GUIDES[provider];
  return (
    <section
      aria-label="Setup instructions"
      className="min-w-0 rounded border border-info-line bg-info-soft p-3 text-sm"
    >
      <h3 className="font-semibold text-ink">Before you start</h3>
      <p className="mt-1 text-ink-secondary">{guide.prerequisite}</p>
      <details className="mt-3 min-w-0">
        <summary className="cursor-pointer font-medium text-info focus-visible:outline-2 focus-visible:outline-focus">
          Step-by-step setup instructions
        </summary>
        <ol className="mt-3 list-decimal space-y-3 pl-5 text-ink-secondary">
          {guide.steps.map((step) => (
            <li key={step} className="pl-1 [overflow-wrap:anywhere]">
              {step}
            </li>
          ))}
        </ol>
        <div className="mt-4 border-t border-info-line pt-3">
          <h4 className="font-semibold text-ink">How to confirm it works</h4>
          <p className="mt-1 text-ink-secondary">{guide.verification}</p>
          <a
            href={guide.documentation}
            target="_blank"
            rel="noreferrer"
            className="mt-3 inline-block font-medium text-info underline"
          >
            Official provider documentation ↗
          </a>
        </div>
      </details>
    </section>
  );
}
