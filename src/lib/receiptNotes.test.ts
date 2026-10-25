import { describe, expect, it } from "vitest";
import type { Note, NoteFilter } from "./api";
import { loadReceiptNotes } from "./receiptNotes";

describe("заметки разбитого чека", () => {
  it("собирает заметки всех частей при фильтре другой части, без повторов", async () => {
    const earlier = { id: "warranty", transactionId: "part-z", body: "Гарантия на покупку", date: null, createdAt: "2026-10-01T10:00:00Z" } as Note;
    const later = { id: "delivery", transactionId: "part-a", body: "Срок доставки", date: null, createdAt: "2026-10-02T10:00:00Z" } as Note;
    const all = [earlier, later];
    const loadNotes = async (f: NoteFilter) => all.filter((n) => n.transactionId === f.transactionId);
    const notes = await loadReceiptNotes(loadNotes, { transactionId: "part-a" }, ["part-a", "part-z", "part-z"]);
    expect(notes.map((n) => n.body)).toEqual(["Срок доставки", "Гарантия на покупку"]);
    expect(new Set(notes.map((n) => n.id)).size).toBe(2);
  });

  it("ошибка чтения одной части не превращается в пустой список её заметок", async () => {
    await expect(loadReceiptNotes(async (f) => {
      if (f.transactionId === "part-z") throw new Error("чтение недоступно");
      return [];
    }, {}, ["part-a", "part-z"])).rejects.toThrow("чтение недоступно");
  });
});
