/**
 * Adds up a run's `usage` events into `run.json`'s `usage`: tokens and cost are summed over the
 * run's turns; the breakdown (cache, reasoning) is kept only if the provider reported it; rate
 * limits keep the last snapshot of each window, since they describe the account, not the run.
 */
import type { RunUsage, RateLimitWindow as StoredWindow } from "@konsora/core";
import type { RateLimits, RateLimitWindow, RunEvent } from "./adapter.ts";

type UsageEvent = Extract<RunEvent, { t: "usage" }>;

const WINDOW = /^[a-z0-9_]{1,40}$/;
const MAX_WINDOWS = 10;

const tokens = (value: number | undefined): number =>
  value !== undefined && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;

/** Unix seconds → `run.json` timestamp; `undefined` if it is not a plausible date. */
function timestamp(seconds: number | undefined): string | undefined {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0 || seconds > 1e11) {
    return undefined;
  }
  return new Date(Math.round(seconds) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function stored(window: RateLimitWindow): StoredWindow | null {
  if (!WINDOW.test(window.window)) return null;
  const status = window.status?.slice(0, 40);
  const utilization = window.utilization;
  const resets = timestamp(window.resets_at);
  return {
    window: window.window,
    ...(status ? { status } : {}),
    ...(utilization !== undefined &&
    Number.isFinite(utilization) &&
    utilization >= 0 &&
    utilization <= 100
      ? { utilization }
      : {}),
    ...(resets ? { resets_at: resets } : {}),
  };
}

/** Adapter windows (reset in Unix seconds) as `run.json` stores them; invalid ones are dropped. */
export function storedWindows(windows: readonly RateLimitWindow[]): StoredWindow[] {
  const result = new Map<string, StoredWindow>();
  for (const window of windows) {
    const value = stored(window);
    if (value && (result.has(value.window) || result.size < MAX_WINDOWS)) {
      result.set(value.window, value);
    }
  }
  return [...result.values()];
}

/** The windows a `usage` event reports: its list, or the single window it names. */
export function eventWindows(limits: RateLimits | undefined): StoredWindow[] {
  if (!limits) return [];
  return storedWindows(
    limits.windows?.length
      ? limits.windows
      : limits.window
        ? [
            {
              window: limits.window,
              status: limits.status,
              ...(limits.resets_at !== undefined ? { resets_at: limits.resets_at } : {}),
            },
          ]
        : [],
  );
}

export class UsageTally {
  #input = 0;
  #output = 0;
  #cost = 0;
  #priced = false;
  #cacheRead: number | undefined;
  #cacheWrite: number | undefined;
  #reasoning: number | undefined;
  readonly #windows = new Map<string, StoredWindow>();

  add(event: UsageEvent): void {
    this.#input += tokens(event.input_tokens);
    this.#output += tokens(event.output_tokens);
    if (event.cache_read_tokens !== undefined) {
      this.#cacheRead = (this.#cacheRead ?? 0) + tokens(event.cache_read_tokens);
    }
    if (event.cache_write_tokens !== undefined) {
      this.#cacheWrite = (this.#cacheWrite ?? 0) + tokens(event.cache_write_tokens);
    }
    if (event.reasoning_tokens !== undefined) {
      this.#reasoning = (this.#reasoning ?? 0) + tokens(event.reasoning_tokens);
    }
    if (event.cost_usd !== undefined && Number.isFinite(event.cost_usd) && event.cost_usd >= 0) {
      this.#cost += event.cost_usd;
      this.#priced = true;
    }
    for (const value of eventWindows(event.rate_limits)) {
      if (!this.#windows.has(value.window) && this.#windows.size >= MAX_WINDOWS) continue;
      // A newer snapshot replaces the window, keeping what it does not repeat.
      this.#windows.set(value.window, { ...this.#windows.get(value.window), ...value });
    }
  }

  toRunUsage(): RunUsage {
    return {
      input_tokens: this.#input,
      output_tokens: this.#output,
      cost_usd: this.#priced ? Math.round(this.#cost * 1e6) / 1e6 : null,
      ...(this.#cacheRead !== undefined ? { cache_read_tokens: this.#cacheRead } : {}),
      ...(this.#cacheWrite !== undefined ? { cache_write_tokens: this.#cacheWrite } : {}),
      ...(this.#reasoning !== undefined ? { reasoning_tokens: this.#reasoning } : {}),
      ...(this.#windows.size > 0 ? { rate_limits: [...this.#windows.values()] } : {}),
    };
  }
}
