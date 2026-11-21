import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, type Rule, type RuleHistorySelection } from "../lib/api";
import { formatDate } from "../lib/dates";
import { useCategories } from "../lib/queries";
import { useAction } from "../lib/useAction";
import { CategorySelect } from "./Fields";
import { ErrorText, Modal } from "./Modal";
import { Hint } from "./Hint";
import { Money } from "./Money";

/**
 * Правила автокатегорий: «если в получателе есть „пятерочка“ — категория Продукты».
 * Работают в быстром вводе, в тексте SMS и при импорте CSV без категории.
 */
export function RulesCard() {
  const rules = useQuery({ queryKey: ["rules"], queryFn: api.listRules }).data ?? [];
  const categories = useCategories().data ?? [];
  const [pattern, setPattern] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [payee, setPayee] = useState("");
  const [history, setHistory] = useState<Rule | null>(null);
  const create = useAction(
    () => api.createRule({ pattern, categoryId, payee: payee.trim() || null }),
    () => {
      setPattern("");
      setPayee("");
    },
  );
  const remove = useAction(api.deleteRule);

  return (
    <div className="card" data-testid="rules">
      <h2>
        Правила автокатегорий
        <Hint of="rules" />
      </h2>
      <p className="muted">
        Если в названии магазина есть этот текст, категория подставится сама: в быстром вводе, в SMS банка и при загрузке CSV. Правило
        можно запомнить и прямо из быстрого ввода.
      </p>
      {rules.length > 0 && (
        <table className="table rules-table">
          <thead>
            <tr>
              <th>Текст в названии</th>
              <th>Категория</th>
              <th>Получатель</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id} data-testid="rule-row">
                <td>{r.pattern}</td>
                <td>{r.categoryName}</td>
                <td className="muted">{r.payee ?? "как в тексте"}</td>
                <td>
                  <span className="row-actions">
                    <button type="button" className="link" onClick={() => setHistory(r)} aria-label={`Прошлые операции для правила «${r.pattern}»`} data-testid="rule-history-open">
                      Прошлые операции
                    </button>
                    <button type="button" className="link danger" onClick={() => remove.run(r.id)} aria-label={`Удалить правило «${r.pattern}»`}>
                      Удалить
                    </button>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <form
        className="rules-form"
        onSubmit={(e) => {
          e.preventDefault();
          create.run();
        }}
      >
        <input name="rulePattern" placeholder="Текст, например «пятерочка»" value={pattern} onChange={(e) => setPattern(e.target.value)} />
        <CategorySelect name="ruleCategory" categories={categories} value={categoryId} onChange={setCategoryId} />
        <input name="rulePayee" placeholder="Получатель (необязательно)" value={payee} onChange={(e) => setPayee(e.target.value)} />
        <button className="btn" type="submit" disabled={!pattern.trim() || !categoryId || create.busy}>
          Добавить правило
        </button>
      </form>
      <ErrorText error={create.error ?? remove.error} />
      {history && <RuleHistoryDialog key={history.id} rule={history} onClose={() => setHistory(null)} />}
    </div>
  );
}

function RuleHistoryDialog({ rule, onClose }: { rule: Rule; onClose: () => void }) {
  const [selected, setSelected] = useState<Map<string, string>>(() => new Map());
  const [applied, setApplied] = useState<number | null>(null);
  const preview = useQuery({
    queryKey: ["ruleHistory", rule.id],
    queryFn: () => api.ruleHistoryPreview(rule.id),
    refetchOnWindowFocus: false,
    retry: false,
  });
  const apply = useAction(
    (selection: RuleHistorySelection[]) => api.applyRuleHistory(rule.id, selection),
    (count) => {
      setSelected(new Map());
      setApplied(count);
    },
  );
  const rows = preview.data?.rows ?? [];
  const selection = rows.filter((r) => selected.get(r.id) === r.revision).map(({ id, revision }) => ({ id, revision }));
  const disabled = apply.busy || preview.isFetching;
  const reload = () => {
    apply.setError(null);
    setApplied(null);
    setSelected(new Map());
    void preview.refetch();
  };
  return (
    <Modal title={`Прошлые операции · ${rule.pattern}`} onClose={onClose} wide dismissDisabled={apply.busy}>
      <p className="muted">Отметьте проведённые операции, в которых нужно изменить категорию или получателя.</p>
      {preview.isFetching && <p role="status">Проверяем прошлые операции…</p>}
      {applied !== null && <p role="status">Изменено операций: {applied}. Можно отменить через Ctrl+Z.</p>}
      {preview.isSuccess && rows.length === 0 && <p className="muted">Подходящих операций для изменения нет.</p>}
      {preview.data?.hasMore && <p className="muted">Показаны 100 последних подходящих операций.</p>}
      {rows.length > 0 && (
        <div className="import-table" role="region" aria-label="Предпросмотр правила" tabIndex={0}>
          <table className="table" data-testid="rule-history-preview">
            <thead>
              <tr><th>Выбрать</th><th>Операция</th><th>Было</th><th>Станет</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Выбрать ${r.oldPayee}, ${formatDate(r.date)}, ${r.accountName}`}
                      data-testid="rule-history-select"
                      checked={selected.get(r.id) === r.revision}
                      disabled={disabled}
                      onChange={(e) => {
                        const next = new Map(selected);
                        if (e.target.checked) next.set(r.id, r.revision);
                        else next.delete(r.id);
                        setSelected(next);
                      }}
                    />
                  </td>
                  <td>
                    {formatDate(r.date)} · <Money amount={r.amount} symbol={r.currencySymbol} minorUnits={r.minorUnits} />
                    <div className="muted">{r.accountName}</div>
                  </td>
                  <td>{r.oldCategory}<div className="muted">{r.oldPayee}</div></td>
                  <td>{r.newCategory}<div className="muted">{r.newPayee}</div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ErrorText error={apply.error ?? (preview.error ? String(preview.error) : null)} />
      <div className="actions">
        {(apply.error || preview.isError) && <button type="button" className="link" onClick={reload} disabled={disabled}>Обновить предпросмотр</button>}
        <span className="spacer" />
        <button type="button" className="btn" onClick={onClose} disabled={apply.busy}>Закрыть</button>
        <button type="button" className="btn primary" data-testid="rule-history-apply" disabled={disabled || selection.length === 0} onClick={() => apply.run(selection)}>
          Применить выбранные ({selection.length})
        </button>
      </div>
    </Modal>
  );
}

/** Р24: правила прямо в карточке категории — «ключевые слова → сюда». */
export function CategoryRules({ categoryId }: { categoryId: string }) {
  const rules = (useQuery({ queryKey: ["rules"], queryFn: api.listRules }).data ?? []).filter((r) => r.categoryId === categoryId);
  const [pattern, setPattern] = useState("");
  const create = useAction(() => api.createRule({ pattern, categoryId, payee: null }), () => setPattern(""));
  const remove = useAction(api.deleteRule);
  const add = () => pattern.trim() && create.run();
  return (
    <div className="field" role="group" aria-label="Ключевые слова" data-testid="category-rules">
      <span className="label">
        Ключевые слова → сюда <Hint of="rules" />
      </span>
      <div className="rule-chips">
        {rules.map((r) => (
          <span key={r.id} className="rule-chip" data-testid="category-rule">
            {r.pattern}
            <button type="button" className="rule-chip-x" aria-label={`Убрать «${r.pattern}»`} onClick={() => remove.run(r.id)}>
              ×
            </button>
          </span>
        ))}
        {rules.length === 0 && <span className="muted small">Пока нет. Операции с этим текстом в получателе сами попадут в категорию.</span>}
      </div>
      <div className="row">
        <input
          name="categoryRule"
          placeholder="например «пятерочка»"
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          onKeyDown={(e) => {
            // Enter добавляет слово, а не сохраняет всю форму.
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <button type="button" className="btn" disabled={!pattern.trim() || create.busy} onClick={add}>
          Добавить
        </button>
      </div>
      <ErrorText error={create.error ?? remove.error} />
    </div>
  );
}
