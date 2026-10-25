import { useQuery } from "@tanstack/react-query";
import { type Ref, useState } from "react";
import { api, type Note, type NoteFilter, type NoteInput } from "../lib/api";
import { formatDate } from "../lib/dates";
import { loadReceiptNotes } from "../lib/receiptNotes";
import { useAction } from "../lib/useAction";
import { Field } from "./Fields";
import { ErrorText, Modal } from "./Modal";

/** Привязка заметки: одна из операции, счёта, долга или месяца бюджета. */
export type NoteLink = Pick<NoteInput, "transactionId" | "accountId" | "debtId" | "budgetId">;

export function NoteForm({ note, initial, onClose }: { note?: Note; initial?: Partial<NoteInput>; onClose: () => void }) {
  const [body, setBody] = useState(note?.body ?? "");
  const [date, setDate] = useState(note?.date ?? initial?.date ?? "");
  const link: NoteLink = note
    ? { transactionId: note.transactionId, accountId: note.accountId, debtId: note.debtId, budgetId: note.budgetId }
    : { transactionId: initial?.transactionId, accountId: initial?.accountId, debtId: initial?.debtId, budgetId: initial?.budgetId };
  const save = useAction(
    (input: NoteInput) => (note ? api.updateNote(note.id, input) : api.createNote(input)),
    onClose,
    { celebrate: true },
  );
  const remove = useAction(() => api.deleteNote(note!.id), onClose);
  return (
    <Modal title={note ? "Заметка" : "Новая заметка"} onClose={onClose}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          save.run({ body, date: date || null, ...link });
        }}
      >
        <Field label="Текст">{(id) => <textarea id={id} name="noteBody" rows={4} value={body} onChange={(e) => setBody(e.target.value)} autoFocus />}</Field>
        <Field label="Дата (необязательно)">{(id) => <input id={id} name="noteDate" type="date" value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
        {note?.link && <p className="hint">Привязана: {note.link}</p>}
        <ErrorText error={save.error ?? remove.error} />
        <div className="actions">
          {note && (
            <button type="button" className="btn danger" onClick={() => remove.run()}>
              Удалить
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Отмена
          </button>
          <button type="submit" className="btn primary" aria-busy={save.busy} data-done={save.done || undefined} disabled={save.busy}>
            Сохранить
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function NoteList({ notes, onOpen, showLink = true }: { notes: Note[]; onOpen: (n: Note) => void; showLink?: boolean }) {
  return (
    <ul className="note-list" data-testid="notes">
      {notes.map((n) => (
        <li key={n.id} className="clickable" onClick={() => onOpen(n)} data-testid="note">
          <div className="note-body">{n.body}</div>
          <div className="sub">
            {n.date && formatDate(n.date)}
            {showLink && n.link && <span> · {n.link}</span>}
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Заметки в карточке операции, долга или дня: список, удаление и добавление на месте (без второго окна). */
export function NotesBlock({
  filter,
  initial,
  title = "Заметки",
  inputRef,
  transactionIds,
  disabled = false,
}: {
  filter: NoteFilter;
  initial: Partial<NoteInput>;
  title?: string;
  inputRef?: Ref<HTMLInputElement>;
  /** Все части редактируемого чека; обычная карточка использует только filter. */
  transactionIds?: string[];
  disabled?: boolean;
}) {
  const partIds = transactionIds ? [...new Set(transactionIds)].sort() : undefined;
  const notes = useQuery({
    queryKey: partIds ? ["notes", filter, partIds] : ["notes", filter],
    queryFn: () => partIds ? loadReceiptNotes(api.listNotes, filter, partIds) : api.listNotes(filter),
  });
  const [body, setBody] = useState("");
  const add = useAction(
    () => api.createNote({ ...initial, body, date: initial.date ?? null }),
    () => setBody(""),
  );
  const remove = useAction((id: string) => api.deleteNote(id));
  return (
    <div className="notes-block" data-testid="notes-block">
      <h3>{title}</h3>
      <ul className="note-list" data-testid="notes">
        {notes.data?.map((n) => (
          <li key={n.id} data-testid="note">
            <div className="note-body">{n.body}</div>
            <button type="button" className="link danger" title="Удалить заметку" disabled={disabled} onClick={() => remove.run(n.id)}>
              ×
            </button>
          </li>
        ))}
      </ul>
      <div className="note-add">
        <input
          ref={inputRef}
          name="newNote"
          placeholder="Новая заметка"
          value={body}
          disabled={disabled}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.stopPropagation();
              if (!disabled && body.trim()) add.run();
            }
          }}
        />
        <button type="button" className="btn small" disabled={disabled || !body.trim() || add.busy} onClick={() => add.run()}>
          Добавить
        </button>
      </div>
      <ErrorText error={add.error ?? remove.error ?? (notes.error ? String(notes.error) : null)} />
    </div>
  );
}
