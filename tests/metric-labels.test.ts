// errorTypeLabel feeds the error_type label of searxng_errors_total. A label
// value is a new time series, so it must come from a bounded set: the error
// class name, never the message (which can carry URLs and caller input).
import { describe, expect, it } from "vitest";
import { errorTypeLabel } from "../src/metric-labels.js";

describe("errorTypeLabel", () => {
  it("uses the class name", () => {
    expect(errorTypeLabel(new TypeError("x"))).toBe("TypeError");
    class SsrfBlockedError extends Error {
      override name = "SsrfBlockedError";
    }
    expect(errorTypeLabel(new SsrfBlockedError("https://a.example/"))).toBe(
      "SsrfBlockedError",
    );
  });

  it("prefers a well-formed metricErrorType", () => {
    const err = Object.assign(new Error("m"), {
      metricErrorType: "github_fetch_failed",
    });
    expect(errorTypeLabel(err)).toBe("github_fetch_failed");
  });

  it.each([
    ["Bad Name With Spaces"],
    ["https://evil.example/?q=secret"],
    ["x".repeat(41)],
    [""],
  ])("refuses a name that is not a plain identifier: %s", (name) => {
    const err = new Error("m");
    err.name = name;
    expect(errorTypeLabel(err)).toBe("unknown");
  });

  it("refuses a malformed metricErrorType and falls back to the name", () => {
    const err = Object.assign(new RangeError("m"), {
      metricErrorType: "Has Spaces",
    });
    expect(errorTypeLabel(err)).toBe("RangeError");
  });

  it.each([["a string"], [42], [undefined], [{ name: "Fake" }]])(
    "a non-Error throw is unknown: %o",
    (v) => {
      expect(errorTypeLabel(v)).toBe("unknown");
    },
  );
});
