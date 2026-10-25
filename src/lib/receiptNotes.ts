import type { Note, NoteFilter } from "./api";

/** Заметки принадлежат чеку целиком, даже когда список открыт с фильтром одной его части. */
export async function loadReceiptNotes(
  loadNotes: (filter: NoteFilter) => Promise<Note[]>,
  filter: NoteFilter,
  transactionIds: string[],
): Promise<Note[]> {
  const pages = await Promise.all([...new Set(transactionIds)].map((transactionId) => loadNotes({ ...filter, transactionId })));
  const unique = new Map(pages.flat().map((note) => [note.id, note]));
  return [...unique.values()].sort((a, b) =>
    (b.date ?? b.createdAt.slice(0, 10)).localeCompare(a.date ?? a.createdAt.slice(0, 10)) || b.createdAt.localeCompare(a.createdAt),
  );
}
