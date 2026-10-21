import { useState } from "react";
import { CategorySelect, Field } from "../components/Fields";
import { ErrorText, Modal } from "../components/Modal";
import { api, type Category, type CategoryKind } from "../lib/api";
import { useCategories } from "../lib/queries";
import { useUi } from "../lib/store";
import { useAction } from "../lib/useAction";
import { ScreenTitle } from "../components/SectionIcon";
import { RulesCard } from "../components/Rules";

type Edit = { mode: "new"; kind: CategoryKind; parentId: string | null } | { mode: "edit"; category: Category };

export function Categories() {
  const [showArchived, setShowArchived] = useState(false);
  const all = useCategories(true).data ?? [];
  const [edit, setEdit] = useState<Edit | null>(null);
  const [deleting, setDeleting] = useState<Category | null>(null);
  const archive = useAction(api.archiveCategory);
  const showTransactions = useUi((s) => s.showTransactions);
  const visible = all.filter((c) => showArchived || !c.archived);

  const column = (kind: CategoryKind, title: string) => (
    <div className="card" data-testid={`categories-${kind}`}>
      <div className="screen-head">
        <h2>{title}</h2>
        <button className="btn small" onClick={() => setEdit({ mode: "new", kind, parentId: null })}>
          + Категория
        </button>
      </div>
      <ul className="tree">
        {visible
          .filter((c) => c.kind === kind)
          .map((c) => (
            <li key={c.id} className={(c.parentId ? "child" : "parent") + (c.archived ? " archived" : "")}>
              <span className="name">{c.name}</span>
              {c.transactionCount > 0 && (
                <button className="link count" onClick={() => showTransactions({ categoryId: c.id })} title="Операции категории">
                  {c.transactionCount}
                </button>
              )}
              <span className="row-actions">
                {!c.parentId && !c.archived && (
                  <button className="link" onClick={() => setEdit({ mode: "new", kind, parentId: c.id })}>
                    + подкатегория
                  </button>
                )}
                <button className="link" onClick={() => setEdit({ mode: "edit", category: c })}>
                  Изменить
                </button>
                <button className="link" onClick={() => archive.run(c.id, !c.archived)}>
                  {c.archived ? "Вернуть" : "В архив"}
                </button>
                <button className="link danger" onClick={() => setDeleting(c)}>
                  Удалить
                </button>
              </span>
            </li>
          ))}
      </ul>
    </div>
  );

  return (
    <section className="screen">
      <ScreenTitle id="categories" />
      <ErrorText error={archive.error} />
      <div className="columns">
        {column("expense", "Расходы")}
        {column("income", "Доходы")}
      </div>
      <label className="check small">
        <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
        Показать архивные
      </label>
      <RulesCard />
      {edit && <CategoryForm edit={edit} all={all} onClose={() => setEdit(null)} />}
      {deleting && <DeleteForm category={deleting} all={all} onClose={() => setDeleting(null)} />}
    </section>
  );
}

function CategoryForm({ edit, all, onClose }: { edit: Edit; all: Category[]; onClose: () => void }) {
  const current = edit.mode === "edit" ? edit.category : null;
  const kind = current?.kind ?? (edit.mode === "new" ? edit.kind : "expense");
  const [name, setName] = useState(current?.name ?? "");
  const [parentId, setParentId] = useState(current?.parentId ?? (edit.mode === "new" ? edit.parentId : null) ?? "");
  const save = useAction(
    () => (current ? api.updateCategory(current.id, name, parentId || null) : api.createCategory({ name, kind, parentId: parentId || null })),
    onClose,
    { celebrate: true },
  );
  const parents = all.filter((c) => c.kind === kind && !c.parentId && !c.archived && c.id !== current?.id);
  return (
    <Modal title={current ? "Категория" : "Новая категория"} onClose={onClose}>
      <form className="form" onSubmit={(e) => (e.preventDefault(), save.run())}>
        <Field label="Название">{(id) => <input id={id} name="name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />}</Field>
        <Field label="Входит в категорию">
          {(id) => (
            <select id={id} name="parent" value={parentId} onChange={(e) => setParentId(e.target.value)}>
              <option value="">— верхний уровень —</option>
              {parents.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <ErrorText error={save.error} />
        <div className="actions">
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

function DeleteForm({ category, all, onClose }: { category: Category; all: Category[]; onClose: () => void }) {
  const children = all.filter((c) => c.parentId === category.id);
  const used = category.transactionCount + children.reduce((s, c) => s + c.transactionCount, 0);
  const [target, setTarget] = useState("");
  const remove = useAction(() => api.deleteCategory(category.id, target || null), onClose);
  return (
    <Modal title={`Удалить «${category.name}»`} onClose={onClose}>
      <form className="form" onSubmit={(e) => (e.preventDefault(), remove.run())}>
        {children.length > 0 && <p>Вместе с категорией удалятся подкатегории: {children.map((c) => c.name).join(", ")}.</p>}
        {used > 0 ? (
          <Field label={`Перенести операции (${used}) в категорию`}>
            {(id) => (
              <CategorySelect
                id={id}
                name="moveTo"
                categories={all.filter((c) => !c.archived)}
                kind={category.kind}
                value={target}
                onChange={setTarget}
                exclude={(c) => c.id === category.id || c.parentId === category.id}
              />
            )}
          </Field>
        ) : (
          <p className="muted">Операций в категории нет.</p>
        )}
        <ErrorText error={remove.error} />
        <div className="actions">
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Отмена
          </button>
          <button type="submit" className="btn danger" aria-busy={remove.busy} data-done={remove.done || undefined} disabled={remove.busy || (used > 0 && !target)}>
            Удалить
          </button>
        </div>
      </form>
    </Modal>
  );
}
