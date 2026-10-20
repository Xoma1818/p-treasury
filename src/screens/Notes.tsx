import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { NoteForm, NoteList } from "../components/Notes";
import { api, type Note } from "../lib/api";

/** Раздел «Заметки»: все заметки с поиском по словам. */
export function Notes() {
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [edit, setEdit] = useState<Note | "new" | null>(null);
  // Ищем после короткой паузы в наборе.
  useEffect(() => {
    const t = setTimeout(() => setQuery(text), 200);
    return () => clearTimeout(t);
  }, [text]);
  const notes = useQuery({ queryKey: ["notes", "search", query], queryFn: () => api.listNotes({ query }) });
  return (
    <section className="screen">
      <div className="screen-head">
        <h1>Заметки</h1>
        <button className="btn primary" onClick={() => setEdit("new")}>
          + Заметка
        </button>
      </div>
      <div className="card">
        <input name="noteSearch" className="search" placeholder="Поиск по заметкам" value={text} onChange={(e) => setText(e.target.value)} />
        {notes.data && notes.data.length === 0 && <p className="muted">{query.trim() ? "Ничего не нашлось." : "Заметок пока нет. Их можно добавить и в карточке операции, долга или дня календаря."}</p>}
        {notes.data && <NoteList notes={notes.data} onOpen={setEdit} />}
      </div>
      {edit && <NoteForm note={edit === "new" ? undefined : edit} onClose={() => setEdit(null)} />}
    </section>
  );
}
