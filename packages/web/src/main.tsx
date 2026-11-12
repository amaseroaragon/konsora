import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@xyflow/react/dist/base.css";
import "./ui/ui.css";
import "./shell/base.css";
import "./shell/shell.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { bootstrapSession } from "./api/session.ts";
import { useRoute } from "./shell/route.ts";
import { WebApp } from "./shell/WebApp.tsx";
import { applyTheme, initialThemeChoice } from "./theme/apply.ts";
import { ConfirmHost, ToastProvider } from "./ui/index.ts";

applyTheme(initialThemeChoice());

// Take the token out of the fragment before anything else can read or log the URL.
const session = bootstrapSession(window.location.hash, window.sessionStorage);
if (session.route) {
  const { pathname, search } = window.location;
  window.history.replaceState(null, "", `${pathname}${search}${session.route}`);
}

function Root() {
  const route = useRoute();
  return <WebApp token={session.token} route={route} />;
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
  <StrictMode>
    <ToastProvider>
      <ConfirmHost />
      <Root />
    </ToastProvider>
  </StrictMode>,
);
