import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, type ViewKind } from "../lib/api";
import { useAction } from "../lib/useAction";
import { ErrorText } from "./Modal";

/** Параметры вида; повреждённый вид просто не применяется (ядро проверяет JSON при сохранении). */
export function parseView<P>(params: string): P | null {
  try {
    return JSON.parse(params) as P;
  } catch {
    return null;
  }
}

/**
 * Сохранённые виды над фильтрами: нажатие на ярлык применяет вид,
 * «☆ Сохранить вид» запоминает текущие настройки под именем.
 */
export function SavedViews<P>({ kind, current, onApply }: { kind: ViewKind; current: P; onApply: (params: P) => void }) {
  const views = useQuery({ queryKey: ["views", kind], queryFn: () => api.listViews(kind) }).data ?? [];
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const create = useAction((n: string) => api.createView(n, kind, current), () => {
    setNaming(false);
    setName("");
  });
  const remove = useAction(api.deleteView);
  const apply = (params: string) => {
    const p = parseView<P>(params);
    if (p) onApply(p);
  };

  return (
    <div className="saved-views" data-testid={`views-${kind}`}>
      {views.map((v) => (
        <span key={v.id} className="view-chip">
          <button className="view-apply" onClick={() => apply(v.params)} title="Открыть сохранённый вид">
            {v.name}
          </button>
          <button className="view-del" aria-label={`Удалить вид «${v.name}»`} onClick={() => remove.run(v.id)}>
            ×
          </button>
        </span>
      ))}
      {naming ? (
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            create.run(name);
          }}
        >
          <input name="viewName" autoFocus placeholder="Название, например «Кафе за год»" value={name} onChange={(e) => setName(e.target.value)} />
          <button className="btn small primary" type="submit" disabled={create.busy}>
            Сохранить
          </button>
          <button className="btn small" type="button" onClick={() => setNaming(false)}>
            Отмена
          </button>
        </form>
      ) : (
        <button className="link" onClick={() => setNaming(true)} title="Запомнить текущие фильтры под именем">
          ☆ Сохранить вид
        </button>
      )}
      <ErrorText error={create.error ?? remove.error} />
    </div>
  );
}
