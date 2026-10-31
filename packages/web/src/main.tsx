import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./ui/ui.css";
import "./app/app.css";
import "./gallery/gallery.css";
import "./shell/shell.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { bootstrapSession } from "./api/session.ts";
import { App as Mock } from "./app/App.tsx";
import { Gallery } from "./gallery/Gallery.tsx";
import { useRoute } from "./shell/route.ts";
import { WebApp } from "./shell/WebApp.tsx";
import { applyTheme, initialThemeChoice } from "./theme/apply.ts";
import { ToastProvider } from "./ui/index.ts";

applyTheme(initialThemeChoice());

// Take the token out of the fragment before anything else can read or log the URL.
const session = bootstrapSession(window.location.hash, window.sessionStorage);
if (session.route) {
  const { pathname, search } = window.location;
  window.history.replaceState(null, "", `${pathname}${search}${session.route}`);
}

/** `#/muestrario` shows the component gallery, `#/maqueta` the UI-04 mock; the rest is the app. */
function Root() {
  const route = useRoute();
  if (route.name === "gallery") return <Gallery />;
  if (route.name === "mock") return <Mock />;
  return <WebApp token={session.token} route={route} />;
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
  <StrictMode>
    <ToastProvider>
      <Root />
    </ToastProvider>
  </StrictMode>,
);
