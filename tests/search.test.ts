import { describe, it, expect } from "vitest";
import { CategorySchema, TimeRangeSchema } from "../src/types.js";

describe("CategorySchema", () => {
  it("accepts valid categories", () => {
    expect(CategorySchema.parse("general")).toBe("general");
    expect(CategorySchema.parse("news")).toBe("news");
    expect(CategorySchema.parse("it")).toBe("it");
    expect(CategorySchema.parse("science")).toBe("science");
  });

  it("defaults to 'general' when undefined", () => {
    expect(CategorySchema.parse(undefined)).toBe("general");
  });

  it("rejects invalid category", () => {
    expect(() => CategorySchema.parse("invalid")).toThrow();
  });
});

describe("TimeRangeSchema", () => {
  it("accepts valid time ranges", () => {
    expect(TimeRangeSchema.parse("day")).toBe("day");
    expect(TimeRangeSchema.parse("week")).toBe("week");
    expect(TimeRangeSchema.parse("month")).toBe("month");
    expect(TimeRangeSchema.parse("year")).toBe("year");
  });

  it("accepts undefined (optional)", () => {
    expect(TimeRangeSchema.parse(undefined)).toBeUndefined();
  });

  it("rejects invalid time range", () => {
    expect(() => TimeRangeSchema.parse("decade")).toThrow();
  });
});
