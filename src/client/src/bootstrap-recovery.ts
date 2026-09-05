/** One serialized recovery owner. Requests arriving during a fetch are coalesced. */
export class BootstrapRecovery<T> {
  private active?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private pending = false;
  private stopped = false;
  private attempts = 0;

  constructor(private readonly options: {
    fetch: () => Promise<T>;
    apply: (value: T) => boolean;
    failed: (error: unknown) => boolean;
    delay?: (attempt: number) => number;
  }) {}

  request(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.active) {
      this.pending = true;
      return this.active;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.active = this.run().finally(async () => {
      this.active = undefined;
      // A request can arrive in the microtask between run() finishing and this
      // finalizer. Do not drop it after the loop's last pending check.
      if (this.pending && !this.timer && !this.stopped) await this.request();
    });
    return this.active;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private async run(): Promise<void> {
    let retry = false;
    do {
      this.pending = false;
      try {
        const payload = await this.options.fetch();
        if (this.stopped) return;
        retry = !this.options.apply(payload);
        if (!retry) this.attempts = 0;
      } catch (error) {
        if (this.stopped) return;
        retry = this.options.failed(error);
        // Authentication failure must not run queued recovery requests.
        if (!retry) this.pending = false;
      }
      // Failed or stale responses back off even when new requests were queued.
      if (retry) break;
    } while (this.pending && !this.stopped);
    if (retry && !this.stopped) {
      this.attempts += 1;
      const delay = this.options.delay?.(this.attempts)
        ?? Math.min(15_000, 500 * 2 ** Math.min(this.attempts, 5));
      this.timer = setTimeout(() => void this.request(), delay);
    }
  }
}
