import { useEffect, useState } from "react";
import { AmountInput, amountText, CategorySelect } from "../components/Fields";
import { ErrorText } from "../components/Modal";
import { Money } from "../components/Money";
import { api, type Budget as BudgetData, type BudgetLine, type CategoryKind } from "../lib/api";
import { formatDate, monthGenitive, monthTitle, shiftMonth, today } from "../lib/dates";
import { parseAmount } from "../lib/money";
import { useBudget, useCategories, useCurrencies, useMonthOf } from "../lib/queries";
import { useUi } from "../lib/store";
import { useAction } from "../lib/useAction";

/** Экран «Бюджет»: лимиты по категориям на месяц, план/факт/остаток. */
export function Budget() {
  const current = useMonthOf(today()).data?.month;
  const [picked, setPicked] = useState<string | null>(null);
  const month = picked ?? current;
  const budget = useBudget(month);
  const b = budget.data;

  return (
    <section className="screen wide">
      <div className="screen-head">
        <h1>Бюджет</h1>
        {month && (
          <div className="month-switch">
            <button className="icon-btn" aria-label="Предыдущий месяц" onClick={() => setPicked(shiftMonth(month, -1))}>
              ‹
            </button>
            <div>
              <div className="main" data-testid="budget-month">
                {monthTitle(month)}
              </div>
              {b && (
                <div className="sub">
                  {formatDate(b.period.start)} – {formatDate(b.period.end)}
                </div>
              )}
            </div>
            <button className="icon-btn" aria-label="Следующий месяц" onClick={() => setPicked(shiftMonth(month, 1))}>
              ›
            </button>
            {month !== current && (
              <button className="link" onClick={() => setPicked(null)}>
                Текущий
              </button>
            )}
          </div>
        )}
      </div>
      {budget.error && <p className="error">{String(budget.error)}</p>}
      {b && (b.id ? <BudgetView key={b.id} b={b} /> : <NoBudget month={b.period.month} />)}
    </section>
  );
}

function NoBudget({ month }: { month: string }) {
  const create = useAction((copy: boolean) => api.createBudget(month, copy));
  return (
    <div className="card empty-budget">
      <p>Бюджета на {monthTitle(month).toLowerCase()} пока нет.</p>
      <div className="btn-group">
        <button className="btn primary" onClick={() => create.run(true)} disabled={create.busy}>
          Скопировать из {monthGenitive(shiftMonth(month, -1))}
        </button>
        <button className="btn" onClick={() => create.run(false)} disabled={create.busy}>
          Создать пустой
        </button>
      </div>
      <p className="hint">Копируются лимиты и валюта. Если прошлого бюджета нет, создастся пустой.</p>
      <ErrorText error={create.error} />
    </div>
  );
}

function BudgetView({ b }: { b: BudgetData }) {
  const minor = useCurrencies().data?.find((c) => c.code === b.currencyCode)?.minorUnits ?? 2;
  const sym = b.currencySymbol;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const remove = useAction(() => api.deleteBudget(b.id!));
  const spentInBudget = b.actualExpense - b.unbudgetedExpense;

  return (
    <>
      {b.missingRates.length > 0 && (
        <div className="card hint warn">Нет курса для {b.missingRates.join(", ")}: такие операции не вошли в факт. Курс вводится в Настройках.</div>
      )}
      <div className="tiles">
        <div className="card tile" data-testid="budget-planned">
          <div className="tile-label">Лимиты расходов</div>
          <div className="tile-value">
            <Money amount={b.plannedExpense} symbol={sym} minorUnits={minor} />
          </div>
        </div>
        <div className="card tile" data-testid="budget-spent">
          <div className="tile-label">Потрачено по лимитам</div>
          <div className="tile-value">
            <Money amount={spentInBudget} symbol={sym} minorUnits={minor} />
          </div>
          {b.unbudgetedExpense > 0 && (
            <div className="hint">
              и ещё <Money amount={b.unbudgetedExpense} symbol={sym} minorUnits={minor} /> без лимита
            </div>
          )}
        </div>
        <div className="card tile" data-testid="budget-left">
          <div className="tile-label">Осталось</div>
          <div className={b.plannedExpense - spentInBudget < 0 ? "tile-value over" : "tile-value"}>
            <Money amount={b.plannedExpense - spentInBudget} symbol={sym} minorUnits={minor} />
          </div>
        </div>
        <div className="card tile" data-testid="safe-to-spend">
          <div className="tile-label">Можно тратить сегодня</div>
          <div className={(b.safeToSpendToday ?? 0) < 0 ? "tile-value over" : "tile-value"}>
            {b.safeToSpendToday != null ? <Money amount={Math.max(b.safeToSpendToday, 0)} symbol={sym} minorUnits={minor} /> : <span className="muted">—</span>}
          </div>
          <div className="hint">{b.safeToSpendToday != null ? "остаток лимитов на оставшиеся дни" : "только для текущего месяца"}</div>
        </div>
      </div>

      <Lines b={b} kind="expense" minor={minor} />
      <Lines b={b} kind="income" minor={minor} />

      <div className="columns">
        <Note b={b} />
        <div className="card">
          <h2>Бюджет</h2>
          <p className="muted">
            Валюта бюджета: {b.currencyCode}. Операции в других валютах пересчитываются по курсу на дату операции. Переводы между счетами и
            корректировки баланса в факт не входят.
          </p>
          {confirmDelete ? (
            <div className="btn-group">
              <button className="btn danger" onClick={() => remove.run()} disabled={remove.busy}>
                Да, удалить бюджет
              </button>
              <button className="btn" onClick={() => setConfirmDelete(false)}>
                Отмена
              </button>
            </div>
          ) : (
            <button className="btn danger" onClick={() => setConfirmDelete(true)}>
              Удалить бюджет месяца
            </button>
          )}
          <ErrorText error={remove.error} />
        </div>
      </div>
    </>
  );
}

function Lines({ b, kind, minor }: { b: BudgetData; kind: CategoryKind; minor: number }) {
  const categories = useCategories().data ?? [];
  const showTransactions = useUi((s) => s.showTransactions);
  const lines = b.lines.filter((l) => l.kind === kind);
  const [newCat, setNewCat] = useState("");
  const [newLimit, setNewLimit] = useState("");
  const add = useAction((categoryId: string, limit: number) => api.setBudgetLimit(b.id!, categoryId, limit), () => {
    setNewCat("");
    setNewLimit("");
  });
  const income = kind === "income";
  const sym = b.currencySymbol;

  const submit = () => {
    const v = parseAmount(newLimit, minor);
    if (!newCat) return add.setError("Выберите категорию");
    if (v === null || v <= 0) return add.setError("Введите лимит больше нуля");
    add.run(newCat, v);
  };

  return (
    <div className="card" data-testid={`budget-${kind}`}>
      <h2>{income ? "Доходы" : "Расходы"}</h2>
      {lines.length === 0 && <p className="muted">{income ? "Ожидаемые доходы не заданы." : "Лимитов пока нет. Добавьте категорию ниже."}</p>}
      {lines.length > 0 && (
        <table className="table budget-table">
          <thead>
            <tr>
              <th>Категория</th>
              <th className="num">{income ? "План" : "Лимит"}</th>
              <th className="num">Факт</th>
              <th className="num">{income ? "Разница" : "Остаток"}</th>
              <th className="bar-col" />
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.categoryId} data-testid="budget-line" data-category={l.categoryName} className={l.over && !income ? "over-row" : undefined}>
                <td className={l.parentId ? "child-name" : "main"}>{l.categoryName}</td>
                <td className="num">
                  <LimitInput budgetId={b.id!} line={l} minor={minor} />
                </td>
                <td className="num">
                  <button
                    className="link fact"
                    title="Показать операции"
                    onClick={() => showTransactions({ categoryId: l.categoryId, dateFrom: b.period.start, dateTo: b.period.end })}
                  >
                    <Money amount={l.actual} symbol={sym} minorUnits={minor} />
                  </button>
                </td>
                <td className={l.over && !income ? "num over" : "num"}>
                  <Money amount={l.remaining} symbol={sym} minorUnits={minor} />
                </td>
                <td className="bar-col">
                  <div className={l.over && !income ? "bar over" : "bar"} title={`${l.percent} %`}>
                    <span style={{ width: `${Math.min(l.percent, 100)}%` }} />
                  </div>
                  <span className="percent" data-testid="percent">
                    {l.percent} %
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!income && b.unbudgetedExpense > 0 && (
        <p className="hint">
          Расходы по категориям без лимита: <Money amount={b.unbudgetedExpense} symbol={sym} minorUnits={minor} />
        </p>
      )}
      <div className="inline-form add-line">
        <CategorySelect
          name={`add-${kind}`}
          categories={categories}
          kind={kind}
          value={newCat}
          onChange={setNewCat}
          placeholder="Добавить категорию"
          exclude={(c) => lines.some((l) => l.categoryId === c.id)}
        />
        <AmountInput name={`add-${kind}-limit`} value={newLimit} onChange={setNewLimit} minorUnits={minor} />
        <button className="btn small" onClick={submit} disabled={add.busy}>
          Добавить
        </button>
      </div>
      <ErrorText error={add.error} />
    </div>
  );
}

/** Лимит редактируется на месте: сохраняется при уходе из поля или по Enter; пустое поле убирает строку. */
function LimitInput({ budgetId, line, minor }: { budgetId: string; line: BudgetLine; minor: number }) {
  const [text, setText] = useState(amountText(line.limit, minor));
  useEffect(() => setText(amountText(line.limit, minor)), [line.limit, minor]);
  const save = useAction((limit: number | null) => api.setBudgetLimit(budgetId, line.categoryId, limit));
  const commit = () => {
    if (text.trim() === "") return save.run(null);
    const v = parseAmount(text, minor);
    if (v === null || v < 0) return setText(amountText(line.limit, minor));
    if (v !== line.limit) save.run(v);
  };
  return (
    <span onBlur={commit} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}>
      <AmountInput name="limit" value={text} onChange={setText} minorUnits={minor} />
    </span>
  );
}

function Note({ b }: { b: BudgetData }) {
  const [text, setText] = useState(b.note ?? "");
  const save = useAction((note: string | null) => api.setBudgetNote(b.id!, note));
  return (
    <div className="card">
      <h2>Заметка к месяцу</h2>
      <textarea
        name="budgetNote"
        rows={4}
        placeholder="Например: в ноябре отпуск, отложить на подарки"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => text !== (b.note ?? "") && save.run(text.trim() ? text : null)}
      />
      <ErrorText error={save.error} />
    </div>
  );
}
