import { EventsCard } from "../components/Events";
import { useModules } from "../lib/modules";
import { InvestBudgetCard } from "../components/Invest";
import { PlanFactCard } from "../components/PlanFact";
import { useEffect, useState } from "react";
import { AmountInput, amountText, CategorySelect } from "../components/Fields";
import { ErrorText, Modal } from "../components/Modal";
import { Money } from "../components/Money";
import { api, type Budget as BudgetData, type BudgetLine, type CategoryKind, type FillMode, type LimitKind } from "../lib/api";
import { formatDate, monthGenitive, monthTitle, shiftMonth, today } from "../lib/dates";
import { formatAmount, parseAmount } from "../lib/money";
import { useBudget, useCategories, useCurrencies, useMonthOf } from "../lib/queries";
import { useUi } from "../lib/store";
import { useAction } from "../lib/useAction";
import { ScreenTitle } from "../components/SectionIcon";
import { Hint } from "../components/Hint";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, CornerDownRight } from "lucide-react";
import { barClass, barLevel, usualLabel } from "../lib/budgetLevel";
import { MonthReviewDialog } from "../components/MonthReview";

/** Экран «Бюджет»: лимиты по категориям на месяц, план/факт/остаток. */
export function Budget() {
  const modules = useModules();
  const current = useMonthOf(today()).data?.month;
  const [picked, setPicked] = useState<string | null>(null);
  const month = picked ?? current;
  const budget = useBudget(month);
  const b = budget.data;
  const [review, setReview] = useState(false);
  const [mode, setMode] = useState<"month" | "year">("month");

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
            <button className="btn" data-testid="month-review-open" onClick={() => setReview(true)} title="Сколько отложено, прогноз и факт, «Месяц завершён»">
              Итоги месяца
            </button>
          </div>
        )}
        <div className="tabs small" role="group" aria-label="Вид бюджета" data-testid="budget-mode">
          {(
            [
              ["month", "Месяц"],
              ["year", "Год"],
            ] as const
          ).map(([k, label]) => (
            <button key={k} type="button" className={mode === k ? "tab active" : "tab"} aria-pressed={mode === k} onClick={() => setMode(k)} data-testid={`budget-mode-${k}`}>
              {label}
            </button>
          ))}
        </div>
        {review && month && <MonthReviewDialog month={month} onClose={() => setReview(false)} />}
      </div>
      {budget.error && <p className="error">{String(budget.error)}</p>}
      {mode === "year" && month && (
        <YearView
          year={Number(month.slice(0, 4))}
          onYear={(y) => setPicked(`${y}-${month.slice(5, 7)}`)}
          onMonth={(m) => {
            setPicked(m);
            setMode("month");
          }}
        />
      )}
      {mode === "month" && b && (b.id ? <BudgetView key={b.id} b={b} /> : <NoBudget month={b.period.month} />)}
      {mode === "month" && month && b && !b.id && <InvestBudgetCard month={month} />}
      {modules.on("events") && <EventsCard />}
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
      {b.carryMissingRates.length > 0 && (
        <div className="card hint warn" data-testid="carry-missing-rates">
          В прошлых месяцах есть траты в {b.carryMissingRates.join(", ")} без курса: остаток из этих месяцев не перенесён, пока курс не введён в Настройках.
        </div>
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
      <GroupsCard b={b} minor={minor} />
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
          <CopyForward month={b.period.month} />
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
  const rollover = useAction((categoryId: string, on: boolean) => api.setBudgetRollover(b.id!, categoryId, on));
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
                  {!income && (
                    <button
                      className="icon-btn row-action rollover-btn"
                      aria-pressed={l.rollover}
                      aria-label={`Переносить остаток «${l.categoryName}» на следующий месяц`}
                      title={l.rollover ? "Остаток переносится на следующий месяц. Нажмите, чтобы не переносить" : "Переносить неистраченный остаток на следующий месяц"}
                      data-testid="budget-rollover"
                      onClick={() => rollover.run(l.categoryId, !l.rollover)}
                      disabled={rollover.busy}
                    >
                      <CornerDownRight size={14} strokeWidth={2} aria-hidden="true" />
                    </button>
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
                  <LimitInput budgetId={b.id!} line={l} minor={minor} focus={focusCat === l.categoryId} basis={b.incomeBasis} days={periodDays(b)} />
                  {l.carried > 0 && (
                    <span className="carried" data-testid="budget-carried" title="Остаток прошлого месяца">
                      + <Money amount={l.carried} symbol={sym} minorUnits={minor} /> с прошлого месяца
                    </span>
                  )}
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
      <ErrorText error={fill.error ?? rollover.error} />
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

const KIND_LABEL: Record<LimitKind, string> = { month: "в месяц", week: "в неделю", percent: "% дохода" };

/** Лимит редактируется на месте: сохраняется при уходе из поля или по Enter; пустое поле убирает строку.
 *  Р9: у расходов вид лимита — в месяц, в неделю или долей дохода месяца. */
function LimitInput({ budgetId, line, minor, focus, basis, days }: { budgetId: string; line: BudgetLine; minor: number; focus?: boolean; basis: number; days: number }) {
  const kind = line.limitKind ?? "month";
  const shown = kind === "week" ? (line.limitValue ?? 0) : kind === "percent" ? (line.limitValue ?? 0) : line.baseLimit;
  const toText = (v: number) => (kind === "percent" ? String(v / 100).replace(".", ",") : amountText(v, minor));
  const [text, setText] = useState(toText(shown));
  useEffect(() => setText(toText(shown)), [shown, kind, minor]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = useAction((limit: number | null) => api.setBudgetLimit(budgetId, line.categoryId, limit));
  const saveKind = useAction((k: LimitKind, v: number) => api.setBudgetLimitKind(budgetId, line.categoryId, k, v));
  const commit = () => {
    if (text.trim() === "") return save.run(null);
    if (kind === "percent") {
      const pct = Number(text.replace(",", ".").replace("%", "").trim());
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) return setText(toText(shown));
      const bp = Math.round(pct * 100);
      if (bp !== shown) saveKind.run("percent", bp);
      return;
    }
    const v = parseAmount(text, minor);
    if (v === null || v < 0) return setText(toText(shown));
    if (v === shown) return;
    if (kind === "week") saveKind.run("week", v);
    else save.run(v);
  };
  // Смена вида пересчитывает текущий лимит, чтобы сумма на месяц не прыгала.
  const switchKind = (k: LimitKind) => {
    const month = line.baseLimit;
    const value = k === "week" ? Math.round((month * 7) / days) : k === "percent" ? (basis > 0 ? Math.round((month / basis) * 10_000) : 0) : month;
    saveKind.run(k, Math.min(value, k === "percent" ? 10_000 : value));
  };
  const income = line.kind === "income";
  return (
    <span className="limit-cell">
      <span onBlur={commit} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}>
        {kind === "percent" ? (
          <input name="limit" className="pct-input" inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} aria-label="Доля дохода, %" autoFocus={focus} />
        ) : (
          <AmountInput name="limit" value={text} onChange={setText} minorUnits={minor} autoFocus={focus} />
        )}
      </span>
      {!income && (
        <select
          name="limitKind"
          className="limit-kind"
          aria-label={`Вид лимита «${line.categoryName}»`}
          value={kind}
          onChange={(e) => switchKind(e.target.value as LimitKind)}
          data-testid="limit-kind"
        >
          {(Object.keys(KIND_LABEL) as LimitKind[]).map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </select>
      )}
      {kind !== "month" && (
        <span className="limit-month muted small" data-testid="limit-month">
          ≈ <Money amount={line.baseLimit} minorUnits={minor} /> в месяц
        </span>
      )}
      <ErrorText error={save.error ?? saveKind.error} />
    </span>
  );
}

/** Р11: скопировать лимиты на N месяцев вперёд. */
function CopyForward({ month }: { month: string }) {
  const [n, setN] = useState(3);
  const [overwrite, setOverwrite] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const copy = useAction(
    () => api.copyBudgetForward(month, n, overwrite),
    (r) =>
      setDone(
        [
          r.created.length > 0 && `создано: ${r.created.length}`,
          r.replaced.length > 0 && `заменено: ${r.replaced.length}`,
          r.skipped.length > 0 && `уже были и не тронуты: ${r.skipped.map((m) => monthTitle(m).toLowerCase()).join(", ")}`,
        ]
          .filter(Boolean)
          .join("; ") || "нечего копировать",
      ),
  );
  return (
    <div className="copy-forward" data-testid="copy-forward">
      <div className="inline-form">
        <span>Скопировать лимиты на</span>
        <select name="copyMonths" value={n} onChange={(e) => setN(Number(e.target.value))} aria-label="На сколько месяцев">
          {[1, 2, 3, 6, 12].map((k) => (
            <option key={k} value={k}>
              {k} мес.
            </option>
          ))}
        </select>
        <span>вперёд</span>
        <button type="button" className="btn small" onClick={() => copy.run()} disabled={copy.busy} aria-busy={copy.busy}>
          Скопировать
        </button>
      </div>
      <label className="check small">
        <input type="checkbox" name="copyOverwrite" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />
        Заменить уже заведённые месяцы
      </label>
      {done && (
        <p className="ok small" role="status" data-testid="copy-done">
          Готово: {done}.
        </p>
      )}
      <ErrorText error={copy.error} />
    </div>
  );
}

/** Р10: группы бюджета — «Обязательное / Желаемое / Накопления» с долей дохода. */
function GroupsCard({ b, minor }: { b: BudgetData; minor: number }) {
  const [editing, setEditing] = useState(false);
  const template = useAction(api.applyBudgetTemplate);
  const sym = b.currencySymbol;
  return (
    <div className="card" data-testid="budget-groups">
      <div className="notes-head">
        <h2>
          Группы
          <Hint of="budget.groups" />
        </h2>
        {b.groups.length > 0 && (
          <button className="btn small" onClick={() => setEditing(true)} data-testid="budget-groups-edit">
            Настроить
          </button>
        )}
      </div>
      {b.groups.length === 0 ? (
        <div className="btn-group">
          <button className="btn small" onClick={() => template.run()} disabled={template.busy} data-testid="budget-template">
            Шаблон 50/30/20
          </button>
          <button className="btn small" onClick={() => setEditing(true)}>
            Свои группы
          </button>
          <span className="muted small">Обязательное, желаемое и накопления — доли дохода месяца.</span>
        </div>
      ) : (
        <table className="table budget-groups">
          <tbody>
            {b.groups.map((g) => {
              const goal = g.target ?? g.planned;
              const pct = goal > 0 ? Math.round((g.actual / goal) * 100) : 0;
              return (
                <tr key={g.id} data-testid="budget-group" data-name={g.name}>
                  <td className="main">
                    {g.name}
                    {g.shareBp != null && <span className="muted small"> · {g.shareBp / 100} % дохода</span>}
                  </td>
                  <td className="num">
                    <Money amount={g.actual} symbol={sym} minorUnits={minor} />
                    <div className="sub">{g.savings ? "осталось от дохода" : "потрачено"}</div>
                  </td>
                  <td className="num">
                    {g.target != null ? <Money amount={g.target} symbol={sym} minorUnits={minor} /> : <Money amount={g.planned} symbol={sym} minorUnits={minor} />}
                    <div className="sub">{g.target != null ? "цель" : "по лимитам"}</div>
                  </td>
                  <td className="bar-col">
                    <div className={g.savings ? "bar" : barClass(pct)}>
                      <span style={{ width: `${Math.min(pct, 100)}%` }} />
                    </div>
                    <span className="percent">{pct} %</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {b.groups.length > 0 && (
        <p className="hint">
          Доход месяца для долей: <Money amount={b.incomeBasis} symbol={sym} minorUnits={minor} /> (план доходов или факт, что больше).
        </p>
      )}
      <ErrorText error={template.error} />
      {editing && <GroupsForm onClose={() => setEditing(false)} />}
    </div>
  );
}

function GroupsForm({ onClose }: { onClose: () => void }) {
  const groups = useQuery({ queryKey: ["budgetGroups"], queryFn: api.listBudgetGroups }).data ?? [];
  const categories = (useCategories().data ?? []).filter((c) => c.kind === "expense" && !c.parentId);
  const [name, setName] = useState("");
  const [share, setShare] = useState("");
  const [edits, setEdits] = useState<Record<string, { name?: string; share?: string }>>({});
  const parseShare = (t: string) => (t.trim() === "" ? null : Math.round(Number(t.replace(",", ".")) * 100));
  const add = useAction(() => api.createBudgetGroup(name, parseShare(share)), () => (setName(""), setShare("")));
  const update = useAction((id: string, n: string, bp: number | null) => api.updateBudgetGroup(id, n, bp));
  const remove = useAction((id: string) => api.deleteBudgetGroup(id));
  const assign = useAction((categoryId: string, groupId: string | null) => api.setCategoryBudgetGroup(categoryId, groupId));
  const groupOf = (catId: string) => groups.find((g) => g.categoryIds.includes(catId))?.id ?? "";
  const commit = (g: (typeof groups)[number]) => {
    const e = edits[g.id];
    if (!e) return;
    const n = e.name ?? g.name;
    const bp = e.share !== undefined ? parseShare(e.share) : g.shareBp;
    if (n !== g.name || bp !== g.shareBp) update.run(g.id, n, bp);
  };
  return (
    <Modal title="Группы бюджета" onClose={onClose} wide>
      <ul className="group-list" data-testid="budget-group-list">
        {groups.map((g) => (
          <li key={g.id}>
            <input aria-label="Название группы" value={edits[g.id]?.name ?? g.name} onChange={(e) => setEdits({ ...edits, [g.id]: { ...edits[g.id], name: e.target.value } })} onBlur={() => commit(g)} />
            <input
              aria-label={`Доля дохода «${g.name}», %`}
              className="pct-input"
              inputMode="decimal"
              placeholder="% дохода"
              value={edits[g.id]?.share ?? (g.shareBp != null ? String(g.shareBp / 100) : "")}
              onChange={(e) => setEdits({ ...edits, [g.id]: { ...edits[g.id], share: e.target.value } })}
              onBlur={() => commit(g)}
            />
            <button type="button" className="link danger" onClick={() => remove.run(g.id)}>
              Удалить
            </button>
          </li>
        ))}
      </ul>
      <form className="inline-form" onSubmit={(e) => (e.preventDefault(), add.run())}>
        <input name="budgetGroupName" placeholder="Новая группа" value={name} onChange={(e) => setName(e.target.value)} />
        <input name="budgetGroupShare" className="pct-input" placeholder="% дохода" inputMode="decimal" value={share} onChange={(e) => setShare(e.target.value)} />
        <button type="submit" className="btn small" disabled={!name.trim() || add.busy}>
          Добавить
        </button>
      </form>
      {groups.length > 0 && (
        <>
          <h3>Категории расходов</h3>
          <p className="hint">Подкатегории идут в группу своей категории. Группа без категорий показывает, что осталось от дохода (накопления).</p>
          <table className="table">
            <tbody>
              {categories.map((c) => (
                <tr key={c.id} data-testid="group-category" data-category={c.name}>
                  <td>{c.name}</td>
                  <td>
                    <select name="categoryGroup" aria-label={`Группа «${c.name}»`} value={groupOf(c.id)} onChange={(e) => assign.run(c.id, e.target.value || null)}>
                      <option value="">—</option>
                      {groups.map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.name}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <ErrorText error={add.error ?? update.error ?? remove.error ?? assign.error} />
      <div className="actions">
        <span className="spacer" />
        <button type="button" className="btn primary" onClick={onClose}>
          Готово
        </button>
      </div>
    </Modal>
  );
}

/** Р11: годовой вид — 12 месяцев в строку; щелчок по месяцу открывает его. */
function YearView({ year, onYear, onMonth }: { year: number; onYear: (y: number) => void; onMonth: (m: string) => void }) {
  const q = useQuery({ queryKey: ["budgetYear", year], queryFn: () => api.budgetYear(year) });
  const y = q.data;
  const MONTHS = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
  // Без копеек, в валюте бюджета этого месяца, с учётом «скрыть суммы».
  const cell = (v: number, i: number) => {
    const minor = y?.minorUnits[i] ?? 2;
    const unit = 10 ** minor;
    return <Money amount={Math.round(v / unit) * unit} symbol={y?.symbols[i] ?? "₽"} minorUnits={minor} />;
  };
  return (
    <div className="card" data-testid="budget-year">
      <div className="notes-head">
        <div className="month-switch">
          <button className="icon-btn" aria-label="Предыдущий год" onClick={() => onYear(year - 1)}>
            <ChevronLeft size={18} strokeWidth={1.75} aria-hidden="true" />
          </button>
          <h2>{year} год</h2>
          <button className="icon-btn" aria-label="Следующий год" onClick={() => onYear(year + 1)}>
            <ChevronRight size={18} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>
        <span className="muted small">в ячейке — факт и лимит; красным — сверх лимита</span>
      </div>
      {q.error && <p className="error">{String(q.error)}</p>}
      {y && y.rows.length === 0 && <p className="muted">В этом году лимитов нет.</p>}
      {y && y.rows.length > 0 && (
        <div className="year-scroll">
          <table className="table year-budget">
            <thead>
              <tr>
                <th>Категория</th>
                {y.months.map((m, i) => (
                  <th key={m} className="num">
                    <button className={y.hasBudget[i] ? "link" : "link muted"} onClick={() => onMonth(m)} title="Открыть месяц">
                      {MONTHS[i]}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {y.rows.map((r) => (
                <tr key={r.categoryId} data-testid="year-row" data-category={r.categoryName}>
                  <td className={r.parentId ? "child-name" : "main"}>{r.categoryName}</td>
                  {r.limits.map((l, i) => {
                    const a = r.actuals[i];
                    const over = r.kind === "expense" && l != null && a > l;
                    return (
                      <td key={i} className={over ? "num over" : "num"}>
                        {a !== 0 || l != null ? cell(a, i) : ""}
                        {l != null && <div className="sub">{cell(l, i)}</div>}
                      </td>
                    );
                  })}
                </tr>
              ))}
              <tr className="total-row">
                <td>Расходы</td>
                {y.actualExpense.map((a, i) => (
                  <td key={i} className={y.hasBudget[i] && a > y.plannedExpense[i] ? "num over" : "num"}>
                    {cell(a, i)}
                    {y.hasBudget[i] && <div className="sub">{cell(y.plannedExpense[i], i)}</div>}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
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

/** Дней в периоде бюджета (для пересчёта недельного лимита). */
function periodDays(b: BudgetData): number {
  const ms = new Date(b.period.end).getTime() - new Date(b.period.start).getTime();
  return Math.round(ms / 86_400_000) + 1;
}
