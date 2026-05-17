import { describe, expect, it } from "vitest";
import { getRequestId, newRequestId, withRequestId } from "../src/context.js";

describe("requestContext", () => {
  it("returns a UUID-ish string from newRequestId", () => {
    const id = newRequestId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("returns undefined outside withRequestId", () => {
    expect(getRequestId()).toBeUndefined();
  });

  it("exposes the id inside withRequestId", () => {
    const id = "req-123";
    withRequestId(id, () => {
      expect(getRequestId()).toBe(id);
    });
  });

  it("isolates contexts across concurrent flows", async () => {
    const seen: Array<string | undefined> = [];
    await Promise.all([
      withRequestId("A", async () => {
        await new Promise((r) => setTimeout(r, 5));
        seen.push(getRequestId());
      }),
      withRequestId("B", async () => {
        await new Promise((r) => setTimeout(r, 1));
        seen.push(getRequestId());
      }),
    ]);
    expect(seen.sort()).toEqual(["A", "B"]);
  });
});
