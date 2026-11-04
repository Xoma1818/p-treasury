import { describe, expect, it } from "vitest";
import { statementOf } from "./fileDrop";

describe("statementOf", () => {
  it("находит выписку среди брошенных файлов", () => {
    expect(statementOf(["C:\\Users\\otto\\Desktop\\фото.png", "C:\\Users\\otto\\Desktop\\Выписка.XLSX"])).toBe("C:\\Users\\otto\\Desktop\\Выписка.XLSX");
    expect(statementOf(["/home/a/op.csv"])).toBe("/home/a/op.csv");
    expect(statementOf(["/home/a/sber.pdf"])).toBe("/home/a/sber.pdf");
    expect(statementOf(["/home/a/old.xls"])).toBe("/home/a/old.xls");
  });
  it("не принимает чужие файлы и папки", () => {
    expect(statementOf(["C:\\a\\notes.docx", "C:\\a\\Папка"])).toBeNull();
    expect(statementOf([])).toBeNull();
  });
});
