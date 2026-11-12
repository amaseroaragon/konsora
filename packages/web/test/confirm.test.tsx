import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { confirmDelete, confirmRevert } from "../src/shell/board-model.ts";
import { confirmUnlink } from "../src/shell/ProjectsPage.tsx";
import { ConfirmHost } from "../src/ui/ConfirmDialog.tsx";
import { askConfirm, getOpenConfirm } from "../src/ui/confirm.ts";

describe("the app's own confirmation (UI-08)", () => {
  it("cancelling resolves no and leaves no question open", async () => {
    const pending = confirmRevert("BE-01", askConfirm);
    expect(getOpenConfirm()?.question).toBe(
      "¿Revertir el cambio externo en BE-01? La tarea vuelve a su versión anterior.",
    );
    expect(getOpenConfirm()?.options).toEqual({ yes: "Revertir", danger: true });
    getOpenConfirm()?.answer(false);
    expect(await pending).toBe(false);
    expect(getOpenConfirm()).toBeNull();
  });

  it("confirming resolves yes", async () => {
    const pending = confirmUnlink("Konsora", askConfirm);
    expect(getOpenConfirm()?.options).toEqual({ yes: "Desvincular", danger: true });
    getOpenConfirm()?.answer(true);
    expect(await pending).toBe(true);
    expect(getOpenConfirm()).toBeNull();
  });

  it("a newer question answers the older one no and stays open itself", async () => {
    const older = askConfirm("primera");
    const newer = askConfirm("segunda");
    expect(await older).toBe(false);
    expect(getOpenConfirm()?.question).toBe("segunda");
    getOpenConfirm()?.answer(true);
    expect(await newer).toBe(true);
  });

  it("answering twice is harmless", async () => {
    const pending = askConfirm("una vez");
    const open = getOpenConfirm();
    open?.answer(false);
    open?.answer(true);
    expect(await pending).toBe(false);
    expect(getOpenConfirm()).toBeNull();
  });

  it("renders the question in a modal dialog labelled by its title, Cancelar first", async () => {
    expect(renderToStaticMarkup(<ConfirmHost />)).toBe("");

    const pending = askConfirm("¿Seguro?");
    const html = renderToStaticMarkup(<ConfirmHost />);
    expect(html).toContain('<dialog class="b-dialog"');
    expect(html).toContain("Confirmar acción");
    expect(html).toContain("¿Seguro?");
    for (const attr of ["aria-labelledby", "aria-describedby"]) {
      const id = new RegExp(`${attr}="([^"]+)"`).exec(html)?.[1];
      expect(id).toBeDefined();
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain('class="k-btn k-btn--primary"');
    expect(html.indexOf(">Cancelar</button>")).toBeLessThan(html.indexOf(">Confirmar</button>"));

    getOpenConfirm()?.answer(false);
    expect(await pending).toBe(false);
  });

  it("a destructive question names the action on a red button", async () => {
    const pending = confirmDelete(["BE-01"], [], askConfirm);
    const html = renderToStaticMarkup(<ConfirmHost />);
    expect(html).toContain("¿Eliminar BE-01?");
    expect(html).toMatch(/class="k-btn k-btn--danger"[^>]*>Eliminar<\/button>/);
    expect(html).not.toContain(">Confirmar</button>");
    getOpenConfirm()?.answer(false);
    expect(await pending).toBe(false);
  });
});
