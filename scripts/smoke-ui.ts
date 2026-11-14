/**
 * UI smoke test (UI-31): the built web UI, served by the real daemon, in a real headless Chrome.
 * `npm run smoke`. It is not part of `npm run check` (it needs Chrome and takes several seconds).
 *
 * 1. Creates a project in a temporary folder with the CLI (a done task, a ready one, a blocked one)
 *    and runs `konsora ui --no-open` with temporary data and state folders, so it never touches the
 *    user's daemon or projects. `konsora ui` rebuilds the web bundle first when it is stale.
 * 2. Opens the URL in headless Chrome (playwright-core with the installed Chrome: no browser
 *    download) and checks that the board, the graph and the History load and show the plan.
 * 3. Creates a task from the UI and checks it on the board and in `konsora list --json`.
 * 4. Fails on any page error or console error, and always stops the daemon and cleans up.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright-core";

const BIN = fileURLToPath(new URL("../packages/cli/src/bin.ts", import.meta.url));
const TIMEOUT = 15_000;

const base = mkdtempSync(join(tmpdir(), "konsora-smoke-"));
const project = join(base, "weather");
const env = {
  ...process.env,
  KONSORA_DATA_DIR: join(base, "data"),
  XDG_STATE_HOME: join(base, "state"),
  KONSORA_AGENT: "claude",
};

function konsora(args: string[], cwd = project): string {
  return execFileSync(process.execPath, [BIN, ...args], { cwd, env, encoding: "utf8" });
}

function step(text: string) {
  process.stdout.write(`· ${text}\n`);
}

async function view(page: Page, projectId: string, name: "board" | "graph" | "history") {
  // Changing the fragment keeps the session token in sessionStorage, like the app's own links.
  const hash = `#/p/${projectId}${name === "board" ? "" : `?view=${name}`}`;
  // Runs in the page; this file is typed without the DOM library.
  await page.evaluate((target) => {
    (globalThis as unknown as { location: { hash: string } }).location.hash = target;
  }, hash);
}

async function main() {
  execFileSync("mkdir", ["-p", project]);
  execFileSync("git", ["init", "-q"], { cwd: project });
  konsora(["init", "--no-claude", "--name", "Weather", "--group", "BE", "--group-name", "Backend"]);
  konsora(["propose", "Cliente de la API del tiempo", "--group", "BE", "--criterion", "Responde"]);
  konsora(["propose", "Caché de respuestas", "--group", "BE", "--deps", "BE-01"]);
  konsora(["propose", "Mostrar la antigüedad de la caché", "--group", "BE", "--deps", "BE-02"]);
  konsora(["start", "BE-01"]);
  konsora([
    "finish",
    "BE-01",
    "--summary",
    "Cliente con reintentos.",
    "--evidence",
    "ac1=Probado a mano",
  ]);
  step("project with 3 tasks (1 done, 1 ready, 1 blocked)");

  const ui = konsora(["ui", "--no-open"]);
  const url = /\s(http:\/\/127\.0\.0\.1:\d+\/#\S+)/.exec(ui)?.[1];
  if (!url) throw new Error(`konsora ui printed no URL:\n${ui}`);
  const projectId = new URLSearchParams(new URL(url).hash.slice(1)).get("project");
  if (!projectId) throw new Error("the URL has no project");
  step("daemon started on a temporary data folder");

  const browser = await chromium.launch({ channel: "chrome", headless: true }).catch((error) => {
    throw new Error(
      `Could not start Google Chrome (${(error as Error).message.split("\n")[0]}). The smoke test uses the installed Chrome; install it or run it where Chrome is available.`,
    );
  });
  const problems: string[] = [];
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(TIMEOUT);
    page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") problems.push(`console error: ${message.text()}`);
    });
    // The URL of a failed request (the console error above does not say which one).
    page.on("response", (response) => {
      if (response.status() >= 400) {
        const { pathname } = new URL(response.url());
        problems.push(`HTTP ${response.status()} for ${pathname}`);
      }
    });

    await page.goto(url);
    // The board: a column per state and the plan's cards.
    await page.locator('[role="button"][aria-label^="Arrastrar BE-02"]').waitFor();
    await page.locator('[role="button"][aria-label^="Arrastrar BE-03"]').waitFor();
    for (const column of ["Por hacer", "Hecho"])
      await page.locator(`section[aria-label*="${column}"]`).first().waitFor();
    if (page.url().includes("token="))
      throw new Error("the session token stayed in the address bar");
    step("board loads with the plan's tasks");

    await view(page, projectId, "graph");
    for (const id of ["BE-01", "BE-02", "BE-03"])
      await page.locator(".react-flow__node").filter({ hasText: id }).waitFor();
    if ((await page.locator(".react-flow__edge").count()) < 2)
      throw new Error("the graph shows fewer than 2 dependency edges");
    step("graph loads with the tasks and their dependencies");

    await view(page, projectId, "history");
    const history = page.locator(".b-history__day");
    await history.filter({ hasText: "Cliente de la API del tiempo" }).waitFor();
    // All activity by default; only the closures show their summaries.
    await page.getByText("Solo cierres", { exact: true }).click();
    await history
      .filter({ hasText: "Cliente con reintentos." })
      .waitFor()
      .catch(async (error: Error) => {
        const text = await page.locator("main").innerText();
        throw new Error(`${error.message.split("\n")[0]}\nThe History shows:\n${text}`);
      });
    step("History loads with the closed task and its summary");

    await view(page, projectId, "board");
    await page.getByRole("button", { name: "Nueva tarea" }).first().click();
    const creator = page.locator('aside[aria-label="Nueva tarea"]');
    await creator.getByLabel("Título").fill("Tarea creada desde la prueba de humo");
    await creator.getByRole("button", { name: "Crear tarea" }).click();
    await page.locator('[role="button"][aria-label^="Arrastrar BE-04"]').waitFor();
    step("a task created from the UI appears on the board");

    const listed = JSON.parse(konsora(["list", "--json"])) as { id: string; title: string }[];
    const created = listed.find((task) => task.id === "BE-04");
    if (created?.title !== "Tarea creada desde la prueba de humo")
      throw new Error(`konsora list does not have the new task: ${JSON.stringify(created)}`);
    step("and in `konsora list`");

    if (problems.length) throw new Error(`the page reported errors:\n${problems.join("\n")}`);
  } finally {
    await browser.close();
  }
}

let failed = false;
try {
  await main();
  process.stdout.write("UI smoke test passed.\n");
} catch (error) {
  failed = true;
  process.stderr.write(`UI smoke test failed: ${(error as Error).message}\n`);
} finally {
  try {
    konsora(["ui", "--stop"], base);
  } catch {
    // No daemon to stop.
  }
  rmSync(base, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
