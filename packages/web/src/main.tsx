import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./ui/ui.css";
import "./gallery/gallery.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Gallery } from "./gallery/Gallery.tsx";
import { applyTheme, initialThemeChoice } from "./theme/apply.ts";
import { ToastProvider } from "./ui/index.ts";

applyTheme(initialThemeChoice());

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
  <StrictMode>
    <ToastProvider>
      <Gallery />
    </ToastProvider>
  </StrictMode>,
);
