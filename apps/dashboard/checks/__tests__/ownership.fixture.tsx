import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { WorkspacesPage } from '../../src/admin/WorkspacesPage';
import { MembersPage } from '../../src/components/MembersPanel';
import { ApplicationSessionProvider } from '../../src/lib/application-session';
import { setLocalSession } from '../../src/local-session';
import '../../src/index.css';

const state = window as unknown as { operatorToken: string; memberToken: string };
const signIn = (token: string) =>
  setLocalSession({ token, email: 'acceptance@example.test', expiresAt: Date.now() + 300000 });
signIn(state.operatorToken);
function Acceptance() {
  const [mode, setMode] = useState('admin');
  return (
    <ApplicationSessionProvider>
      <MemoryRouter>
        <main className="min-h-screen bg-canvas p-4 text-ink">
          <button
            onClick={() => {
              signIn(state.memberToken);
              setMode('member');
            }}
          >
            View as member
          </button>
          {mode === 'admin' ? <WorkspacesPage /> : <MembersPage />}
        </main>
      </MemoryRouter>
    </ApplicationSessionProvider>
  );
}
createRoot(document.getElementById('root')!).render(<Acceptance />);
