/** Bounds for one in-process authentication cache. */
export interface AuthenticationCachePolicy {
  readonly maxEntries: number;
  readonly ttlMilliseconds: number;
}

/** Default bounded-staleness policy for session and managed-key checks. */
export const defaultAuthenticationCachePolicy: AuthenticationCachePolicy = {
  maxEntries: 10_000,
  ttlMilliseconds: 30_000,
};

interface AuthenticationCacheEntry<Value> {
  readonly notAfterMilliseconds: number;
  readonly value: Value;
}

/**
 * Small in-memory, least-recently-used cache for successful authentications.
 *
 * This is a per-process, bounded-staleness optimization only; correctness
 * never depends on it. An entry lives for at most the policy TTL and never
 * past the credential's own absolute expiry, and the least recently used
 * entry is dropped once the size bound is reached. Failures are never cached,
 * so a credential created moments ago works immediately. A credential revoked
 * in another process may still authenticate here until its entry ages out.
 */
export class AuthenticationCache<Value> {
  readonly #entries = new Map<string, AuthenticationCacheEntry<Value>>();
  readonly #policy: AuthenticationCachePolicy;

  constructor(policy: AuthenticationCachePolicy) {
    this.#policy = policy;
  }

  clear(): void {
    this.#entries.clear();
  }

  evict(key: string): void {
    this.#entries.delete(key);
  }

  get(key: string, nowMilliseconds: number): Value | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    if (nowMilliseconds >= entry.notAfterMilliseconds) {
      this.#entries.delete(key);
      return undefined;
    }
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.value;
  }

  set(
    key: string,
    value: Value,
    nowMilliseconds: number,
    expiresAtMilliseconds: number,
  ): void {
    const notAfterMilliseconds = Math.min(
      nowMilliseconds + this.#policy.ttlMilliseconds,
      expiresAtMilliseconds,
    );
    if (notAfterMilliseconds <= nowMilliseconds) return;
    this.#entries.delete(key);
    this.#entries.set(key, {notAfterMilliseconds, value});
    if (this.#entries.size > this.#policy.maxEntries) {
      const oldest = this.#entries.keys().next();
      if (!oldest.done) this.#entries.delete(oldest.value);
    }
  }
}
