import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { LiveIncidentConversation } from '../../src/components/incident-conversation/live';
import { triageWorkspace } from './incident-triage-data.fixture';
import '../../src/index.css';
import '@fontsource-variable/ibm-plex-sans';
import '@fontsource/ibm-plex-mono';

const credentials = async () => ({ kind: 'bearer' as const, token: 'isolated-fixture' });
createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <div className="flex h-dvh min-w-0 bg-canvas text-ink">
      <aside className="hidden w-60 shrink-0 border-r border-line p-5 lg:block">
        <p className="font-semibold">SRE Platform</p>
        <p className="mt-5">Incident response</p>
        <p className="mt-3 text-xs text-ink-muted">Isolated browser fixture</p>
      </aside>
      <main id="main-content" className="min-w-0 flex-1 overflow-y-auto p-4 sm:p-6">
        <div className="mb-4 flex flex-wrap gap-3 text-xs">
          <button className="min-h-11 underline" onClick={() => void fetch('/__api/disconnect')}>
            Disconnect stream
          </button>
          <button className="min-h-11 underline" onClick={() => void fetch('/__api/publish')}>
            Publish update
          </button>
        </div>
        <LiveIncidentConversation
          workspace={
            new URLSearchParams(location.search).has('long')
              ? {
                  ...triageWorkspace,
                  incident: {
                    ...triageWorkspace.incident,
                    title: `Checkout requests ${'across-very-long-resource-identities-'.repeat(12)}`,
                  },
                }
              : triageWorkspace
          }
          getCredentials={credentials}
          refreshWorkspace={() => {}}
          viewerName="Responder"
        />
      </main>
    </div>
  </BrowserRouter>,
);
