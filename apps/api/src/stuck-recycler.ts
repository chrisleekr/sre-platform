import type { StuckJobInfo } from '@sre/queue';

// Synchronous on purpose: the requeued row is claimable by another replica from the moment of the
// fenced write, so nothing may be awaited between the log line and the exit.
export const onStuck = (info: StuckJobInfo): void => {
  console.error(
    JSON.stringify({
      level: 'error',
      app: 'api',
      msg: 'job handler stuck past deadline; recycling process',
      ...info,
    }),
  );
  process.exit(1);
};
