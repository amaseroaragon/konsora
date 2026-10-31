import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./ui/ui.css";
import "./app/app.css";
import "./gallery/gallery.css";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App.tsx";
import { Gallery } from "./gallery/Gallery.tsx";
import { applyTheme, initialThemeChoice } from "./theme/apply.ts";
import { ToastProvider } from "./ui/index.ts";

applyTheme(initialThemeChoice());

/** `#/muestrario` shows the component gallery; anything else the (mock) app. */
function Root() {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onHash = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return hash === "#/muestrario" ? <Gallery /> : <App />;
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
