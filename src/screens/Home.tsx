import { GoalsCard } from "../components/Goals";
import { SubscriptionsCard } from "../components/Subscriptions";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { CbrButton } from "../components/CbrButton";
import { CushionCard } from "../components/Cushion";
import { AheadCard } from "../components/Ahead";
import { change, DaysCard, Delta, Sparkline, sparkSeries, SummaryCard, TrendCard, useDashboard } from "../components/Dashboard";
import { InvestCard } from "../components/Invest";
import { QuickEntry } from "../components/QuickEntry";
import { HideAmountsButton } from "../components/Convenience";
import { Money } from "../components/Money";
import { TemplatesCard } from "../components/Templates";
import { OccurrenceItem } from "../components/Reminders";
import { TxnTable } from "../components/TxnTable";
import { api } from "../lib/api";
import { formatDate, monthTitle, today } from "../lib/dates";
import { useAccounts, useBudget, useMonthOf, useSettings } from "../lib/queries";
import { DEFAULT_LAYOUT, HOME_BLOCKS, moveBlock, parseLayout, placeBefore, toggleBlock, toSetting, type HomeBlock, type HomeLayout } from "../lib/homeLayout";
import { useAction } from "../lib/useAction";
import { ACCOUNT_DRAG, SpendCard } from "../components/SpendCard";
import { useUi } from "../lib/store";
import { ScreenTitle } from "../components/SectionIcon";
import { Hint } from "../components/Hint";
import { barClass, barLevel } from "../lib/budgetLevel";
import { ChecksCard, NetWorthSpark, UnusualCard } from "../components/QuickWins";
import { ExplainDialog, type ExplainKind } from "../components/Explain";

const BLOCK_DRAG = "application/x-p-treasury-block";

export function Home() {
  const date = today();
  const [cbrUsed, setCbrUsed] = useState(false);
  // Месяц считается от настройки «первый день месяца», как в бюджете.
  const period = useMonthOf(date).data;
  const totals = useQuery({ queryKey: ["totals", date], queryFn: () => api.totals(date) });
  const month = useQuery({
    queryKey: ["summary", period?.start, period?.end],
    queryFn: () => api.periodSummary(period!.start, period!.end),
    enabled: !!period,
  });
  const budget = useBudget(period?.month).data;
  const debts = useQuery({ queryKey: ["debtSummary"], queryFn: api.debtSummary }).data;
  const reminders = useQuery({ queryKey: ["reminders"], queryFn: api.remindersOverview }).data;
  const backup = useQuery({ queryKey: ["backupStatus"], queryFn: api.backupStatus }).data;
  const vault = useQuery({ queryKey: ["vaultStatus"], queryFn: api.vaultStatus }).data;
  const syncVault = useAction(api.vaultSync);
  const recent = useQuery({ queryKey: ["transactions", "recent"], queryFn: () => api.listTransactions({ limit: 8 }) });
  const accounts = useAccounts().data ?? [];
  const { openTxnForm, showTransactions, go } = useUi();
  const [editing, setEditing] = useState(false);
  const [explain, setExplain] = useState<ExplainKind | null>(null);
  const [dragOver, setDragOver] = useState<HomeBlock | null>(null);
  const layout = parseLayout(useSettings().data?.home_layout);
  const setSetting = useAction(api.setSetting);
  const saveLayout = (l: HomeLayout) => setSetting.run("home_layout", toSetting(l));
  const monthName = period ? monthTitle(period.month).toLowerCase() : "";
  // В плитках месяц без года: так подпись умещается в строку и суммы стоят на одном уровне.
  const monthShort = monthName.replace(/ \d{4}$/, "");
  const symbol = totals.data?.baseSymbol ?? "₽";
  const dash = useDashboard(period);
  const spark = sparkSeries(dash.months, totals.data?.total);
  const prev = dash.prevSame;

  const blocks: Record<HomeBlock, React.ReactNode> = {
    quick: (
          <div className="card quick-card">
            <span className="quick-hint">
              <Hint of="quick" />
            </span>
            <QuickEntry />
          </div>
    ),
    summary: period ? <SummaryCard period={period} /> : null,
    trend: period ? <TrendCard period={period} /> : null,
    days: <DaysCard />,
    goals: <GoalsCard />,
    subs: <SubscriptionsCard />,
    tiles: (
          <div className="tiles">
            <div className="card tile" data-testid="total-balance">
              <div className="tile-label">
                Общий баланс
                <Hint of="home.balance" />
                <Delta pct={spark.balance.length ? change(spark.balance[spark.balance.length - 1], spark.balance[0]) : null} hint="за полгода" />
              </div>
              <button type="button" className="tile-value tile-explain" title="Как посчитано" data-testid="explain-balance" onClick={() => setExplain("balance")}>{totals.data && <Money amount={totals.data.total} symbol={symbol} animate />}</button>
              <Sparkline values={spark.balance} />
              {totals.data && (totals.data.missingRates.length > 0 || cbrUsed) && (
                // После загрузки подсказка остаётся, чтобы было видно итог.
                <div className={totals.data.missingRates.length > 0 ? "hint warn" : "hint"} data-testid="home-missing-rates">
                  {totals.data.missingRates.length > 0 && <>Нет курса для {totals.data.missingRates.join(", ")}: такие счета не вошли.</>}
                  <CbrButton small label="Загрузить курс ЦБ" onLoaded={() => setCbrUsed(true)} />
                </div>
              )}
              {debts && (debts.owedToMe !== 0 || debts.iOwe !== 0 || debts.assets !== 0) && (
                <div className="hint" data-testid="home-net-worth" title="Счета + имущество + должны мне − должен я">
                  Чистые активы{debts.assets !== 0 ? " с имуществом и долгами" : " с долгами"}: <Money amount={debts.netWorth} symbol={symbol} />
                  <NetWorthSpark />
                </div>
              )}
            </div>
            <div className="card tile" data-testid="month-income">
              <div className="tile-label">
                Доходы, {monthShort}
                <Hint of="home.income" />
                {month.data && <Delta pct={change(month.data.income, prev?.income)} hint="к тем же дням прошлого месяца" />}
              </div>
              <button type="button" className="tile-value tile-explain plus" title="Как посчитано" data-testid="explain-income" onClick={() => setExplain("income")}>{month.data && <Money amount={month.data.income} symbol={symbol} animate />}</button>
              <Sparkline values={spark.income} className="income" />
              {month.data?.savingsRate != null && (
                <div className="hint" data-testid="home-savings-rate">
                  Норма сбережений {month.data.savingsRate} %
                </div>
              )}
            </div>
            <div className="card tile" data-testid="month-expense">
              <div className="tile-label">
                Расходы, {monthShort}
                <Hint of="home.expense" />
                {month.data && <Delta pct={change(month.data.expense, prev?.expense)} lowerIsBetter hint="к тем же дням прошлого месяца" />}
              </div>
              <button type="button" className="tile-value tile-explain" title="Как посчитано" data-testid="explain-expense" onClick={() => setExplain("expense")}>{month.data && <Money amount={month.data.expense} symbol={symbol} animate />}</button>
              <Sparkline values={spark.expense} className="expense" />
            </div>
            <div className="card tile">
              <div className="tile-label">
                Сальдо месяца
                <Hint of="home.saldo" />
                {month.data && prev && <Delta pct={change(month.data.income - month.data.expense, prev.income - prev.expense)} hint="к тем же дням прошлого месяца" />}
              </div>
              <button type="button" className="tile-value tile-explain" title="Как посчитано" data-testid="explain-saldo" onClick={() => setExplain("saldo")}>{month.data && <Money amount={month.data.income - month.data.expense} symbol={symbol} signed animate />}</button>
              <Sparkline values={spark.saldo} />
            </div>
          </div>
    ),
    checks: <ChecksCard />,
    unusual: <UnusualCard />,
    cushion: <CushionCard />,
    ahead: <AheadCard />,
    invest: <InvestCard />,
    templates: <TemplatesCard />,
    spend: <SpendCard />,
    main: (
          <div className="columns home">
            <div className="card">
              <h2>
                Счета
                <Hint of="home.accounts" />
              </h2>
              {accounts.length === 0 && <p className="muted">Счетов нет.</p>}
              <ul className="account-list">
                {accounts.map((a) => (
                  <li
                    key={a.id}
                    onClick={() => showTransactions({ accountId: a.id })}
                    className="clickable draggable"
                    data-testid="home-account"
                    draggable
                    onDragStart={(e) => e.dataTransfer.setData(ACCOUNT_DRAG, a.id)}
                    title="Перетащите на категорию в «Куда тратите», чтобы записать расход"
                  >
                    <span>{a.name}</span>
                    <Money amount={a.value ?? a.balance} symbol={a.currencySymbol} minorUnits={a.minorUnits} />
                  </li>
                ))}
              </ul>
            </div>
            <div className="card">
              <h2>
                Последние операции
                <Hint of="home.recent" />
              </h2>
              {recent.data && <TxnTable items={recent.data.items} compact />}
            </div>
          </div>
    ),
    plans: (
          <div className="columns home-bottom">
          <div className="card clickable" data-testid="home-budget" onClick={() => go("budget")}>
            <h2>Бюджет, {monthName}</h2>
            {budget && !budget.id && <p className="muted">Бюджета на этот месяц нет. Нажмите, чтобы составить.</p>}
            {budget?.id && (
              <>
                <p>
                  Можно тратить сегодня:{" "}
                  <b data-testid="home-safe-to-spend">
                    {budget.safeToSpendToday != null ? <Money amount={Math.max(budget.safeToSpendToday, 0)} symbol={budget.currencySymbol} /> : "—"}
                  </b>
                </p>
                <ul className="budget-brief">
                  {budget.lines
                    .filter((l) => l.kind === "expense" && !l.parentId)
                    .sort((a, b) => b.percent - a.percent)
                    .slice(0, 5)
                    .map((l) => (
                      <li key={l.categoryId} className={barLevel(l.percent) === "over" ? "over" : undefined}>
                        <span>{l.categoryName}</span>
                        <div className={barClass(l.percent)}>
                          <span style={{ width: `${Math.min(l.percent, 100)}%` }} />
                        </div>
                        <span className="percent">{l.percent} %</span>
                      </li>
                    ))}
                </ul>
              </>
            )}
          </div>
          <div className="card clickable" data-testid="home-upcoming" onClick={() => go("debts")}>
            <h2>
              Ближайшие платежи по долгам
              <Hint of="debts.upcoming" />
            </h2>
            {debts && debts.upcoming.length === 0 && <p className="muted">Платежей нет.</p>}
            <ul className="account-list">
              {debts?.upcoming.slice(0, 4).map((u) => (
                <li key={u.scheduleId} className={u.overdue ? "over" : undefined}>
                  <span>
                    {formatDate(u.dueDate)} · {u.counterparty}
                  </span>
                  <Money amount={u.payment} symbol={u.currencySymbol} minorUnits={u.minorUnits} />
                </li>
              ))}
            </ul>
          </div>
          </div>
    ),
    reminders: (
          <div className="card" data-testid="home-reminders">
            <div className="notes-head">
              <h2>
                Ближайшие напоминания
                <Hint of="reminders" />
              </h2>
              <button className="link" onClick={() => go("calendar")}>
                Календарь
              </button>
            </div>
            {reminders && reminders.overdue.length + reminders.upcoming.length === 0 && <p className="muted">Напоминаний нет.</p>}
            <ul className="occ-list">
              {reminders && [...reminders.overdue, ...reminders.upcoming].slice(0, 5).map((o) => <OccurrenceItem key={o.key.refId + o.key.scheduledAt} o={o} />)}
            </ul>
          </div>
    ),
  };

  return (
    <section className="screen wide">
      <div className="screen-head">
        <ScreenTitle id="home" />
        <div className="btn-group">
          <button className={editing ? "btn primary" : "btn"} onClick={() => setEditing(!editing)} data-testid="home-customize">
            {editing ? "Готово" : "Настроить"}
          </button>
          <HideAmountsButton className="btn" />
          <button className="btn" onClick={() => openTxnForm({ mode: "new", type: "income" })}>
            + Доход
          </button>
          <button className="btn" onClick={() => openTxnForm({ mode: "new", type: "transfer" })}>
            Перевод
          </button>
          <button className="btn primary" onClick={() => openTxnForm({ mode: "new", type: "expense" })} title="Ctrl+N">
            + Расход
          </button>
        </div>
      </div>

      {backup?.reminderDue && (
        <div className="card banner warn" data-testid="backup-reminder">
          <span>
            Резервной копии не было больше месяца.{" "}
            <span className="muted" data-testid="backup-reason">
              {backup.lastBackupAt ? `Последняя — ${formatDate(backup.lastBackupAt.slice(0, 10))}` : "Копия ещё не делалась"}
              {vault && !vault.on ? ", папка сохранности выключена" : vault?.error ? `, папка сохранности не обновляется: ${vault.error}` : ""}. Если компьютер сломается, данные пропадут.
            </span>
          </span>
          {vault?.on && (
            <button className="btn primary" onClick={() => syncVault.run()} disabled={syncVault.busy} aria-busy={syncVault.busy}>
              Сохранить сейчас
            </button>
          )}
          <button className="btn" onClick={() => go("settings")}>
            Открыть настройки
          </button>
        </div>
      )}
      {vault?.verifyError && (
        <div className="card banner warn" data-testid="verify-warning">
          <span>
            Последняя копия не прошла проверку восстановления.{" "}
            <span className="muted">
              Причина: {vault.verifyError}. {vault.verified ? `Последняя исправная копия проверена ${formatDate(vault.verified.checkedAt.slice(0, 10))}.` : "Исправной копии пока нет."}
            </span>
          </span>
          {vault.on && (
            <button className="btn primary" onClick={() => syncVault.run()} disabled={syncVault.busy} aria-busy={syncVault.busy}>
              Сделать новую копию
            </button>
          )}
          <button className="btn" onClick={() => go("settings")}>
            Открыть настройки
          </button>
        </div>
      )}

      {editing && (
        <p className="hint home-edit-hint">
          Перетащите карточку мышью или двигайте стрелками; «Скрыть» убирает её с Главной, «Показать» возвращает. Список карточек есть и в Настройках.{" "}
          <button className="link" onClick={() => saveLayout(DEFAULT_LAYOUT)}>
            Вернуть по умолчанию
          </button>
        </p>
      )}
      {layout.order
        .filter((b) => editing || !layout.hidden.includes(b))
        .map((b) =>
          editing ? (
            <div
              key={b}
              className={["home-block", "editing", layout.hidden.includes(b) && "hidden-block", dragOver === b && "drop-over"].filter(Boolean).join(" ")}
              data-testid="home-block"
              data-block={b}
              draggable
              onDragStart={(e) => e.dataTransfer.setData(BLOCK_DRAG, b)}
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes(BLOCK_DRAG)) return;
                e.preventDefault();
                setDragOver(b);
              }}
              onDragLeave={() => setDragOver((cur) => (cur === b ? null : cur))}
              onDrop={(e) => {
                const from = e.dataTransfer.getData(BLOCK_DRAG) as HomeBlock;
                setDragOver(null);
                if (from) saveLayout(placeBefore(layout, from, b));
              }}
            >
              <div className="home-block-bar">
                <span className="grip" aria-hidden>
                  ⠿
                </span>
                <b>{HOME_BLOCKS[b]}</b>
                <span className="spacer" />
                <button className="icon-btn" aria-label={`Выше: ${HOME_BLOCKS[b]}`} onClick={() => saveLayout(moveBlock(layout, b, -1))}>
                  ↑
                </button>
                <button className="icon-btn" aria-label={`Ниже: ${HOME_BLOCKS[b]}`} onClick={() => saveLayout(moveBlock(layout, b, 1))}>
                  ↓
                </button>
                <button className="link" onClick={() => saveLayout(toggleBlock(layout, b))}>
                  {layout.hidden.includes(b) ? "Показать" : "Скрыть"}
                </button>
              </div>
              {!layout.hidden.includes(b) && <div className="home-block-body">{blocks[b]}</div>}
            </div>
          ) : (
            <div key={b} className="home-block" data-block={b}>
              {blocks[b]}
            </div>
          ),
        )}
      {explain && period && <ExplainDialog kind={explain} on={date} from={period.start} to={period.end} onClose={() => setExplain(null)} />}
    </section>
  );
}
