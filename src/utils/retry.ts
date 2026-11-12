/** Call `fn`, retrying after each delay in turn; rethrows the last error once the delays run out. */
export async function retryWithDelays<T>(fn: () => Promise<T>, delaysMs: readonly number[]): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= delaysMs.length) throw err;
      await new Promise((r) => setTimeout(r, delaysMs[attempt]));
    }
  }
}
