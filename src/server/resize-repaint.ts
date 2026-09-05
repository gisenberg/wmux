const QUIET_MS = 120;
const MAX_WAIT_MS = 1000;

/** A resize repair is useful only near that resize, never after a busy turn. */
export class ResizeRepaint {
  private timer?: ReturnType<typeof setTimeout>;
  private deadline = 0;
  private lastOutput?: number;

  constructor(private readonly repaint: () => void) {}

  arm(): void {
    this.cancel();
    this.deadline = Date.now() + MAX_WAIT_MS;
    this.schedule(MAX_WAIT_MS);
  }

  output(): void {
    if (!this.deadline) return;
    this.lastOutput = Date.now();
    this.schedule(Math.min(QUIET_MS, Math.max(0, this.deadline - Date.now())));
  }

  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.deadline = 0;
    this.lastOutput = undefined;
  }

  private schedule(delay: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const quiet = this.lastOutput === undefined || Date.now() - this.lastOutput >= QUIET_MS;
      this.cancel();
      // Continuing output already redraws the application. Drop the repair
      // at its deadline rather than repainting mid-frame or much later.
      if (quiet) this.repaint();
    }, delay);
    this.timer.unref?.();
  }
}
