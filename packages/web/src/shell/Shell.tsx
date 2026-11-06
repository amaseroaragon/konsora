import type { ReactNode } from "react";
import { ApiError } from "../api/client.ts";
import { t } from "../i18n/index.ts";
import { Button, Panel } from "../ui/index.ts";
import { Brand } from "./Brand.tsx";
import { Rich } from "./Rich.tsx";

/**
 * The real app's frame: header with the brand, a link home and, once there is a session, the
 * link to the usage limits (`nav`), then the page.
 */
export function Shell({
  children,
  nav,
  home = false,
}: {
  children: ReactNode;
  nav?: ReactNode;
  home?: boolean;
}) {
  return (
    <div className="a-app">
      <header className="a-header">
        <Brand />
        <nav className="a-header__cell" aria-label={t("shell.nav")}>
          <a className="s-nav__link" href="#/" aria-current={home ? "page" : undefined}>
            {t("shell.home")}
          </a>
        </nav>
        {nav && <div className="a-header__cell">{nav}</div>}
      </header>
      <main className="s-page">{children}</main>
    </div>
  );
}

/** Shown when there is no usable session token (opened without `konsora ui`, or expired). */
export function NoSession({ expired = false }: { expired?: boolean }) {
  return (
    <Shell>
      <div className="s-narrow">
        <Panel title={t("session.title")}>
          <p className="s-text">
            <Rich text={expired ? t("session.expired") : t("session.text")} />
          </p>
        </Panel>
      </div>
    </Shell>
  );
}

/** Error from a query: an expired session, the daemon gone, or anything else (with retry). */
export function QueryError({ error, retry }: { error: unknown; retry: () => void }) {
  const text = !(error instanceof ApiError)
    ? t("error.generic", { message: String(error) })
    : error.unauthorized
      ? t("session.expired")
      : error.code === "unknown_endpoint" || (error.status === 404 && error.message === "Not found")
        ? t("session.stale_daemon")
        : error.code === "network"
          ? t("session.offline")
          : t("error.generic", { message: error.message });
  return (
    <div className="s-alert" role="alert">
      <p className="s-text">
        <Rich text={text} />
      </p>
      <Button size="sm" onClick={retry}>
        {t("action.retry")}
      </Button>
    </div>
  );
}
