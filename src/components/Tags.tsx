// Теги (Г6): управление в «Категориях» и отчёт «По тегу» в «Отчётах».
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, type Period, type Tag } from "../lib/api";
import { monthTitle } from "../lib/dates";
import { plural } from "../lib/receipt";
import { useUi } from "../lib/store";
import { useAction } from "../lib/useAction";
import { Hint } from "./Hint";
import { ErrorText } from "./Modal";
import { BaseMoney as M } from "./Money";

type Edit = { kind: "rename" | "merge" | "delete"; tag: Tag } | null;

/** Список тегов в «Категориях»: переименовать, объединить, удалить. */
export function TagsCard() {
  const tags = useQuery({ queryKey: ["tags"], queryFn: api.listTags }).data ?? [];
  const showTransactions = useUi((s) => s.showTransactions);
  const [edit, setEdit] = useState<Edit>(null);
  const [value, setValue] = useState("");
  const done = () => setEdit(null);
  const rename = useAction((id: string, name: string) => api.renameTag(id, name), done);
  const merge = useAction((from: string, into: string) => api.mergeTags(from, into), done);
  const remove = useAction((id: string) => api.deleteTag(id), done);
  const busy = rename.busy || merge.busy || remove.busy;
  const start = (kind: "rename" | "merge" | "delete", tag: Tag) => {
    setEdit({ kind, tag });
    setValue(kind === "rename" ? tag.name : "");
  };

  return (
    <div className="card" data-testid="tags-card">
      <h2>
        Теги
        <Hint of="tags" />
      </h2>
      {tags.length === 0 && (
        <p className="muted">
          Тегов пока нет. Добавьте тег в форме операции или напишите в быстром вводе «леруа 4500 #ремонт».
        </p>
      )}
      {tags.length > 0 && (
        <ul className="tree tag-list">
          {tags.map((t) => {
            const mine = edit?.tag.id === t.id ? edit : null;
            return (
              <li key={t.id} className="parent" data-testid="tag-row" data-tag={t.name}>
                <span className="name">
                  <span className="tag-chip">#{t.name}</span>
                </span>
                {t.count > 0 && (
                  <button className="link count" title="Операции с тегом" onClick={() => showTransactions({ tagId: t.id })}>
                    {t.count}
                  </button>
                )}
                {!mine && (
                  <span className="row-actions">
                    <button className="link" onClick={() => start("rename", t)}>
                      Переименовать
                    </button>
                    {tags.length > 1 && (
                      <button className="link" onClick={() => start("merge", t)}>
                        Объединить
                      </button>
                    )}
                    <button className="link danger" onClick={() => start("delete", t)}>
                      Удалить
                    </button>
                  </span>
                )}
                {mine?.kind === "rename" && (
                  <form className="inline-form tag-edit" onSubmit={(e) => (e.preventDefault(), value.trim() && rename.run(t.id, value.trim()))}>
                    <input name="tagName" aria-label="Новое название тега" value={value} autoFocus onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), done())} />
                    <button className="btn small primary" disabled={!value.trim() || busy}>
                      Сохранить
                    </button>
                    <button type="button" className="btn small" onClick={done}>
                      Отмена
                    </button>
                  </form>
                )}
                {mine?.kind === "merge" && (
                  <form className="inline-form tag-edit" onSubmit={(e) => (e.preventDefault(), value && merge.run(t.id, value))}>
                    <span className="muted">Перенести в</span>
                    <select name="mergeInto" aria-label="Объединить с тегом" value={value} autoFocus onChange={(e) => setValue(e.target.value)}>
                      <option value="">Выберите тег</option>
                      {tags
                        .filter((x) => x.id !== t.id)
                        .map((x) => (
                          <option key={x.id} value={x.id}>
                            #{x.name}
                          </option>
                        ))}
                    </select>
                    <button className="btn small primary" disabled={!value || busy}>
                      Объединить
                    </button>
                    <button type="button" className="btn small" onClick={done}>
                      Отмена
                    </button>
                  </form>
                )}
                {mine?.kind === "delete" && (
                  <span className="inline-form tag-edit">
                    <span className="sel-confirm">
                      Удалить тег{t.count > 0 ? ` у ${t.count} ${plural(t.count, "операции", "операций", "операций")}` : ""}? Сами операции останутся.
                    </span>
                    <button className="btn small danger" autoFocus disabled={busy} onClick={() => remove.run(t.id)}>
                      Да, удалить
                    </button>
                    <button className="btn small" onClick={done}>
                      Отмена
                    </button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <ErrorText error={rename.error ?? merge.error ?? remove.error} />
    </div>
  );
}

/** Отчёт «По тегу» за период: итог, категории и месяцы. */
export function TagReport({ period }: { period: Period }) {
  const tags = useQuery({ queryKey: ["tags"], queryFn: api.listTags }).data;
  const [tagId, setTagId] = useState("");
  useEffect(() => {
    if (!tagId && tags?.length) setTagId([...tags].sort((a, b) => b.count - a.count)[0].id);
  }, [tags, tagId]);
  const report = useQuery({
    queryKey: ["reportByTag", tagId, period.start, period.end],
    queryFn: () => api.reportByTag(tagId, period.start, period.end),
    enabled: !!tagId,
  });
  const showTransactions = useUi((s) => s.showTransactions);
  const r = report.data;
  const max = Math.max(1, ...(r?.byCategory.map((c) => c.amount) ?? []));

  if (tags && tags.length === 0)
    return (
      <div className="card">
        <h2>
          По тегу
          <Hint of="reports.tag" />
        </h2>
        <p className="muted">Тегов пока нет. Добавьте тег в форме операции, например «ремонт», и здесь появится его отчёт.</p>
      </div>
    );

  return (
    <div className="card" data-testid="tag-report">
      <div className="screen-head">
        <h2>
          По тегу
          <Hint of="reports.tag" />
        </h2>
        <select name="reportTag" aria-label="Тег" value={tagId} onChange={(e) => setTagId(e.target.value)}>
          {tags?.map((t) => (
            <option key={t.id} value={t.id}>
              #{t.name} ({t.count})
            </option>
          ))}
        </select>
      </div>
      {report.error && <p className="error">{String(report.error)}</p>}
      {r && (
        <>
          <div className="tiles three">
            <div className="card tile clickable" data-testid="tag-expense" title="Показать операции" onClick={() => showTransactions({ tagId, dateFrom: r.from, dateTo: r.to })}>
              <div className="tile-label">Расходы</div>
              <div className="tile-value">
                <M amount={r.expense} />
              </div>
            </div>
            <div className="card tile">
              <div className="tile-label">Доходы</div>
              <div className="tile-value plus">
                <M amount={r.income} />
              </div>
            </div>
            <div className="card tile">
              <div className="tile-label">Операций</div>
              <div className="tile-value">{r.count}</div>
            </div>
          </div>
          {r.count === 0 && <p className="muted">За этот период операций с тегом нет. Выберите другой период сверху.</p>}
          {r.byCategory.length > 0 && (
            <>
              <h3 className="sub-head">По категориям</h3>
              <ul className="cat-report">
                {r.byCategory.map((c) => (
                  <li key={c.categoryId} className="cat-row" data-testid="tag-cat">
                    <span className="cat-name">
                      <span className="icon-gap" />
                      <button className="link cat-link" title="Показать операции" onClick={() => showTransactions({ tagId, categoryId: c.categoryId, dateFrom: r.from, dateTo: r.to })}>
                        {c.name}
                      </button>
                    </span>
                    <span className="cat-bar">
                      <span className="bar-fill" style={{ width: `${Math.max((c.amount / max) * 100, 0.5)}%` }} />
                    </span>
                    <span className="percent">{r.expense ? Math.round((c.amount / r.expense) * 100) : 0} %</span>
                    <span className="num">
                      <M amount={c.amount} />
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {r.byMonth.length > 0 && (
            <>
              <h3 className="sub-head">По месяцам</h3>
              <table className="table months-table">
                <thead>
                  <tr>
                    <th>Месяц</th>
                    <th className="num">Расходы</th>
                    <th className="num">Доходы</th>
                  </tr>
                </thead>
                <tbody>
                  {r.byMonth.map((m) => (
                    <tr key={m.month}>
                      <td className="main">{monthTitle(m.month)}</td>
                      <td className="num">
                        <M amount={m.expense} />
                      </td>
                      <td className="num plus">
                        <M amount={m.income} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          {r.missingRates.length > 0 && <p className="hint warn">Нет курса для {r.missingRates.join(", ")}: такие операции не вошли.</p>}
        </>
      )}
    </div>
  );
}
