function missingContainer(error) {
  return /no such (?:object|container)/i.test(
    error instanceof Error ? error.message : String(error),
  );
}

export async function removeContainerChecked(run, name) {
  const removalError = await run(['docker', 'rm', '--force', name])
    .then(() => null)
    .catch((error) => error);
  let inspectError = null;
  try {
    await run(['docker', 'inspect', '--format', '{{.Id}}', name]);
  } catch (error) {
    if (missingContainer(error)) return;
    inspectError = error;
  }
  if (inspectError)
    throw new Error(`could not verify cleanup for ephemeral container ${name}`, {
      cause: inspectError,
    });
  throw new Error(
    `ephemeral container ${name} remains after cleanup${removalError ? `: ${removalError.message}` : ''}`,
  );
}

export async function settleOrThrow(promises, message) {
  const results = await Promise.allSettled(promises);
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  );
  if (failures.length > 0) throw new AggregateError(failures, message);
}
