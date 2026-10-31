import type { ButtonHTMLAttributes, ReactNode } from "react";
import { t } from "../i18n/index.ts";
import { cx } from "./cx.ts";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: "md" | "sm";
  /** Shows a spinner, keeps the label for screen readers and blocks clicks. */
  busy?: boolean;
  icon?: ReactNode;
};

export function Button({
  variant = "secondary",
  size = "md",
  busy = false,
  icon,
  disabled,
  className,
  children,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={cx(
        "k-btn",
        variant !== "secondary" && `k-btn--${variant}`,
        size === "sm" && "k-btn--sm",
        className,
      )}
    >
      {busy ? (
        <>
          <span className="k-btn__spinner" aria-hidden="true" />
          <span className="k-visually-hidden">{t("action.loading")}</span>
        </>
      ) : (
        icon
      )}
      {children}
    </button>
  );
}
