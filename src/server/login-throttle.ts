export interface LoginAttemptResult {
  allowed: boolean;
  retryAfterMs: number;
}

interface LoginAttemptEntry {
  attempts: number[];
  lastSeenAt: number;
}

/**
 * Charges attempts before password verification so concurrent requests cannot
 * all enter scrypt before a failure is recorded. The address table is capped
 * to keep an unauthenticated endpoint from growing server memory without bound.
 */
export class LoginAttemptThrottle {
  private readonly attempts = new Map<string, LoginAttemptEntry>();

  constructor(
    private readonly maxAttempts = 5,
    private readonly windowMs = 60_000,
    private readonly maxAddresses = 2_048,
  ) {}

  attempt(address: string, nowMs = Date.now()): LoginAttemptResult {
    this.prune(nowMs);
    const cutoff = nowMs - this.windowMs;
    const previous = this.attempts.get(address);
    const recent = previous?.attempts.filter((attemptedAt) => attemptedAt > cutoff) ?? [];
    if (recent.length >= this.maxAttempts) {
      this.touch(address, { attempts: recent, lastSeenAt: nowMs });
      return { allowed: false, retryAfterMs: Math.max(1, recent[0] + this.windowMs - nowMs) };
    }

    if (!previous && this.attempts.size >= this.maxAddresses) {
      const oldestAddress = this.attempts.keys().next().value as string | undefined;
      if (oldestAddress) this.attempts.delete(oldestAddress);
    }
    recent.push(nowMs);
    this.touch(address, { attempts: recent, lastSeenAt: nowMs });
    return { allowed: true, retryAfterMs: 0 };
  }

  reset(address: string): void {
    this.attempts.delete(address);
  }

  private touch(address: string, entry: LoginAttemptEntry): void {
    this.attempts.delete(address);
    this.attempts.set(address, entry);
  }

  private prune(nowMs: number): void {
    const cutoff = nowMs - this.windowMs;
    for (const [address, entry] of this.attempts) {
      if (entry.lastSeenAt > cutoff) break;
      this.attempts.delete(address);
    }
  }
}
