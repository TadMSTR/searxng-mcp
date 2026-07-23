import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/version.js";

describe("VERSION single-source", () => {
  it("matches package.json version and is never the 0.0.0 fallback", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect(VERSION).toBe(pkg.version);
    expect(VERSION).not.toBe("0.0.0");
  });
});
