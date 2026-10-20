import { describe, expect, it } from "vitest";
import { formatDate, monthBounds, monthTitle } from "./dates";

describe("dates", () => {
  it("границы месяца с учётом високосного года", () => {
    expect(monthBounds("2026-10-20")).toEqual(["2026-10-01", "2026-10-31"]);
    expect(monthBounds("2028-02-10")).toEqual(["2028-02-01", "2028-02-29"]);
    expect(monthBounds("2026-02-10")).toEqual(["2026-02-01", "2026-02-28"]);
  });
  it("формат", () => {
    expect(formatDate("2026-10-05")).toBe("05.10.2026");
    expect(monthTitle("2026-10-05")).toBe("Октябрь 2026");
  });
});
