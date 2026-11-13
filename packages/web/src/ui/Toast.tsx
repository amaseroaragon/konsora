import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { t } from "../i18n/index.ts";

export type ToastTone = "info" | "success" | "error";
/** A button in the notice, such as «Deshacer» (UI-21); pressing it also dismisses the notice. */
export type ToastAction = { label: string; run: () => void };
type ToastItem = { id: number; tone: ToastTone; text: string; action?: ToastAction | undefined };

type ToastApi = { show: (text: string, tone?: ToastTone, action?: ToastAction) => void };

const ToastContext = createContext<ToastApi | null>(null);

const DISMISS_MS = 6000;
/** A notice with an action stays longer, so there is time to use it. */
const ACTION_DISMISS_MS = 12_000;

/**
 * Hosts transient notices. Info/success use a polite live region; errors use role="alert"
 * and stay until dismissed, so they are never missed.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(1);

  const dismiss = useCallback((id: number) => {
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  const show = useCallback(
    (text: string, tone: ToastTone = "info", action?: ToastAction) => {
      const id = next.current++;
      setItems((current) => [...current, { id, tone, text, action }]);
      if (tone !== "error")
        window.setTimeout(() => dismiss(id), action ? ACTION_DISMISS_MS : DISMISS_MS);
    },
    [dismiss],
  );

  const api = useMemo(() => ({ show }), [show]);
  return (
    <ToastContext.Provider value={api}>
      {children}
      <section aria-label={t("toast.region")}>
        <ul className="k-toasts">
          {items.map((item) => (
            <li
              key={item.id}
              className={`k-toast k-toast--${item.tone}`}
              role={item.tone === "error" ? "alert" : "status"}
            >
              <span className="k-toast__mark" aria-hidden="true" />
              <span className="k-toast__text">{item.text}</span>
              {item.action && (
                <button
                  type="button"
                  className="k-toast__action"
                  onClick={() => {
                    dismiss(item.id);
                    item.action?.run();
                  }}
                >
                  {item.action.label}
                </button>
              )}
              <button
                type="button"
                className="k-toast__close"
                aria-label={t("toast.dismiss")}
                onClick={() => dismiss(item.id)}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      </section>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error("useToast must be used inside <ToastProvider>");
  return api;
}
