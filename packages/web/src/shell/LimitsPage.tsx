import type { ProviderLimits } from "@konsora/core";
import { useEffect, useState } from "react";
import { useLimits, useLimitsEvents, useRefreshLimits } from "../api/limits.ts";
import { type MessageKey, t } from "../i18n/index.ts";
import { Button, Panel } from "../ui/index.ts";
import { headerSummary, providerName, resetText, sourceText } from "./limits-model.ts";
import { formatUtilization, windowLabel } from "./run-model.ts";
import { QueryError } from "./Shell.tsx";

const STATUS: Record<string, MessageKey> = {
  allowed: "limits.status.allowed",
  allowed_warning: "limits.status.allowed_warning",
  rejected: "limits.status.rejected",
};

/** Re-renders every 30 s, so ages and resets stay current. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

/** One provider: where the data comes from, how old it is, and each window. */
export function ProviderLimitsPanel({ entry, now }: { entry: ProviderLimits; now: number }) {
  const name = providerName(entry.provider);
  return (
    <Panel title={name} eyebrow={t("limits.provider.eyebrow")}>
      <p className="s-text s-muted">{sourceText(entry, now)}</p>
      {entry.unavailable && (
        <p className="s-text s-muted">{t("limits.unavailable", { reason: entry.unavailable })}</p>
      )}
      {entry.windows.length > 0 && (
        <table className="s-limits">
          <caption className="k-visually-hidden">{t("limits.table", { name })}</caption>
          <thead>
            <tr>
              <th scope="col">{t("limits.col.window")}</th>
              <th scope="col">{t("limits.col.used")}</th>
              <th scope="col">{t("limits.col.status")}</th>
              <th scope="col">{t("limits.col.reset")}</th>
            </tr>
          </thead>
          <tbody>
            {entry.windows.map((w) => {
              const reset = resetText(w, now);
              return (
                <tr key={w.window}>
                  <th scope="row" className="k-label">
                    {windowLabel(w.window)}
                  </th>
                  <td>
                    {w.utilization !== undefined ? (
                      <span className="s-limits__used">
                        <meter
                          className="s-limits__meter"
                          min={0}
                          max={1}
                          low={0.7}
                          high={0.9}
                          optimum={0}
                          value={Math.min(1, w.utilization)}
                          aria-label={t("limits.used", {
                            percent: formatUtilization(w.utilization),
                          })}
                        />
                        <span className="k-mono">{formatUtilization(w.utilization)}</span>
                      </span>
                    ) : (
                      <span className="s-muted">{t("limits.unknown")}</span>
                    )}
                  </td>
                  <td>
                    {w.status ? (
                      STATUS[w.status] ? (
                        t(STATUS[w.status] as MessageKey)
                      ) : (
                        w.status
                      )
                    ) : (
                      <span className="s-muted">{t("limits.unknown")}</span>
                    )}
                  </td>
                  <td>{reset ?? <span className="s-muted">{t("limits.unknown")}</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

/** The limits of every provider, side by side. */
export function LimitsList({ limits, now }: { limits: readonly ProviderLimits[]; now: number }) {
  if (limits.length === 0) return <p className="s-text s-muted">{t("limits.empty")}</p>;
  return (
    <div className="s-limits__grid">
      {limits.map((entry) => (
        <ProviderLimitsPanel key={entry.provider} entry={entry} now={now} />
      ))}
    </div>
  );
}

/** `#/limites`: the account's limits, always reachable from the header, live. */
export function LimitsPage() {
  const limits = useLimits();
  const refresh = useRefreshLimits();
  const now = useNow();
  useLimitsEvents();
  return (
    <div className="s-stack">
      <div className="s-limits__head">
        <div>
          <h1 className="s-limits__title">{t("limits.page.title")}</h1>
          <p className="s-text s-muted">{t("limits.page.text")}</p>
        </div>
        <Button size="sm" busy={refresh.isPending} onClick={() => refresh.mutate()}>
          {t("limits.refresh")}
        </Button>
      </div>
      {limits.isPending && <p className="s-text s-muted">{t("action.loading")}</p>}
      {limits.isError && <QueryError error={limits.error} retry={() => limits.refetch()} />}
      {refresh.isError && <QueryError error={refresh.error} retry={() => refresh.mutate()} />}
      {limits.data && <LimitsList limits={limits.data} now={now} />}
    </div>
  );
}

/** The header's link to the limits view, with each provider's highest use when known. */
export function LimitsLink({ current }: { current: boolean }) {
  const summary = headerSummary(useLimits().data ?? []);
  return (
    <a
      className="s-nav__link"
      href="#/limites"
      aria-current={current ? "page" : undefined}
      title={t("limits.nav.title")}
    >
      {t("limits.nav")}
      {summary && <span className="s-nav__meta k-mono"> · {summary}</span>}
    </a>
  );
}
