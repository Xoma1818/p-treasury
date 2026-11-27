import { AGGREGATE_STALE_MS } from "../lib/queryPolicy";
import { ChevronRight } from "lucide-react";
import { useModules } from "../lib/modules";
import { GoalsCard } from "../components/Goals";
import { SubscriptionsCard } from "../components/Subscriptions";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { CbrButton } from "../components/CbrButton";
import { accountLook, LookMark } from "../components/CategoryMark";
import { CushionCard } from "../components/Cushion";
import { AheadCard } from "../components/Ahead";
import { change, DaysCard, Delta, Sparkline, sparkSeries, SummaryCard, TrendCard, useDashboard } from "../components/Dashboard";
import { InvestCard } from "../components/Invest";
import { QuickEntry } from "../components/QuickEntry";
import { BaseMoney, Money } from "../components/Money";
import { TemplatesCard } from "../components/Templates";
import { OccurrenceItem } from "../components/Reminders";
import { TxnTable } from "../components/TxnTable";
import { api } from "../lib/api";
import { addDays, formatDate, monthTitle, today } from "../lib/dates";
import { useAccounts, useBudget, useMonthOf, useSettings } from "../lib/queries";
import { parseLayout, toSetting, type HomeBlock, type HomeLayout } from "../lib/homeLayout";
import { HomeCardGrid, HomeLayoutTools } from "../components/HomeCards";
import { currentBudgetGeneration, withBudgetWrite, watchBudgetGeneration } from "../lib/uiPrefs";
import { useAction } from "../lib/useAction";
import { SpendCard } from "../components/SpendCard";
import { ErrorText } from "../components/Modal";
import { spendAccount } from "../lib/directDrag";
import { useUi } from "../lib/store";
import { ScreenTitle } from "../components/SectionIcon";
import { Hint } from "../components/Hint";
import { barLevel } from "../lib/budgetLevel";
import { BudgetBar } from "../components/BudgetBar";
import { ChecksCard, NetWorthSpark, UnusualCard } from "../components/QuickWins";
import { ExplainDialog, type ExplainKind } from "../components/Explain";
import { MonthReviewBanner } from "../components/MonthReview";
import { AddMenu } from "../components/AddMenu";
import { FiguresCard } from "../components/Figures";
import { useFine } from "../lib/fine";
import type { HomePeriodKind } from "../lib/api";
import "./homeOverview.css";

export function Home() {
  const generation = useSyncExternalStore(watchBudgetGeneration, currentBudgetGeneration);
  const lastBudget = useRef(generation);
  if (generation !== null) lastBudget.current = generation;
  return lastBudget.current === null
    ? <section className="screen wide home-screen" aria-busy="true"><ScreenTitle id="home" /></section>
    : <BudgetHome key={lastBudget.current} generation={lastBudget.current} replacing={generation === null} />;
}

function BudgetHome({ generation, replacing }: { generation: number; replacing: boolean }) {
  const modules = useModules();
  const date = today();
  const [cbrUsed, setCbrUsed] = useState(false);
  // Месяц считается от настройки «первый день месяца», как в бюджете.
  const period = useMonthOf(date).data;
  const totals = useQuery({ staleTime: AGGREGATE_STALE_MS, queryKey: ["totals", date], queryFn: () => api.totals(date) });
  const free = useQuery({ staleTime: AGGREGATE_STALE_MS, queryKey: ["freeUntilIncome", date], queryFn: api.freeUntilIncome }).data;
  const month = useQuery({
    staleTime: AGGREGATE_STALE_MS,
    queryKey: ["summary", period?.start, period?.end],
    queryFn: () => api.periodSummary(period!.start, period!.end),
    enabled: !!period,
  });
  const budget = useBudget(period?.month).data;
  const debts = useQuery({ queryKey: ["debtSummary", date], queryFn: api.debtSummary, staleTime: AGGREGATE_STALE_MS }).data;
  const reminders = useQuery({ queryKey: ["reminders"], queryFn: api.remindersOverview }).data;
  const backup = useQuery({ queryKey: ["backupStatus"], queryFn: api.backupStatus }).data;
  const vault = useQuery({ queryKey: ["vaultStatus"], queryFn: api.vaultStatus }).data;
  const syncVault = useAction(api.vaultSync);
  const recent = useQuery({ queryKey: ["transactions", "recent"], queryFn: () => api.listTransactions({ limit: 8 }), staleTime: AGGREGATE_STALE_MS });
  const accounts = useAccounts().data ?? [];
  const { showTransactions, go, openSettings, homeEditorRequested, clearHomeEditorRequest } = useUi();
  const [draft, setDraft] = useState<{ layout: HomeLayout; baseline: string } | null>(null);
  const editing = draft !== null;
  const [announcement, setAnnouncement] = useState("");
  const openButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const saveButton = useRef<HTMLButtonElement>(null);
  const [overspendSlot, setOverspendSlot] = useState<HTMLDivElement | null>(null);
  const [explain, setExplain] = useState<ExplainKind | null>(null);
  const settings = useSettings().data;
  const layout = draft?.layout ?? parseLayout(settings?.home_layout);
  // Р2: плитки доходов и расходов — за месяц, неделю или с зарплаты.
  const homeKind: HomePeriodKind = settings?.home_period === "week" || settings?.home_period === "payday" ? settings.home_period : "month";
  const week = useFine().week;
  const range = useQuery({
    queryKey: ["homeRange", date, week, homeKind],
    queryFn: () => api.homeRange(date, week === "sun"),
    enabled: homeKind !== "month",
  }).data;
  const custom = homeKind !== "month" && range?.kind === homeKind ? range : null;
  const rangeSum = useQuery({
    staleTime: AGGREGATE_STALE_MS,
    queryKey: ["summary", custom?.from, custom?.to],
    queryFn: () => api.periodSummary(custom!.from, custom!.to),
    enabled: !!custom,
  }).data;
  const rangePrev = useQuery({
    staleTime: AGGREGATE_STALE_MS,
    queryKey: ["summary", custom?.prevFrom, custom?.prevTo],
    queryFn: () => api.periodSummary(custom!.prevFrom, custom!.prevTo),
    enabled: !!custom,
  }).data;
  const setSetting = useAction(api.setSetting);
  const finishEditing = (message: string) => {
    setDraft(null);
    setAnnouncement(message);
    requestAnimationFrame(() => openButton.current?.focus({ preventScroll: true }));
  };
  const save = useAction((l: HomeLayout, baseline: string) => withBudgetWrite(generation, async () => {
    const current = (await api.getSettings()).home_layout;
    if (toSetting(parseLayout(current)) !== baseline) {
      throw new Error("Раскладку изменили во время редактирования. Отмените правки и откройте редактор заново.");
    }
    await api.setSetting("home_layout", toSetting(l));
  }), () => finishEditing("Раскладка Главной сохранена."), { singleSubmit: true, networkMode: "always" });
  const updateDraft = (next: HomeLayout, message: string) => {
    setDraft(current => current && { ...current, layout: next });
    save.setError(null);
    setAnnouncement(message);
  };
  const startEditing = () => {
    if (!settings || currentBudgetGeneration() !== generation) return;
    const current = parseLayout(settings.home_layout);
    setDraft({ layout: current, baseline: toSetting(current) });
    save.setError(null);
    setAnnouncement("");
  };
  useEffect(() => {
    if (homeEditorRequested && settings) {
      clearHomeEditorRequest();
      if (!editing) startEditing();
    }
  }, [homeEditorRequested, settings, editing, clearHomeEditorRequest]);
  useEffect(() => {
    if (editing) cancelButton.current?.focus({ preventScroll: true });
  }, [editing]);
  const edit = editing ? { busy: save.busy, update: updateDraft } : null;
  const monthName = period ? monthTitle(period.month).toLowerCase() : "";
  // В плитках месяц без года: так подпись умещается в строку и суммы стоят на одном уровне.
  const monthShort = monthName.replace(/ \d{4}$/, "");
  const dash = useDashboard(period);
  const spark = sparkSeries(dash.months, totals.data?.total);
  const prevMonth = dash.prevSame;
  // Что показывают плитки: месяц как раньше или период Р2 и такой же отрезок перед ним.
  const shown = homeKind === "month" ? month.data : custom ? rangeSum : undefined;
  const prev = homeKind === "month" ? prevMonth : rangePrev;
  const tileWhen = homeKind === "month" ? monthShort : homeKind === "week" ? "неделя" : "с зарплаты";
  const tileFrom = homeKind === "month" ? period?.start : custom?.from;
  const tileTo = homeKind === "month" ? period?.end : custom?.to;
  const openPeriodOperations = (type: "income" | "expense") => {
    if (tileFrom && tileTo) {
      showTransactions({ dateFrom: tileFrom, dateTo: tileTo, types: [type], counted: true });
    }
  };
  const visible = (block: HomeBlock) => modules.blockOn(block) && !layout.hidden.includes(block);
  const limitBlock = (["tiles", "plans", "summary"] as const).find(visible);
  const budgetToday = budget?.id ? (
    <div className="home-budget-today">
      <span>Дневной лимит по бюджету</span>
      <b data-testid="home-safe-to-spend">
        {budget.safeToSpendToday != null ? <BaseMoney amount={Math.max(budget.safeToSpendToday, 0)} currencyCode={budget.currencyCode} /> : "—"}
      </b>
      <small className="hint">{budget.safeToSpendToday == null ? "Доступен в текущем бюджетном месяце." : `Остаток лимитов расходов распределён по дням с ${formatDate(date)} по ${formatDate(budget.period.end)} включительно.`}</small>
      {budget.missingRates.length > 0 && <small className="hint warn">Часть расходов не учтена. Нет курса для {budget.missingRates.join(", ")}.</small>}
      {budget.carryMissingRates.length > 0 && <small className="hint warn">Часть остатков прошлых месяцев не перенесена. Нет курса для {budget.carryMissingRates.join(", ")}.</small>}
    </div>
  ) : null;
  const prevHint = homeKind === "month" ? "к тем же дням прошлого месяца" : "к тем же дням прошлого периода";
  const sparks = homeKind === "month";
  const hasBalanceChart = spark.balance.length > 1;

  const blocks: Record<HomeBlock, React.ReactNode> = {
    quick: (
          <div className="card quick-card">
            <span className="quick-hint">
              <Hint of="quick" />
            </span>
            <QuickEntry />
          </div>
    ),
    summary: period ? <SummaryCard period={period} dailyLimit={limitBlock === "summary" && budgetToday} /> : null,
    figures: <FiguresCard />,
    trend: period ? <TrendCard period={period} /> : null,
    days: <DaysCard />,
    goals: <GoalsCard />,
    subs: <SubscriptionsCard />,
    tiles: (
          <div className="tiles home-overview">
            <div className="card tile home-balance" data-testid="total-balance">
              <div className="home-balance-metrics">
                <div className="home-balance-main">
                  <div className="tile-label">
                    Общий баланс
                    <Hint of="home.balance" />
                    <Delta pct={spark.balance.length ? change(spark.balance[spark.balance.length - 1], spark.balance[0]) : null} hint="за полгода" />
                  </div>
                  <button type="button" className="tile-value tile-explain" title="Как посчитан общий баланс" aria-haspopup="dialog" data-testid="explain-balance" onClick={() => setExplain("balance")}>
                    <span className="sr-only">Как посчитан общий баланс. </span>
                    {totals.data ? <BaseMoney amount={totals.data.total} currencyCode={totals.data.baseCurrency} animate /> : "—"}
                  </button>
                  {hasBalanceChart && (
                    <div className="home-balance-chart" role="img" aria-label="Динамика общего баланса по месяцам" title="Динамика общего баланса по месяцам">
                      <Sparkline values={spark.balance} area />
                    </div>
                  )}
                </div>
                {free && (
                  <div className="home-free-detail">
                    <button type="button" className="home-free-explain" data-testid="home-free" onClick={() => setExplain("free")} aria-haspopup="dialog">
                      <span className="tile-label">{free.income ? `Свободно до дохода ${formatDate(free.until)}` : `Свободно до конца бюджетного месяца · по ${formatDate(addDays(free.until, -1))}`}</span>
                      <strong><BaseMoney amount={free.free} currencyCode={free.baseCurrency} /></strong>
                      <span className="home-calculation-link">Как посчитано</span>
                    </button>
                    {free.missingRates.length > 0 && <span className="hint warn">Неполный расчёт. Нет курса для {free.missingRates.join(", ")}.</span>}
                  </div>
                )}
                {limitBlock === "tiles" && budgetToday}
              </div>
              {totals.data && (totals.data.missingRates.length > 0 || cbrUsed) && (
                // После загрузки подсказка остаётся, чтобы было видно итог.
                <div className={totals.data.missingRates.length > 0 ? "hint warn home-balance-detail" : "hint home-balance-detail"} data-testid="home-missing-rates">
                  {totals.data.missingRates.length > 0 && <>Нет курса для {totals.data.missingRates.join(", ")}: такие счета не вошли.</>}
                  <CbrButton small label="Загрузить курс ЦБ" onLoaded={() => setCbrUsed(true)} />
                </div>
              )}
              {debts && (debts.owedToMe !== 0 || debts.iOwe !== 0 || debts.assets !== 0) && (
                <div className="hint home-balance-detail home-net-worth" data-testid="home-net-worth" title="Счета + имущество + должны мне − должен я">
                  <span>Чистые активы{debts.assets !== 0 ? " с имуществом и долгами" : " с долгами"}: <BaseMoney amount={debts.netWorth} currencyCode={debts.baseCurrency} /></span>
                  <NetWorthSpark />
                </div>
              )}
            </div>
            <div className="home-period">
              <div className="tabs small motion-segments" role="group" aria-label="Период плиток" data-testid="home-period">
                {(
                  [
                    ["month", "Месяц"],
                    ["week", "Неделя"],
                    ["payday", "От зарплаты"],
                  ] as const
                ).map(([k, label]) => (
                  <button key={k} type="button" className={homeKind === k ? "tab active" : "tab"} aria-pressed={homeKind === k} onClick={() => setSetting.run("home_period", k)} data-testid={`home-period-${k}`}>
                    {label}
                  </button>
                ))}
              </div>
              <Hint of="home.period" />
              {custom && (
                <span className="muted small" data-testid="home-period-range">
                  {custom.kind === "payday" && !custom.payday ? "Крупного дохода за 45 дней нет — считаем месяц" : `${formatDate(custom.from)} – ${formatDate(custom.to)}`}
                </span>
              )}
            </div>
            <div className="card tile" data-testid="month-income">
              <div className="tile-label">
                Доходы, {tileWhen}
                <Hint of="home.income" />
                {shown && <Delta pct={change(shown.income, prev?.income)} hint={prevHint} />}
              </div>
              <button type="button" className="tile-value tile-explain plus" title="Как посчитано" data-testid="explain-income" onClick={() => setExplain("income")}>{shown && <BaseMoney amount={shown.income} currencyCode={shown.baseCurrency} animate />}</button>
              {sparks && <Sparkline values={spark.income} className="income" />}
              {shown?.savingsRate != null && (
                <div className="hint" data-testid="home-savings-rate">
                  Норма сбережений {shown.savingsRate} %
                </div>
              )}
              {shown && tileFrom && tileTo && (
                <button type="button" className="link home-period-operations" onClick={() => openPeriodOperations("income")}>
                  Открыть доходы за период
                </button>
              )}
            </div>
            <div className="card tile" data-testid="month-expense">
              <div className="tile-label">
                Расходы, {tileWhen}
                <Hint of="home.expense" />
                {shown && <Delta pct={change(shown.expense, prev?.expense)} lowerIsBetter hint={prevHint} />}
              </div>
              <button type="button" className="tile-value tile-explain" title="Как посчитано" data-testid="explain-expense" onClick={() => setExplain("expense")}>{shown && <BaseMoney amount={shown.expense} currencyCode={shown.baseCurrency} animate />}</button>
              {sparks && <Sparkline values={spark.expense} className="expense" />}
              {shown && tileFrom && tileTo && (
                <button type="button" className="link home-period-operations" onClick={() => openPeriodOperations("expense")}>
                  Открыть расходы и возвраты
                </button>
              )}
            </div>
            <div className="card tile">
              <div className="tile-label">
                {homeKind === "month" ? "Сальдо месяца" : `Сальдо, ${tileWhen}`}
                <Hint of="home.saldo" />
                {shown && prev && <Delta pct={change(shown.income - shown.expense, prev.income - prev.expense)} hint={prevHint} />}
              </div>
              <button type="button" className="tile-value tile-explain" title="Как посчитано" data-testid="explain-saldo" onClick={() => setExplain("saldo")}>{shown && <BaseMoney amount={shown.income - shown.expense} currencyCode={shown.baseCurrency} signed animate />}</button>
              {sparks && <Sparkline values={spark.saldo} />}
            </div>
          </div>
    ),
    checks: <ChecksCard budget={budget} overspendSlot={overspendSlot} />,
    unusual: <UnusualCard />,
    cushion: <CushionCard />,
    ahead: <AheadCard />,
    invest: <InvestCard />,
    templates: <TemplatesCard />,
    spend: <SpendCard />,
    accounts: (
            <div className="card">
              <h2>
                Счета
                <Hint of="home.accounts" />
              </h2>
              {accounts.length === 0 && <p className="muted">Счетов нет.</p>}
              <ul className="account-list home-account-list">
                {accounts.map((a) => (
                  <li
                    key={a.id}
                    onClick={() => showTransactions({ accountId: a.id })}
                    className="clickable draggable"
                    data-testid="home-account"
                    {...(!editing ? spendAccount.source(a.id) : {})}
                    title="Перетащите на категорию в «Куда тратите», чтобы записать расход"
                  >
                    <span className="home-account-name">
                      <LookMark look={a.icon || a.color ? accountLook(a) : { icon: "wallet", color: null }} size={30} />
                      <span>{a.name}</span>
                    </span>
                    <Money amount={a.value ?? a.balance} symbol={a.currencySymbol} currencyCode={a.currencyCode} minorUnits={a.minorUnits} />
                    <button type="button" className="icon-btn small" aria-label={`Операции по счёту «${a.name}»`}>
                      <ChevronRight size={15} aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
    ),
    recent: (
            <div className="card">
              <h2 data-txn-focus tabIndex={-1}>
                Последние операции
                <Hint of="home.recent" />
              </h2>
              {recent.data && <TxnTable items={recent.data.items} compact />}
            </div>
    ),
    plans: (
          <div className="columns home-bottom">
          {budget && !budget.id ? (
            <button type="button" className="card empty-line" data-testid="home-budget" onClick={() => go("budget")}>
              Бюджета на {monthShort} нет <span className="go">Составить →</span>
            </button>
          ) : (
            <div className="card home-budget-card" data-testid="home-budget">
              <h2>
                <button type="button" className="home-budget-link" onClick={() => go("budget")}>
                  Бюджет{monthName && `, ${monthName}`}
                  <span aria-hidden="true">→</span>
                </button>
              </h2>
              {budget?.id && (
                <>
                  {limitBlock === "plans" && budgetToday}
                  <ul className="budget-brief">
                    {budget.lines
                      .filter((l) => l.kind === "expense" && !l.parentId)
                      .sort((a, b) => b.percent - a.percent)
                      .slice(0, 5)
                      .map((l) => (
                        <li key={l.categoryId} className={l.over ? "over" : undefined}>
                          <span>{l.categoryName}</span>
                          <BudgetBar percent={l.percent} level={barLevel(l.actual, l.limit)} />
                        </li>
                      ))}
                  </ul>
                </>
              )}
            </div>
          )}
          {!modules.on("debts") ? null : debts && debts.upcoming.length === 0 ? (
            <button type="button" className="card empty-line" data-testid="home-upcoming" onClick={() => go("debts")}>
              Платежей по долгам нет <span className="go">Займы и долги →</span>
            </button>
          ) : (
            <div className="card clickable" data-testid="home-upcoming" onClick={() => go("debts")}>
              <h2>
                Ближайшие платежи по долгам
                <Hint of="debts.upcoming" />
              </h2>
              <ul className="account-list">
                {debts?.upcoming.slice(0, 4).map((u) => (
                  <li key={u.scheduleId} className={u.overdue ? "over" : undefined}>
                    <span>
                      {formatDate(u.dueDate)} · {u.counterparty}
                    </span>
                    <Money amount={u.payment} symbol={u.currencySymbol} currencyCode={u.currencyCode} minorUnits={u.minorUnits} />
                  </li>
                ))}
              </ul>
            </div>
          )}
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
    <section className="screen wide home-screen" inert={replacing} aria-busy={replacing || undefined}>
      <div className="screen-head home-screen-head">
        <ScreenTitle id="home" />
        {editing ? (
          <div className="home-actions">
            <button type="button" className="btn" ref={cancelButton} disabled={save.busy} data-testid="home-cancel"
              onClick={() => finishEditing("Изменения отменены.")}>Отмена</button>
            <button type="button" className="btn primary" ref={saveButton} disabled={save.busy} aria-busy={save.busy} data-testid="home-save"
              onClick={() => save.run(draft.layout, draft.baseline)}>{save.busy ? "Сохраняем…" : "Сохранить"}</button>
          </div>
        ) : (
          <div className="home-actions">
            <button type="button" className="btn" ref={openButton} disabled={!settings} onClick={startEditing} data-testid="home-customize">
              Настроить Главную
            </button>
            <AddMenu />
          </div>
        )}
      </div>

      {edit && <HomeLayoutTools layout={layout} edit={edit} saveButton={saveButton} />}
      {editing && <ErrorText error={save.error} />}
      <span className="sr-only" role="status" data-testid="move-result" aria-atomic="true">{announcement}</span>
      {!editing && <MonthReviewBanner />}
      {!editing && backup?.reminderDue && (
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
          <button className="btn" onClick={() => openSettings({ section: "vault" })}>
            Открыть резервные копии
          </button>
        </div>
      )}
      {!editing && vault?.verifyError && (
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
          <button className="btn" onClick={() => openSettings({ section: "vault" })}>
            Открыть резервные копии
          </button>
        </div>
      )}

      <HomeCardGrid layout={layout} childrenByBlock={blocks} overspendRef={setOverspendSlot} edit={edit} />
      {explain && (explain === "free" || explain === "balance" || (tileFrom && tileTo)) && (
        <ExplainDialog kind={explain} on={date} from={tileFrom ?? date} to={tileTo ?? date} onClose={() => setExplain(null)} />
      )}
    </section>
  );
}
