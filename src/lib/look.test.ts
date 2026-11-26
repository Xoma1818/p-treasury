import { describe, expect, it } from "vitest";
import { DEFAULT_LOOK, parseLook } from "./look";

describe("вид: плотность и акцент (Г11)", () => {
  it("по умолчанию обычная плотность и лайм", () => {
    expect(DEFAULT_LOOK).toEqual({ density: "normal", accent: "lime" });
    expect(parseLook(null)).toEqual(DEFAULT_LOOK);
    expect(parseLook("{")).toEqual(DEFAULT_LOOK);
  });
  it("после обновления сохраняет персональный мятный акцент", () => {
    expect(parseLook('{"accent":"mint","density":"roomy"}')).toEqual({ accent: "mint", density: "roomy" });
  });
  it("незнакомые значения заменяются по умолчанию", () => {
    expect(parseLook(JSON.stringify({ density: "compact", accent: "blue" }))).toEqual({ density: "compact", accent: "blue" });
    expect(parseLook(JSON.stringify({ density: "huge", accent: "red" }))).toEqual(DEFAULT_LOOK);
  });
});
