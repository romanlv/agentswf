/** `start`, run once and shared by every caller until it fails: the call after a failure tries again. */
export function onceUnlessFailed<A extends unknown[], T>(
  start: (...args: A) => Promise<T>,
): (...args: A) => Promise<T> {
  let running: Promise<T> | undefined;
  return (...args) => {
    if (!running) {
      const attempt = start(...args);
      running = attempt;
      attempt.catch(() => {
        if (running === attempt) running = undefined;
      });
    }
    return running;
  };
}
