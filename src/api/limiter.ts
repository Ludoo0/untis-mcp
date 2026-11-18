/** Limits concurrent requests and enforces a minimum interval between them (spec 7). */
export class Limiter {
  private active = 0;
  private waiting: (() => void)[] = [];
  private nextSlot = 0;

  constructor(
    private maxConcurrency: number,
    private minIntervalMs: number,
    private sleep: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms),
  ) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private async acquire() {
    if (this.active >= this.maxConcurrency) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active++;
    const now = Date.now();
    const start = Math.max(now, this.nextSlot);
    this.nextSlot = start + this.minIntervalMs;
    if (start > now) await this.sleep(start - now);
  }

  private release() {
    this.active--;
    this.waiting.shift()?.();
  }
}
