/**
 * The providers' rate limits at any time (DMN-06), without launching a run or spending quota.
 *
 * - A direct read from each adapter that has one (`rateLimits()`: Codex's
 *   `account/rateLimits/read`, Claude Code's local `/usage`), kept for `ttlMs` so the UI can ask
 *   often without spawning a process each time. Concurrent asks share one read.
 * - What runs report: the `usage` events of live runs as they arrive, and the `rate_limits` of
 *   every run's `run.json` in the linked projects.
 * - Per provider, the freshest of both wins (`providerLimits` in core), with its source and date.
 *   Any change is broadcast to every WebSocket client as `limits.updated`.
 */
import {
  type LimitsReading,
  latestRateLimits,
  type Provider,
  type ProviderLimits,
  type ProviderRateLimits,
  providerLimits,
  type Run,
} from "@konsora/core";
import { type AgentAdapter, eventWindows, type RateLimits, storedWindows } from "@konsora/runner";

export const LIMITS_TTL_MS = 60_000;

export type LimitsOptions = {
  adapters: Partial<Record<Provider, AgentAdapter>>;
  /** Every run of every linked project (their `run.json`). */
  runs: () => Promise<Run[]>;
  /** Sends `limits.updated` to every client. */
  broadcast?: (payload: unknown) => void;
  ttlMs?: number;
  now?: () => Date;
};

export class Limits {
  readonly #options: LimitsOptions;
  readonly #readings = new Map<Provider, LimitsReading>();
  /** What live runs reported since the daemon started, by provider. */
  readonly #live = new Map<Provider, ProviderRateLimits>();
  #readAt = Number.NEGATIVE_INFINITY;
  #reading: Promise<void> | null = null;
  #sent = "";

  constructor(options: LimitsOptions) {
    this.#options = options;
  }

  /** The limits of every provider, read again if the last read is older than the TTL. */
  async list(options: { refresh?: boolean } = {}): Promise<ProviderLimits[]> {
    const stale = this.#now().getTime() - this.#readAt >= (this.#options.ttlMs ?? LIMITS_TTL_MS);
    if (options.refresh || stale) await this.#read();
    return this.#publishIfChanged();
  }

  /** A live run's `usage` event: its windows replace that provider's run data. */
  async onRunUsage(run: Pick<Run, "id" | "agent">, at: string, limits: RateLimits): Promise<void> {
    const windows = eventWindows(limits);
    if (windows.length === 0) return;
    const provider = run.agent.provider;
    const known = this.#live.get(provider);
    // Windows the event does not repeat are kept from the same run's earlier events.
    const base = known?.run === run.id ? known.windows : [];
    const merged = new Map(base.map((w) => [w.window, w]));
    for (const w of windows) merged.set(w.window, { ...merged.get(w.window), ...w });
    this.#live.set(provider, { provider, run: run.id, at, windows: [...merged.values()] });
    await this.#publishIfChanged();
  }

  #read(): Promise<void> {
    this.#reading ??= (async () => {
      const entries = Object.entries(this.#options.adapters) as [Provider, AgentAdapter][];
      await Promise.all(
        entries.map(async ([provider, adapter]) => {
          if (!adapter.rateLimits) {
            this.#readings.delete(provider);
            return;
          }
          const at = this.#stamp();
          try {
            const windows = storedWindows(await adapter.rateLimits());
            this.#readings.set(provider, { at, windows });
          } catch (error) {
            const reason = error instanceof Error ? error.message : "unknown error";
            this.#readings.set(provider, { at, error: reason });
          }
        }),
      );
      this.#readAt = this.#now().getTime();
    })().finally(() => {
      this.#reading = null;
    });
    return this.#reading;
  }

  async #compute(): Promise<ProviderLimits[]> {
    const runs = await this.#options.runs().catch(() => [] as Run[]);
    const fromRuns = new Map(latestRateLimits(runs).map((l) => [l.provider, l]));
    for (const [provider, live] of this.#live) {
      const stored = fromRuns.get(provider);
      if (!stored || live.at >= stored.at) fromRuns.set(provider, live);
    }
    return (Object.keys(this.#options.adapters) as Provider[])
      .sort()
      .map((provider) =>
        providerLimits(provider, this.#readings.get(provider), fromRuns.get(provider)),
      );
  }

  async #publishIfChanged(): Promise<ProviderLimits[]> {
    const limits = await this.#compute();
    const text = JSON.stringify(limits);
    if (text !== this.#sent) {
      this.#sent = text;
      this.#options.broadcast?.({ type: "limits.updated", limits });
    }
    return limits;
  }

  #now(): Date {
    return this.#options.now?.() ?? new Date();
  }

  #stamp(): string {
    return this.#now()
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z");
  }
}
