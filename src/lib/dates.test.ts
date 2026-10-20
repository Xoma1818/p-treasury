import { describe, expect, it } from "vitest";
import { addDays, formatDate, setDateFormat, formatDateTime, isoDateTime, monthBounds, monthGenitive, monthTitle, shiftMonth, weekStart } from "./dates";

describe("dates", () => {
  it("границы месяца с учётом високосного года", () => {
    expect(monthBounds("2026-10-20")).toEqual(["2026-10-01", "2026-10-31"]);
    expect(monthBounds("2028-02-10")).toEqual(["2028-02-01", "2028-02-29"]);
    expect(monthBounds("2026-02-10")).toEqual(["2026-02-01", "2026-02-28"]);
  });
  it("формат", () => {
    expect(formatDate("2026-10-05")).toBe("05.10.2026");
    expect(monthTitle("2026-10-05")).toBe("Октябрь 2026");
    expect(monthTitle("2026-11")).toBe("Ноябрь 2026");
    expect(monthGenitive("2026-10")).toBe("октября");
  });
  it("сдвиг месяца через границу года", () => {
    expect(shiftMonth("2026-11", 1)).toBe("2026-12");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2027-01", -1)).toBe("2026-12");
    expect(shiftMonth("2026-03", -14)).toBe("2025-01");
  });
  it("дни и недели: через границы месяца и года, неделя с понедельника", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2027-01-01", -1)).toBe("2026-12-31");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(weekStart("2026-10-20")).toBe("2026-10-19"); // вторник → понедельник
    expect(weekStart("2026-10-25")).toBe("2026-10-19"); // воскресенье
    expect(weekStart("2026-11-01")).toBe("2026-10-26");
    expect(weekStart("2026-10-19")).toBe("2026-10-19");
  });
  it("дата и время напоминаний", () => {
    expect(isoDateTime(new Date(2026, 9, 5, 9, 7))).toBe("2026-10-05T09:07");
    expect(formatDateTime("2026-11-10T09:00")).toBe("10.11.2026 9:00");
    expect(formatDateTime("2026-11-10T18:30")).toBe("10.11.2026 18:30");
  });
  it("формат даты из настроек", () => {
    setDateFormat("YYYY-MM-DD");
    expect(formatDate("2026-10-05")).toBe("2026-10-05");
    setDateFormat("что-то другое");
    expect(formatDate("2026-10-05")).toBe("05.10.2026");
  });
});
