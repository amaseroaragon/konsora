import { describe, expect, it } from "vitest";
import { ApiError } from "../src/api/client.ts";
import { undoErrorText } from "../src/shell/undo.ts";

describe("undo from the notice (UI-21)", () => {
  it("explains a refused undo instead of overwriting a newer change (ac3)", () => {
    const conflict = new ApiError(409, "conflict", "BE-02 changed since that action", {
      task: "BE-02",
    });
    expect(undoErrorText(conflict)).toBe(
      "No se puede deshacer: BE-02 cambió después y deshacer pisaría ese cambio. Revísala y cámbiala a mano.",
    );
    expect(undoErrorText(new ApiError(409, "plan_invalid", "x"))).toMatch(/plan/i);
    expect(undoErrorText(new Error("boom"))).toBe("No se pudo deshacer: boom");
  });
});
