import { describe, expect, it } from "vitest";
import { describeCbrImport, rateSource } from "./rates";

const fmt = (d: string) => d.split("-").reverse().join(".");

describe("итог загрузки курсов ЦБ", () => {
  it("загружены, оставлены вручную, не публикуются", () => {
    const r = describeCbrImport({ date: "2026-10-18", updated: ["EUR", "USD"], keptManual: ["CNY"], missing: ["AED"] }, fmt);
    expect(r.ok).toBe(true);
    expect(r.text).toBe(
      "Курсы ЦБ РФ на 18.10.2026 загружены: EUR, USD. Курс, введённый вручную на эту дату, оставлен: CNY. ЦБ РФ не публикует курс: AED. Его можно ввести вручную.",
    );
  });
  it("нечего загружать", () => {
    expect(describeCbrImport({ date: "2026-10-18", updated: [], keptManual: [], missing: [] }, fmt)).toEqual({
      text: "Счетов в других валютах нет: загружать нечего.",
      ok: true,
    });
  });
  it("ни одного курса нет у ЦБ — предупреждение", () => {
    expect(describeCbrImport({ date: "2026-10-18", updated: [], keptManual: [], missing: ["XYZ"] }, fmt).ok).toBe(false);
  });
  it("источник курса", () => {
    expect(rateSource("cbr")).toBe("ЦБ РФ");
    expect(rateSource("manual")).toBe("вручную");
  });
});
