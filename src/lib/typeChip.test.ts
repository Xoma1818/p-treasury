import { describe, expect, it } from "vitest";
import { typeChipLabel } from "./typeChip";

describe("typeChipLabel", () => {
  it("один тип", () => {
    expect(typeChipLabel(["income"])).toBe("Доход");
    expect(typeChipLabel(["expense"], true)).toBe("Расход с возвратами");
  });
  it("«Сальдо» — доходы и расходы, а не только «Доход»", () => {
    expect(typeChipLabel(["income", "expense"], true)).toBe("Доход и расход с возвратами");
    expect(typeChipLabel(["income", "expense"])).toBe("Доход и расход");
  });
});
