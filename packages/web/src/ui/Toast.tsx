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
type ToastItem = { id: number; tone: ToastTone; text: string };

type ToastApi = { show: (text: string, tone?: ToastTone) => void };

const ToastContext = createContext<ToastApi | null>(null);

const DISMISS_MS = 6000;

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
    (text: string, tone: ToastTone = "info") => {
      const id = next.current++;
      setItems((current) => [...current, { id, tone, text }]);
      if (tone !== "error") window.setTimeout(() => dismiss(id), DISMISS_MS);
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
