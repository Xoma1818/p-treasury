import { EventsCard } from "../components/Events";
import { InvestBudgetCard } from "../components/Invest";
import { PlanFactCard } from "../components/PlanFact";
import { useEffect, useState } from "react";
import { AmountInput, amountText, CategorySelect } from "../components/Fields";
import { ErrorText } from "../components/Modal";
import { Money } from "../components/Money";
import { api, type Budget as BudgetData, type BudgetLine, type CategoryKind, type FillMode } from "../lib/api";
import { formatDate, monthGenitive, monthTitle, shiftMonth, today } from "../lib/dates";
import { formatAmount, parseAmount } from "../lib/money";
import { useBudget, useCategories, useCurrencies, useMonthOf } from "../lib/queries";
import { useUi } from "../lib/store";
import { useAction } from "../lib/useAction";
import { ScreenTitle } from "../components/SectionIcon";
import { Hint } from "../components/Hint";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { barClass, barLevel, usualLabel } from "../lib/budgetLevel";

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
        <ScreenTitle id="budget" />
        {month && (
          <div className="month-switch">
            <button className="icon-btn" aria-label="Предыдущий месяц" onClick={() => setPicked(shiftMonth(month, -1))}>
              <ChevronLeft size={18} strokeWidth={1.75} aria-hidden="true" />
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
              <ChevronRight size={18} strokeWidth={1.75} aria-hidden="true" />
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
      {month && b && !b.id && <InvestBudgetCard month={month} />}
      <EventsCard />
    </section>
  );
}

function NoBudget({ month }: { month: string }) {
  const create = useAction((copy: boolean) => api.createBudget(month, copy));
  // Бюджет создаётся пустым и сразу заполняется по тратам трёх прошлых месяцев.
  const byAverage = useAction(async () => {
    const id = await api.createBudget(month, false);
    await api.fillBudget(id, "average3");
  });
  const busy = create.busy || byAverage.busy;
  return (
    <div className="card empty-budget">
      <p>Бюджета на {monthTitle(month).toLowerCase()} пока нет.</p>
      <div className="btn-group">
        <button className="btn primary" onClick={() => create.run(true)} disabled={busy}>
          Скопировать из {monthGenitive(shiftMonth(month, -1))}
        </button>
        <button className="btn" onClick={() => byAverage.run()} disabled={busy} aria-busy={byAverage.busy} data-done={byAverage.done || undefined}>
          По тратам за 3 месяца
        </button>
        <button className="btn" onClick={() => create.run(false)} disabled={busy}>
          Создать пустой
        </button>
      </div>
      <p className="hint">
        Копируются лимиты и валюта. «По тратам за 3 месяца» ставит лимиты по средним расходам и доходам прошлых месяцев, с округлением до
        100 ₽.
      </p>
      <ErrorText error={create.error ?? byAverage.error} />
    </div>
  );
}

/** Строка прогноза под «Можно тратить сегодня»: что будет к концу месяца при текущем темпе. */
function Forecast({ b, minor }: { b: BudgetData; minor: number }) {
  if (b.forecastExpense == null || b.plannedExpense === 0) return null;
  const left = b.plannedExpense - b.forecastExpense;
  return (
    <div className={left < 0 ? "hint warn" : "hint"} data-testid="budget-forecast">
      При таком темпе к концу месяца {left < 0 ? "перерасход" : "останется"}{" "}
      <Money amount={Math.abs(left)} symbol={b.currencySymbol} minorUnits={minor} />
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
          <div className="tile-label">
            Лимиты расходов
            <Hint of="budget.limits" />
          </div>
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
          {b.eventExpense > 0 && (
            <div className="hint" data-testid="budget-events">
              поездки и события отдельно: <Money amount={b.eventExpense} symbol={sym} minorUnits={minor} />
            </div>
          )}
        </div>
        <div className="card tile" data-testid="budget-left">
          <div className="tile-label">
            Осталось
            <Hint of="budget.left" />
          </div>
          <div className={b.plannedExpense - spentInBudget < 0 ? "tile-value over" : "tile-value"}>
            <Money amount={b.plannedExpense - spentInBudget} symbol={sym} minorUnits={minor} />
          </div>
        </div>
        <div className="card tile" data-testid="safe-to-spend">
          <div className="tile-label">
            Можно тратить сегодня
            <Hint of="budget.today" />
          </div>
          <div className={(b.safeToSpendToday ?? 0) < 0 ? "tile-value over" : "tile-value"}>
            {b.safeToSpendToday != null ? <Money amount={Math.max(b.safeToSpendToday, 0)} symbol={sym} minorUnits={minor} /> : <span className="muted">—</span>}
          </div>
          <div className="hint">{b.safeToSpendToday != null ? "остаток лимитов на оставшиеся дни" : "только для текущего месяца"}</div>
          <Forecast b={b} minor={minor} />
        </div>
      </div>

      <PlanFactCard b={b} minor={minor} />
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
  // «Изменить план» из предупреждения: фокус на лимите категории (или на добавлении, если строки нет).
  const planFocus = useUi((s) => s.planFocus);
  const editPlan = useUi((s) => s.editPlan);
  const focused = kind === "expense" && planFocus ? planFocus : null;
  const hasLine = focused ? lines.some((l) => l.categoryId === focused) : false;
  useEffect(() => {
    if (!focused) return;
    if (!hasLine) setNewCat(focused);
    // Фокус держим, пока человек не перейдёт дальше; сам флаг сбрасываем сразу.
    editPlan(null);
  }, [focused, hasLine, editPlan]);
  const [focusCat] = useState(focused);
  const [newLimit, setNewLimit] = useState("");
  const add = useAction((categoryId: string, limit: number) => api.setBudgetLimit(b.id!, categoryId, limit), () => {
    setNewCat("");
    setNewLimit("");
  });
  const income = kind === "income";
  const sym = b.currencySymbol;
  const [filled, setFilled] = useState<string | null>(null);
  // А2: пометка «+34 % к обычному» у категорий, где траты заметно не как обычно.
  const usual = useQuery({ queryKey: ["usual", b.period.month], queryFn: () => api.spendingVsUsual(b.period.month), enabled: !income }).data;
  const notable = new Map((usual?.monthsCounted ? usual.items : []).filter((u) => u.notable).map((u) => [u.categoryId, u]));
  const fill = useAction(
    (mode: FillMode, categoryId: string | null) => api.fillBudget(b.id!, mode, categoryId),
    (n) => setFilled(n === 1 ? "Лимит обновлён по истории." : `Обновлено лимитов: ${n}.`),
  );

  const submit = () => {
    const v = parseAmount(newLimit, minor);
    if (!newCat) return add.setError("Выберите категорию");
    if (v === null || v <= 0) return add.setError("Введите лимит больше нуля");
    add.run(newCat, v);
  };

  return (
    <div className="card" data-testid={`budget-${kind}`}>
      <div className="notes-head">
        <h2>
          {income ? "Доходы" : "Расходы"}
          {!income && <Hint of="budget.bars" />}
        </h2>
        {!income && (
          <div className="btn-group" data-testid="budget-fill">
            <button
              className="btn small"
              title="Лимиты верхних категорий по средним тратам трёх прошлых месяцев"
              onClick={() => fill.run("average3", null)}
              disabled={fill.busy}
              aria-busy={fill.busy} data-done={fill.done || undefined}
            >
              По среднему за 3 месяца
            </button>
            <button className="btn small" title="Лимиты по тратам этого месяца год назад" onClick={() => fill.run("last_year", null)} disabled={fill.busy}>
              Как в прошлом году
            </button>
          </div>
        )}
      </div>
      {filled && !fill.error && <p className="hint" data-testid="budget-filled">{filled}</p>}
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
              <tr
                key={l.categoryId}
                data-testid="budget-line"
                data-category={l.categoryName}
                data-focus={focusCat === l.categoryId || undefined}
                className={[!income && barLevel(l.percent) === "over" && "over-row", focusCat === l.categoryId && "focus-row"].filter(Boolean).join(" ") || undefined}
              >
                <td className={l.parentId ? "child-name" : "main"}>
                  {l.categoryName}
                  {notable.has(l.categoryId) && (
                    <span
                      className={(notable.get(l.categoryId)!.percent ?? 0) > 0 ? "usual-pill up" : "usual-pill down"}
                      data-testid="usual-pill"
                      title={`Обычно к этому дню: ${formatAmount(notable.get(l.categoryId)!.usual, 2)} ${usual?.baseSymbol ?? sym}`}
                    >
                      {usualLabel(notable.get(l.categoryId)!.percent)}
                    </span>
                  )}
                  {!l.parentId && (
                    <button
                      className="icon-btn row-action"
                      aria-label={`Лимит «${l.categoryName}» по среднему за 3 месяца`}
                      title="Поставить лимит по среднему за 3 месяца"
                      onClick={() => fill.run("average3", l.categoryId)}
                      disabled={fill.busy}
                    >
                      ↺
                    </button>
                  )}
                </td>
                <td className="num">
                  <LimitInput budgetId={b.id!} line={l} minor={minor} focus={focusCat === l.categoryId} />
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
                  <div className={income ? "bar" : barClass(l.percent)} title={`${l.percent} %`}>
                    <span style={{ width: `${Math.min(l.percent, 100)}%` }} />
                  </div>
                  <span className={income || barLevel(l.percent) === "ok" ? "percent" : `percent ${barLevel(l.percent)}`} data-testid="percent">
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
      <ErrorText error={fill.error} />
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
        <button className="btn small" onClick={submit} aria-busy={add.busy} data-done={add.done || undefined} disabled={add.busy}>
          Добавить
        </button>
      </div>
      <ErrorText error={add.error} />
    </div>
  );
}

/** Лимит редактируется на месте: сохраняется при уходе из поля или по Enter; пустое поле убирает строку. */
function LimitInput({ budgetId, line, minor, focus }: { budgetId: string; line: BudgetLine; minor: number; focus?: boolean }) {
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
      <AmountInput name="limit" value={text} onChange={setText} minorUnits={minor} autoFocus={focus} />
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
