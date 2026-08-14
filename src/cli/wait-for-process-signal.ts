/** Wait for one termination signal and close the running server exactly once. */
export function waitForProcessSignal(
  close: () => Promise<void>,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let closing = false;
    const shutdown = () => {
      if (closing) return;
      closing = true;
      void close().then(resolve, reject);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}
