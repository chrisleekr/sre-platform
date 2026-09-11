import { IncidentBody } from './body';
import { IncidentControls } from './controls';
import { IncidentOverview } from './overview';
import type { IncidentLiveViewModel } from './view-model';

export function IncidentLiveView({ view }: { view: IncidentLiveViewModel }) {
  return (
    <section className="@container min-h-full min-w-0 overflow-x-hidden pb-28">
      <header className="mb-5 min-w-0 border-b border-line pb-5">
        <IncidentOverview view={view} />
        <IncidentControls view={view} />
      </header>
      <IncidentBody view={view} />
    </section>
  );
}
