import { describe, it, expect } from "vitest";
import { recencyScore } from "../src/reranker.js";

describe("recencyScore", () => {
  it("returns 1.0 for today", () => {
    const today = new Date().toISOString();
    expect(recencyScore(today)).toBeCloseTo(1.0, 2);
  });

  it("returns ~0.93 for 1 week ago", () => {
    const d = new Date(Date.now() - 7 * 86_400_000).toISOString();
    expect(recencyScore(d)).toBeCloseTo(Math.exp(-7 / 90), 3);
  });

  it("returns ~0.37 for 90 days ago (1/e decay point)", () => {
    const d = new Date(Date.now() - 90 * 86_400_000).toISOString();
    expect(recencyScore(d)).toBeCloseTo(Math.exp(-1), 2);
  });

  it("returns ~0.06 for 1 year ago", () => {
    const d = new Date(Date.now() - 365 * 86_400_000).toISOString();
    expect(recencyScore(d)).toBeCloseTo(Math.exp(-365 / 90), 3);
  });

  it("returns 0 for undefined", () => {
    expect(recencyScore(undefined)).toBe(0);
  });

  it("returns 0 for empty string", () => {
    expect(recencyScore("")).toBe(0);
  });

  it("returns 0 for unparseable date", () => {
    expect(recencyScore("not-a-date")).toBe(0);
  });

  it("returns 0 for future date", () => {
    const future = new Date(Date.now() + 7 * 86_400_000).toISOString();
    expect(recencyScore(future)).toBe(0);
  });

  it("scores decrease monotonically with age", () => {
    const week = recencyScore(new Date(Date.now() - 7 * 86_400_000).toISOString());
    const month = recencyScore(new Date(Date.now() - 30 * 86_400_000).toISOString());
    const year = recencyScore(new Date(Date.now() - 365 * 86_400_000).toISOString());
    expect(week).toBeGreaterThan(month);
    expect(month).toBeGreaterThan(year);
    expect(year).toBeGreaterThan(0);
  });
});
