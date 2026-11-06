/**
 * What the limits view shows (UI-15), as pure functions of the daemon's `ProviderLimits` and the
 * time, so it can be tested without a browser.
 */
import type { ProviderLimits, RateLimitWindow } from "@konsora/core";
import { type MessageKey, t } from "../i18n/index.ts";
import { formatUtilization } from "./run-model.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const PROVIDERS: Record<string, MessageKey> = {
  claude: "limits.provider.claude",
  codex: "limits.provider.codex",
};

export function providerName(provider: string): string {
  const key = PROVIDERS[provider];
  return key ? t(key) : provider;
}

/** "hace 3 min", "hace 2 h"… for a past date. */
export function ago(iso: string, now: number): string {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < MINUTE) return t("limits.ago.now");
  if (ms < HOUR) return t("limits.ago.minutes", { n: Math.floor(ms / MINUTE) });
  if (ms < DAY) return t("limits.ago.hours", { n: Math.floor(ms / HOUR) });
  return t("limits.ago.days", { n: Math.floor(ms / DAY) });
}

/** "en 3 h 20 min", "en 2 d"… for a future date; `null` once it has passed. */
export function until(iso: string, now: number): string | null {
  const ms = Date.parse(iso) - now;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  if (ms < HOUR) return t("limits.in.minutes", { n: Math.max(1, Math.ceil(ms / MINUTE)) });
  if (ms < DAY) {
    const hours = Math.floor(ms / HOUR);
    const minutes = Math.floor((ms % HOUR) / MINUTE);
    return minutes
      ? t("limits.in.hours.minutes", { h: hours, m: minutes })
      : t("limits.in.hours", { h: hours });
  }
  return t("limits.in.days", { n: Math.round(ms / DAY) });
}

export const when = (iso: string) =>
  new Date(iso).toLocaleString("es", { dateStyle: "short", timeStyle: "short" });

/** Where a provider's data comes from and how old it is; for `none`, that there is none. */
export function sourceText(entry: ProviderLimits, now: number): string {
  if (entry.source === "none" || !entry.at) return t("limits.source.none");
  const age = ago(entry.at, now);
  return entry.source === "provider"
    ? t("limits.source.provider", { age, at: when(entry.at) })
    : t("limits.source.run", { age, at: when(entry.at), run: entry.run ?? "" });
}

/** The reset of a window, relative and absolute; `null` if unknown. */
export function resetText(window: RateLimitWindow, now: number): string | null {
  if (!window.resets_at) return null;
  const left = until(window.resets_at, now);
  return left
    ? t("limits.resets.in", { in: left, at: when(window.resets_at) })
    : t("limits.resets.past", { at: when(window.resets_at) });
}

/** The most used window of a provider, for the header ("Claude 84 %"); `null` if none. */
export function busiest(entry: ProviderLimits): RateLimitWindow | null {
  let top: RateLimitWindow | null = null;
  for (const window of entry.windows) {
    if (window.utilization === undefined) continue;
    if (!top || (top.utilization ?? 0) < window.utilization) top = window;
  }
  return top;
}

/** The header's summary: each provider with data and its highest use. */
export function headerSummary(limits: readonly ProviderLimits[]): string {
  return limits
    .flatMap((entry) => {
      const top = busiest(entry);
      return top?.utilization !== undefined
        ? [`${providerName(entry.provider)} ${formatUtilization(top.utilization)}`]
        : [];
    })
    .join(" · ");
}
