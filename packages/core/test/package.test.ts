import { describe, expect, it } from "vitest";
import { packageName } from "../src/index.ts";

describe("@konsora/core", () => {
  it("is importable from source", () => {
    expect(packageName).toBe("@konsora/core");
  });
});
