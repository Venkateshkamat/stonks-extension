/**
 * Virtual timers for scheduling tests: replaces global setTimeout / clearTimeout and drives a shared fake clock
 * (`clock.t`, epoch ms) that the controller reads through its `now` dependency. Promises still settle for real, so
 * `advance` flushes the microtask / immediate queues between timer callbacks.
 */
export interface FakeClock {
  t: number;
}

interface Timer {
  id: number;
  at: number;
  fn: () => void;
  unref(): Timer;
}

export class FakeTimers {
  private timers: Timer[] = [];
  private seq = 0;
  private orig?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
  /** Every delay passed to setTimeout while installed, in call order. */
  readonly delays: number[] = [];

  constructor(readonly clock: FakeClock) {}

  install(): void {
    this.orig = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
    globalThis.setTimeout = ((fn: () => void, ms = 0) => {
      this.delays.push(ms);
      const t: Timer = { id: ++this.seq, at: this.clock.t + Math.max(0, ms), fn, unref: () => t };
      this.timers.push(t);
      return t;
    }) as unknown as typeof setTimeout;
    globalThis.clearTimeout = ((t: Timer) => {
      this.timers = this.timers.filter((x) => x !== t);
    }) as unknown as typeof clearTimeout;
  }

  uninstall(): void {
    if (this.orig) {
      globalThis.setTimeout = this.orig.setTimeout;
      globalThis.clearTimeout = this.orig.clearTimeout;
    }
  }

  /** Number of timers currently waiting. */
  get pending(): number {
    return this.timers.length;
  }

  /** Delay until the next timer fires, or undefined when none is pending. */
  get nextIn(): number | undefined {
    return this.timers.length ? Math.min(...this.timers.map((t) => t.at)) - this.clock.t : undefined;
  }

  /** Lets pending promise continuations run. */
  async flush(): Promise<void> {
    for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r));
  }

  /** Moves the clock forward by `ms`, firing due timers in order. */
  async advance(ms: number): Promise<void> {
    const end = this.clock.t + ms;
    await this.flush();
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.timers[0];
      if (!next || next.at > end) break;
      this.timers.shift();
      this.clock.t = Math.max(this.clock.t, next.at);
      next.fn();
      await this.flush();
    }
    this.clock.t = end;
    await this.flush();
  }
}
