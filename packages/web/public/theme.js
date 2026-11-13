// UI-30: applies the remembered theme before the first paint, so the page never flashes in the
// wrong one. A classic script in <head> (the CSP allows 'self' scripts, not inline ones); the app
// (src/theme/apply.ts) reads and writes the same "konsora.theme" key.
(() => {
  try {
    const requested = new URLSearchParams(window.location.search).get("theme");
    const choice =
      requested === "light" || requested === "dark"
        ? requested
        : window.localStorage.getItem("konsora.theme");
    if (choice === "light" || choice === "dark")
      document.documentElement.setAttribute("data-theme", choice);
  } catch {
    // No storage: the theme follows the system.
  }
})();
