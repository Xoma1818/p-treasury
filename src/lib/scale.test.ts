import { describe, expect, it } from "vitest";
import { autoFactor } from "./scale";

describe("масштаб «Авто»", () => {
  it("в обычном окне — 100 %", () => {
    expect(autoFactor(1280, 800)).toBe(1);
    expect(autoFactor(1440, 860)).toBe(1);
  });
  it("на весь экран Full HD — крупнее, по меньшей стороне", () => {
    expect(autoFactor(1920, 1080)).toBe(1.25);
    expect(autoFactor(1920, 900)).toBe(1.0);
  });
  it("на очень большом экране не больше 130 %", () => {
    expect(autoFactor(3840, 2160)).toBe(1.3);
  });
});
