/**
 * In-memory store of active HTTP MCP sessions with idle-TTL eviction.
 *
 * A client that disconnects without sending `DELETE /mcp` would otherwise leak
 * its `McpServer` and transport in the session map forever (unbounded memory
 * growth). This store stamps each session's last activity and evicts (and
 * closes) any session idle for longer than the configured TTL.
 *
 * Every read/write through {@link get}/{@link set} refreshes the activity
 * timestamp so active sessions are never evicted.
 */
export class SessionStore<T> {
  private readonly entries = new Map<string, { session: T; lastActivity: number }>();
  private sweeper?: ReturnType<typeof setInterval>;

  /**
   * @param idleTtlMs How long (ms) a session may be idle before eviction.
   * @param close     Called to tear down an evicted session (e.g. server.close()).
   * @param now       Clock source (injectable for tests). Defaults to Date.now.
   */
  constructor(
    private readonly idleTtlMs: number,
    private readonly close: (session: T) => Promise<void> | void,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Store (or replace) a session and stamp it as active now. */
  set(id: string, session: T): void {
    this.entries.set(id, { session, lastActivity: this.now() });
  }

  /** Return a session, refreshing its activity timestamp, or undefined. */
  get(id: string): T | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    entry.lastActivity = this.now();
    return entry.session;
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  /** Remove a session without closing it (the caller owns teardown). */
  delete(id: string): boolean {
    return this.entries.delete(id);
  }

  get size(): number {
    return this.entries.size;
  }

  /** All currently-stored sessions (for shutdown). */
  values(): T[] {
    return [...this.entries.values()].map((e) => e.session);
  }

  /**
   * Evict and close every session idle for longer than the TTL.
   * Returns the ids that were evicted.
   */
  async evictIdle(): Promise<string[]> {
    const cutoff = this.now() - this.idleTtlMs;
    const evicted: string[] = [];
    for (const [id, entry] of this.entries) {
      if (entry.lastActivity <= cutoff) {
        this.entries.delete(id);
        evicted.push(id);
        try {
          await this.close(entry.session);
        } catch {
          /* ignore cleanup errors */
        }
      }
    }
    return evicted;
  }

  /** Start periodic eviction. The timer is unref'd so it never holds the process open. */
  startSweeping(intervalMs: number): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => {
      void this.evictIdle();
    }, intervalMs);
    this.sweeper.unref?.();
  }

  /** Stop periodic eviction. */
  stopSweeping(): void {
    if (this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = undefined;
    }
  }
}
