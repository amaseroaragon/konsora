import type { ProviderLimits } from "@konsora/core";
import { useLimits } from "../api/limits.ts";
import { type MessageKey, t } from "../i18n/index.ts";
import { formatUtilization, windowLabel } from "./run-model.ts";

const STATUS: Record<string, MessageKey> = {
  allowed: "limits.status.allowed",
  allowed_warning: "limits.status.allowed_warning",
  rejected: "limits.status.rejected",
};

const when = (iso: string) =>
  new Date(iso).toLocaleString("es", { dateStyle: "short", timeStyle: "short" });

/**
 * The latest known rate limits of each provider: window, use, status and reset, and where they
 * come from (read from the provider, or reported by a run).
 */
export function RateLimitList({ limits }: { limits: readonly ProviderLimits[] }) {
  const known = limits.filter((entry) => entry.windows.length > 0 && entry.at);
  if (known.length === 0) return null;
  return (
    <section className="a-callout b-limits" aria-label={t("limits.label")}>
      <p className="a-callout__text">
        <b>{t("limits.title")}</b>
      </p>
      <ul className="b-limits__list">
        {known.map((entry) => (
          <li key={entry.provider} className="b-limits__provider">
            <span className="k-mono">{entry.provider}</span>{" "}
            <span className="s-muted">
              {t(entry.source === "provider" ? "limits.read" : "limits.from", {
                at: when(entry.at ?? ""),
              })}
            </span>
            <ul className="b-limits__windows">
              {entry.windows.map((w) => (
                <li key={w.window}>
                  <span className="k-label">{windowLabel(w.window)}</span>
                  {w.utilization !== undefined && (
                    <>
                      {" "}
                      <meter
                        className="b-limits__meter"
                        min={0}
                        max={1}
                        low={0.7}
                        high={0.9}
                        optimum={0}
                        value={Math.min(1, w.utilization)}
                        aria-label={t("limits.used", { percent: formatUtilization(w.utilization) })}
                      />{" "}
                      <span className="k-mono">
                        {t("limits.used", { percent: formatUtilization(w.utilization) })}
                      </span>
                    </>
                  )}
                  {w.status && (
                    <span className="s-muted">
                      {" · "}
                      {STATUS[w.status] ? t(STATUS[w.status] as MessageKey) : w.status}
                    </span>
                  )}
                  {w.resets_at && (
                    <span className="s-muted">
                      {" · "}
                      {t("limits.resets", { at: when(w.resets_at) })}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      <p className="s-muted">{t("limits.hint")}</p>
    </section>
  );
}

/** The account's limits from the daemon, kept live by `limits.updated`. */
export function RateLimits() {
  return <RateLimitList limits={useLimits().data ?? []} />;
}
