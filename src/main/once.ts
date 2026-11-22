/**
 * Wraps a task so that asking for it again while it is still going does nothing: the
 * second request ends at once and the first carries on alone. Used for things started
 * by a click that open dialogs of their own, where a second click must not start a
 * second run on top of the first.
 *
 * A failure is passed to `onError` and is not thrown, so a caller with nobody to tell
 * can simply let the promise go.
 */
export function oneAtATime(
  task: () => Promise<void>,
  onError: (error: unknown) => void,
): () => Promise<void> {
  let running = false;
  return async () => {
    if (running) return;
    running = true;
    try {
      await task();
    } catch (error) {
      onError(error);
    } finally {
      running = false;
    }
  };
}
