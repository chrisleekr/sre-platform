import { expect, test } from 'vitest';
import * as z from 'zod';
import { makeAgentSdkGenerator } from '../agent-sdk';
import { createFixture } from './agent-sdk.fixture';

const __fixture = createFixture();

test('the Agent SDK generator trims over-length output only when the caller opts in', async () => {
  const generator = () =>
    makeAgentSdkGenerator({
      runtime: __fixture.runtime,
      credential: 'provider-key',
      query: __fixture.scriptedQuery(
        [__fixture.result({ structured_output: { result: { note: 'far too long' } } })],
        () => undefined,
      ),
    });
  const limited = z.object({ note: z.string().max(5) });
  await expect(generator().generate('p', limited)).rejects.toThrow(z.ZodError);
  await expect(generator().generate('p', limited, { repairOverlength: true })).resolves.toEqual({
    note: 'far …',
  });
});
