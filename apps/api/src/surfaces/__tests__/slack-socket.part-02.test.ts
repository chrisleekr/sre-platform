import { describe, expect, test, vi } from 'vitest';

import { createFixture } from './slack-socket.fixture';

const __fixture = createFixture();

describe('Slack Socket Mode manager', () => {
  test('serializes two replacements so the later candidate replaces the completed earlier one', async () => {
    const active = new __fixture.FakeSocketClient();
    const firstCandidate = new __fixture.FakeSocketClient();
    const secondCandidate = new __fixture.FakeSocketClient();
    let finishFirst!: () => void;
    firstCandidate.start.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishFirst = () => resolve({});
        }),
    );
    const clients = [active, firstCandidate, secondCandidate];
    const makeManager = await __fixture.managerFactory();
    const manager = makeManager(__fixture.deps({ createClient: () => clients.shift()! }));
    await manager.replace('cfg-a', 'xapp-active', __fixture.APP_A);

    const first = manager.replace('cfg-a', 'xapp-first', __fixture.APP_A);
    const second = manager.replace('cfg-a', 'xapp-second', __fixture.APP_A);
    await vi.waitFor(() => expect(firstCandidate.start).toHaveBeenCalledTimes(1));
    expect(secondCandidate.start).not.toHaveBeenCalled();
    finishFirst();
    await first;
    await second;

    expect(active.disconnect).toHaveBeenCalledTimes(1);
    expect(firstCandidate.disconnect).toHaveBeenCalledTimes(1);
    expect(secondCandidate.start).toHaveBeenCalledTimes(1);
  });

  test('stopAll waits behind a pending replacement and stops the candidate that becomes active', async () => {
    const active = new __fixture.FakeSocketClient();
    const candidate = new __fixture.FakeSocketClient();
    let finish!: () => void;
    candidate.start.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({});
        }),
    );
    const clients = [active, candidate];
    const makeManager = await __fixture.managerFactory();
    const manager = makeManager(__fixture.deps({ createClient: () => clients.shift()! }));
    await manager.replace('cfg-a', 'xapp-active', __fixture.APP_A);

    const replacing = manager.replace('cfg-a', 'xapp-candidate', __fixture.APP_A);
    await vi.waitFor(() => expect(candidate.start).toHaveBeenCalledTimes(1));
    const stopping = manager.stopAll();
    finish();
    await replacing;
    await stopping;

    expect(active.disconnect).toHaveBeenCalledTimes(1);
    expect(candidate.disconnect).toHaveBeenCalledTimes(1);
  });
});
