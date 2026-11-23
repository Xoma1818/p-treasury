import { useQuery } from "@tanstack/react-query";
import { LookMark, useCategoryMap } from "../components/CategoryMark";
import { CATEGORY_COLORS, colorVar, lookOf } from "../lib/categoryLook";
import { useModules } from "../lib/modules";
import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { ExportButton, useExport } from "../components/DataTools";
import { Compare } from "./Compare";
import { FxGain } from "./FxGain";
import { parseView, SavedViews } from "../components/SavedViews";
import { ErrorText } from "../components/Modal";
import { BaseMoney, Money } from "../components/Money";
import { ACCOUNT_TYPES, api, type CategoryItem, type CategoryKind, type MonthsReport, type ReportFilter, type ReportPeriodKind, type Period } from "../lib/api";
import { formatDate, monthTitle, shiftMonth, today } from "../lib/dates";
import { axisLabel, axisPad, netWorthScale } from "../lib/netWorth";
import { useAccounts, useCurrencies, useMonthOf, useSettings } from "../lib/queries";
import { type ReportContext, type TxnJump, useUi } from "../lib/store";
import { ScreenTitle } from "../components/SectionIcon";
import { SubscriptionsReport } from "../components/Subscriptions";
import { YearReviewReport } from "../components/YearReview";
import { Hint } from "../components/Hint";
import { NetWorthReport } from "../components/NetWorth";
import { TagReport } from "../components/Tags";
import { usePopup } from "../lib/usePopup";
import { FigureForm } from "../components/Figures";
import type { Figure, FigurePeriod } from "../lib/api";
import "./reportsOverview.css";

const M = BaseMoney;

/** П. 11 плана: четыре главных отчёта видны всегда, остальные — в «Ещё ▾».
 *  Открытый отчёт из «Ещё» показывается на месте этой кнопки. */
const MAIN_TABS: [Tab, string][] = [
  ["structure", "Структура"],
  ["months", "По месяцам"],
  ["compare", "Сравнение"],
  ["balances", "Остатки на дату"],
];
const MORE_TABS: [Tab, string][] = [
  ["fx", "Курсовая разница"],
  ["subs", "Подписки"],
  ["year", "Итоги года"],
  ["tag", "По тегу"],
  ["networth", "Чистые активы"],
];

function ReportTabs({ tab, onPick }: { tab: Tab; onPick: (t: Tab) => void }) {
  const { open, setOpen, ref } = usePopup();
  const modules = useModules();
  const moreTabs = MORE_TABS.filter(([t]) => t !== "subs" || modules.on("subs"));
  const more = moreTabs.find(([t]) => t === tab);
  return (
    <div className="tabs report-tabs" role="tablist" aria-label="Виды отчётов">
      {MAIN_TABS.map(([t, label]) => (
        <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "tab active" : "tab"} onClick={() => onPick(t)}>
          {label}
        </button>
      ))}
      <div className="tab-more" ref={ref}>
        <button
          role="tab"
          aria-selected={!!more}
          aria-haspopup="menu"
          aria-expanded={open}
          className={more ? "tab active" : "tab"}
          data-testid="more-tabs-toggle"
          onClick={() => setOpen(!open)}
        >
          {more ? more[1] : "Ещё"} <ChevronDown size={14} aria-hidden />
        </button>
        {open && (
          <div className="menu-pop" role="menu">
            {moreTabs.map(([t, label]) => (
              <button
                key={t}
                role="menuitem"
                className={t === tab ? "menu-item active" : "menu-item"}
                onClick={() => {
                  setOpen(false);
                  onPick(t);
                }}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

type Tab = ReportContext["tab"];
type OpenOperations = (filter: TxnJump, source: string) => void;

/** Сохранённый вид отчёта: вкладка и вид периода; период берётся текущий. */
interface ReportView {
  tab: Tab;
  kind: Kind;
  custom?: { start: string; end: string } | null;
}
type Kind = ReportContext["kind"];
const initialDetail = { filter: {}, categoryKind: "expense", expanded: [], tagId: "", balancesDate: null, comparison: undefined } satisfies Partial<ReportContext>;

const KINDS: [Kind, string][] = [
  ["month", "Месяц"],
  ["quarter", "Квартал"],
  ["year", "Год"],
  ["custom", "Произвольный"],
];
const STEP: Record<ReportPeriodKind, number> = { month: 1, quarter: 3, year: 12 };

function periodTitle(kind: Kind, p: Period) {
  const [y, m] = p.month.split("-").map(Number);
  if (kind === "month") return monthTitle(p.month);
  if (kind === "quarter") return `${Math.floor((m - 1) / 3) + 1} квартал ${y}`;
  if (kind === "year") return `${y} год`;
  return `${formatDate(p.start)} – ${formatDate(p.end)}`;
}

/** Экран «Отчёты»: структура, по месяцам, остатки. */
export function Reports() {
  const currentMonth = useMonthOf(today());
  const current = currentMonth.data;
  const [report, setReport] = useState<ReportContext>(() => {
    const { reportOrigin, reportTab } = useUi.getState();
    return reportOrigin ?? { ...initialDetail, tab: (reportTab as Tab | null) ?? "structure", kind: "month", anchor: null, custom: null };
  });
  const { tab, kind, anchor, custom } = report;
  const sectionRef = useRef<HTMLElement>(null);
  const returnSource = useRef(report.source);
  useEffect(() => {
    useUi.setState({ reportTab: null, reportOrigin: null });
    const section = sectionRef.current;
    if (!section || !returnSource.current) return;
    const selector = `[data-report-source="${CSS.escape(returnSource.current)}"]`;
    const source = section.querySelector<HTMLElement>(selector);
    if (source) {
      source.focus();
      return;
    }
    const tabButton = section.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    if (!tabButton) return;
    tabButton.focus();
    // Строка появится после запроса, если отчёт уже вышел из кеша.
    const observer = new MutationObserver(() => {
      const loaded = section.querySelector<HTMLElement>(selector);
      if (loaded && document.activeElement === tabButton) loaded.focus();
    });
    const cancel = () => observer.disconnect();
    observer.observe(section, { childList: true, subtree: true });
    tabButton.addEventListener("blur", cancel, { once: true });
    return () => {
      cancel();
      tabButton.removeEventListener("blur", cancel);
    };
  }, []);
  const update = (patch: Partial<ReportContext>) => setReport((r) => ({ ...r, ...patch }));
  const pickTab = (next: Tab) => {
    if (next !== tab) update({ ...initialDetail, tab: next });
  };
  const applyView = (v: ReportView) => update({
    ...(v.tab !== tab ? initialDetail : {}), tab: v.tab, kind: v.kind, anchor: null, custom: v.custom ?? null,
  });
  // Вид, открытый из бокового меню.
  const viewJump = useUi((s) => s.viewJump);
  useEffect(() => {
    if (viewJump?.kind !== "report") return;
    const params = parseView<ReportView>(viewJump.params);
    if (params) applyView(params);
    useUi.setState({ viewJump: null });
  }, [viewJump]);
  const month = anchor ?? current?.month;

  const fixed = useQuery({
    queryKey: ["reportPeriod", kind, month],
    queryFn: () => api.reportPeriod(kind as ReportPeriodKind, month!),
    enabled: !!month && kind !== "custom",
  });
  const reversedDates = kind === "custom" && !!custom && custom.start > custom.end;
  const selectedPeriod: Period | undefined =
    kind === "custom" ? (custom && month ? { month, ...custom } : current) : fixed.data;
  const period = reversedDates ? undefined : selectedPeriod;

  const summary = useQuery({
    queryKey: ["summary", period?.start, period?.end],
    queryFn: () => api.periodSummary(period!.start, period!.end),
    enabled: !!period,
  });
  const s = summary.data;
  const showTransactions = useUi((u) => u.showTransactions);
  const openOperations: OpenOperations = (filter, source) => showTransactions(filter, { ...report, anchor: month ?? null, source });
  const openPeriodOperations = (type: CategoryKind) => {
    if (period) openOperations({ dateFrom: period.start, dateTo: period.end, types: [type], counted: true }, `total-${type}`);
  };
  const exp = useExport(`Kazna — отчёт ${period ? `${period.start} — ${period.end}` : ""}`, async (path) => {
    if (!period) return;
    if (tab === "structure") return api.exportReport("categories", period.start, period.end, path, report.filter);
    // Первое число всегда входит в одноимённый бюджетный месяц.
    const [from, to] = monthsRange(kind, period);
    return api.exportReport("months", `${from}-01`, `${to}-01`, path, report.filter);
  });

  // Р14: «На Главную» — цифра по образцу открытого отчёта (вид, период, отбор).
  const [ctx, setCtx] = useState<Partial<Figure>>({});
  const [toHome, setToHome] = useState(false);
  const [sent, setSent] = useState(false);
  const draft = (): Partial<Figure> => {
    const measure = tab === "months" ? "saldo" : tab === "balances" || tab === "networth" ? "balance" : "expense";
    // Текущий месяц/квартал/год — «скользящий» период; прошлый или произвольный — свои даты.
    const now = today();
    const live = kind !== "custom" && !!period && period.start <= now && now <= period.end;
    const dates: Partial<Figure> =
      measure === "balance" || !period ? { period: "month" } : live ? { period: kind as FigurePeriod } : { period: "custom", from: period.start, to: period.end };
    return { measure, ...dates, ...(tab === "structure" || tab === "months" || tab === "tag" ? ctx : {}) };
  };
  // Что цифра повторить не может — предупредим в окне.
  const draftNote =
    tab === "compare" || tab === "fx" || tab === "subs" || tab === "year"
      ? "Этот отчёт цифрой не повторить: будут расходы за период. Поменяйте, что считать, если нужно другое."
      : tab === "networth"
        ? "Цифра покажет остаток на счетах общего баланса на сегодня, без долгов и истории."
        : tab === "balances" && period && period.end < today()
          ? "Цифра покажет остаток на сегодня, а не на конец выбранного периода."
          : undefined;
  // Сравнение, подписки и итоги года выбирают период сами.
  const ownPeriod = tab === "compare" || tab === "subs" || tab === "year" || tab === "networth";
  // Итоги периода сверху не нужны там, где отчёт показывает свои.
  const noTiles = ownPeriod || tab === "tag";
  const periodError = kind === "custom"
    ? (custom ? null : currentMonth.error)
    : (month ? fixed.error : currentMonth.error);
  return (
    <section ref={sectionRef} className="screen wide reports-overview">
      <div className="screen-head reports-heading">
        <ScreenTitle id="reports" />
        <div className="reports-actions">
          <button className="btn" disabled={!ownPeriod && reversedDates} onClick={() => (setSent(false), setToHome(true))} data-testid="report-to-home" title="Цифра этого отчёта карточкой на Главной">
            На Главную
          </button>
          {!ownPeriod && tab !== "balances" && tab !== "fx" && tab !== "tag" && (
            <ExportButton exp={exp} disabled={!period} title="Отчёт на вкладке в CSV или Excel" />
          )}
        </div>
      </div>
      {!ownPeriod && (
        <div className="card reports-period-panel">
          <h2 id="reports-period-title">Период отчёта</h2>
          <div className="period-picker" role="group" aria-labelledby="reports-period-title">
            <select name="periodKind" aria-label="Период" value={kind} onChange={(e) => {
              const k = e.target.value as Kind;
              update({ kind: k, ...(k === "custom" && period ? { custom: { start: period.start, end: period.end } } : {}) });
            }}>
              {KINDS.map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
            {kind === "custom" ? (
              <>
                <input type="date" name="reportFrom" aria-label="С даты" value={custom?.start ?? ""} onChange={(e) => e.target.value && update({ custom: { start: e.target.value, end: custom?.end ?? e.target.value } })} />
                <span className="muted">—</span>
                <input type="date" name="reportTo" aria-label="По дату" value={custom?.end ?? ""} onChange={(e) => e.target.value && update({ custom: { start: custom?.start ?? e.target.value, end: e.target.value } })} />
              </>
            ) : (
              month && (
                <div className="month-switch">
                  <button className="icon-btn" aria-label="Предыдущий период" onClick={() => update({ anchor: shiftMonth(month, -STEP[kind]) })}>
                    <ChevronLeft size={18} strokeWidth={1.75} aria-hidden="true" />
                  </button>
                  <div>
                    <div className="main" data-testid="report-period">
                      {period && periodTitle(kind, period)}
                    </div>
                    {period && (
                      <div className="sub">
                        {formatDate(period.start)} – {formatDate(period.end)}
                      </div>
                    )}
                  </div>
                  <button className="icon-btn" aria-label="Следующий период" onClick={() => update({ anchor: shiftMonth(month, STEP[kind]) })}>
                    <ChevronRight size={18} strokeWidth={1.75} aria-hidden="true" />
                  </button>
                </div>
              )
            )}
          </div>
        </div>
      )}
      {!ownPeriod && periodError && <p className="error reports-status" role="alert">Не удалось загрузить период. {String(periodError)}</p>}
      {!ownPeriod && reversedDates && <p className="error reports-status" role="alert">Выберите дату окончания не раньше даты начала.</p>}
      {!ownPeriod && !reversedDates && !period && !periodError && <p className="muted reports-status" role="status">Загружаем период…</p>}
      {sent && (
        <p className="ok" role="status" data-testid="report-sent-home">
          Цифра добавлена на Главную, в «Свои цифры».
        </p>
      )}
      {toHome && <FigureForm figure={null} draft={draft()} note={draftNote} onClose={() => setToHome(false)} onSaved={() => setSent(true)} />}
      {exp.done && (
        <p className="ok" data-testid="export-done">
          Выгружено: {exp.done}
        </p>
      )}
      <ErrorText error={exp.error} />

      {period && !noTiles && !s && (
        summary.error
          ? <p className="error reports-status" role="alert">Не удалось загрузить итоги. {String(summary.error)}</p>
          : <p className="muted reports-status" role="status">Загружаем итоги…</p>
      )}

      {s && !noTiles && (
        <section className="reports-summary" aria-labelledby="reports-summary-title">
          <h2 id="reports-summary-title">Итоги периода</h2>
          <div className="tiles reports-tiles">
            <div className="card tile" data-testid="report-income">
              <div className="tile-label">Доходы</div>
              <button type="button" data-report-source="total-income" className="tile-value tile-explain plus" title="Операции по доходам за период" onClick={() => openPeriodOperations("income")}>
                <M amount={s.income} />
                <span className="sr-only"> — открыть доходы за период</span>
              </button>
            </div>
            <div className="card tile" data-testid="report-expense">
              <div className="tile-label">Расходы</div>
              <button type="button" data-report-source="total-expense" className="tile-value tile-explain" title="Операции по расходам за период" onClick={() => openPeriodOperations("expense")}>
                <M amount={s.expense} />
                <span className="sr-only"> — открыть расходы и возвраты за период</span>
              </button>
            </div>
            <div className="card tile reports-balance" data-testid="report-balance">
              <div className="tile-label">Сальдо</div>
              <div className={s.income - s.expense < 0 ? "tile-value over" : "tile-value"}>
                <M amount={s.income - s.expense} signed />
              </div>
              {s.adjustments !== 0 && (
                <div className="hint">
                  Корректировки: <M amount={s.adjustments} signed /> (не входят)
                </div>
              )}
            </div>
            <div className="card tile" data-testid="savings-rate">
              <div className="tile-label">Норма сбережений</div>
              <div className="tile-value">{s.savingsRate == null ? <span className="muted">—</span> : `${s.savingsRate} %`}</div>
              <div className="hint">доля дохода, которая осталась</div>
            </div>
          </div>
        </section>
      )}
      {s && !noTiles && s.missingRates.length > 0 && (
        <div className="card hint warn">Нет курса для {s.missingRates.join(", ")}: такие операции не вошли. Курс вводится в Настройках.</div>
      )}
      {s && !noTiles && (
        <p className="hint">Доходы и расходы наверху включают все счета и теги. Нажмите на сумму, чтобы увидеть операции и доли распределённых покупок за период.</p>
      )}

      <section className="reports-detail" aria-labelledby="reports-detail-title">
        <h2 id="reports-detail-title">Детализация</h2>
        <SavedViews<ReportView>
          kind="report"
          current={{ tab, kind, custom: kind === "custom" ? custom : null }}
          onApply={applyView}
        />
        <ReportTabs tab={tab} onPick={pickTab} />

        {period && tab === "structure" && <Structure period={period} reportContext={report} update={update} openOperations={openOperations} onDraft={setCtx} />}
        {period && tab === "months" && <Months period={period} kind={kind} filter={report.filter} onFilter={(filter) => update({ filter })} openOperations={openOperations} onDraft={setCtx} />}
        {period && tab === "balances" && <Balances period={period} date={report.balancesDate} onDate={(balancesDate) => update({ balancesDate })} />}
        {tab === "compare" && <Compare restored={report.comparison} openOperations={(filter, source, comparison) =>
          showTransactions(filter, { ...report, anchor: month ?? null, comparison, source })} />}
        {period && tab === "fx" && <FxGain period={period} />}
        {tab === "subs" && <SubscriptionsReport openOperations={openOperations} showHidden={report.showHiddenSubscriptions ?? false} setShowHidden={(value) => update({ showHiddenSubscriptions: value })} />}
        {tab === "year" && <YearReviewReport />}
        {period && tab === "tag" && <TagReport period={period} tagId={report.tagId} onTag={(tagId) => update({ tagId })} openOperations={openOperations} onDraft={setCtx} />}
        {tab === "networth" && <NetWorthReport />}
      </section>
    </section>
  );
}

/** Р12: вид графика в отчётах запоминается в окне. */
const CHART_KEY = "kazna.reportCharts";
type ChartKinds = { structure: "bars" | "donut"; months: "bars" | "line" };

function loadCharts(): ChartKinds {
  try {
    const v = JSON.parse(localStorage.getItem(CHART_KEY) || "{}");
    return { structure: v.structure === "donut" ? "donut" : "bars", months: v.months === "line" ? "line" : "bars" };
  } catch {
    return { structure: "bars", months: "bars" };
  }
}

function useChartKind<K extends keyof ChartKinds>(key: K): [ChartKinds[K], (v: ChartKinds[K]) => void] {
  const [v, setV] = useState<ChartKinds[K]>(() => loadCharts()[key]);
  return [
    v,
    (next) => {
      setV(next);
      try {
        localStorage.setItem(CHART_KEY, JSON.stringify({ ...loadCharts(), [key]: next }));
      } catch {
        /* без запоминания */
      }
    },
  ];
}

/** Р12: выбор вида графика — несколько кнопок. */
function ChartKindTabs<T extends string>({ value, options, onChange, testid }: { value: T; options: [T, string][]; onChange: (v: T) => void; testid: string }) {
  return (
    <div className="tabs small motion-segments" role="group" aria-label="Вид графика" data-testid={testid}>
      {options.map(([k, label]) => (
        <button key={k} type="button" className={value === k ? "tab active" : "tab"} aria-pressed={value === k} onClick={() => onChange(k)} data-testid={`${testid}-${k}`}>
          {label}
        </button>
      ))}
    </div>
  );
}

/** Р12: отбор отчёта по счёту и тегу. */
function ReportFilterBar({ value, onChange }: { value: ReportFilter; onChange: (f: ReportFilter) => void }) {
  const accounts = useAccounts().data ?? [];
  const tags = useQuery({ queryKey: ["tags"], queryFn: api.listTags }).data ?? [];
  return (
    <div className="filters-row report-filter" data-testid="report-filter">
      <select name="reportAccount" aria-label="Счёт" value={value.accountId ?? ""} onChange={(e) => onChange({ ...value, accountId: e.target.value || undefined })}>
        <option value="">Все счета</option>
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>
      {tags.length > 0 && (
        <select name="reportTag" aria-label="Тег" value={value.tagId ?? ""} onChange={(e) => onChange({ ...value, tagId: e.target.value || undefined })}>
          <option value="">Все теги</option>
          {tags.map((t) => (
            <option key={t.id} value={t.id}>
              #{t.name}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

function Structure({ period, reportContext, update, openOperations, onDraft }: {
  period: Period; reportContext: ReportContext; update: (patch: Partial<ReportContext>) => void;
  openOperations: OpenOperations; onDraft: (d: Partial<Figure>) => void;
}) {
  const { categoryKind: kind, expanded, filter } = reportContext;
  useEffect(() => onDraft?.({ measure: kind, accountId: filter.accountId ?? null, tagId: filter.tagId ?? null }), [kind, filter, onDraft]);
  const [chart, setChart] = useChartKind("structure");
  const report = useQuery({
    queryKey: ["reportByCategory", kind, period.start, period.end, filter],
    queryFn: () => api.reportByCategory(kind, period.start, period.end, filter),
  });
  const catMap = useCategoryMap();
  const go = (c: CategoryItem) => openOperations({
    ...filter, categoryId: c.categoryId, dateFrom: period.start, dateTo: period.end, types: [kind], counted: true,
  }, `category-${c.categoryId}`);
  const r = report.data;
  const max = r?.items[0]?.amount ?? 0;
  const toggle = (id: string) => update({ expanded: expanded.includes(id) ? expanded.filter((c) => c !== id) : [...expanded, id] });

  const row = (c: CategoryItem, parent?: CategoryItem) => (
    <li key={parent ? `c-${c.categoryId}` : c.categoryId} className={parent ? "cat-row child" : "cat-row"} data-testid={parent ? "cat-child" : "cat-row"} data-category={c.name}>
      <span className="cat-name">
        {!parent && c.children.length > 0 ? (
          <button className="icon-btn small" aria-label={expanded.includes(c.categoryId) ? "Свернуть" : "Раскрыть"} aria-expanded={expanded.includes(c.categoryId)} onClick={() => toggle(c.categoryId)}>
            {expanded.includes(c.categoryId) ? <ChevronDown size={14} strokeWidth={2} aria-hidden="true" /> : <ChevronRight size={14} strokeWidth={2} aria-hidden="true" />}
          </button>
        ) : (
          <span className="icon-gap" />
        )}
        {parent?.categoryId === c.categoryId ? (
          <span><LookMark look={lookOf(c.categoryId, catMap)} />{c.name}</span>
        ) : (
          <button type="button" className="link cat-link" data-report-source={`category-${c.categoryId}`} title="Показать связанные операции" onClick={() => go(c)}>
            <LookMark look={lookOf(c.categoryId, catMap)} />
            {c.name}
          </button>
        )}
      </span>
      <span className="cat-bar" title={`${c.name}: ${c.percent} %`}>
        <span
          className={kind === "income" ? "bar-fill income" : "bar-fill"}
          style={{ width: `${max ? Math.max((c.amount / max) * 100, 0.5) : 0}%`, ...(lookOf(c.categoryId, catMap).color ? { background: colorVar(lookOf(c.categoryId, catMap).color!) } : {}) }}
        />
      </span>
      <span className="percent" data-testid="share">
        {c.percent} %
      </span>
      <span className="num">
        <M amount={c.amount} />
      </span>
    </li>
  );

  return (
    <div className="card">
      <div className="screen-head">
        <h2>{kind === "expense" ? "Расходы по категориям" : "Доходы по категориям"}</h2>
        <div className="tabs small motion-segments" role="group" aria-label="Тип операций">
          {(["expense", "income"] as CategoryKind[]).map((k) => (
            <button key={k} className={kind === k ? "tab active" : "tab"} aria-pressed={kind === k} onClick={() => update({ categoryKind: k })}>
              {k === "expense" ? "Расходы" : "Доходы"}
            </button>
          ))}
        </div>
      </div>
      <div className="filters-row reports-controls">
        <ReportFilterBar value={filter} onChange={(value) => update({ filter: value })} />
        <span className="spacer" />
        <ChartKindTabs value={chart} onChange={setChart} testid="structure-chart" options={[["bars", "Полосы"], ["donut", "Доли"]]} />
      </div>
      {report.isPending && <p className="muted reports-status" role="status">Загружаем разбивку по категориям…</p>}
      {report.error && <p className="error">{String(report.error)}</p>}
      {r && r.items.length === 0 && <p className="muted">За этот период операций нет.</p>}
      {r && r.items.length > 0 && (
        <>
          {chart === "donut" && <Donut items={r.items} colorOf={(c, i) => { const col = lookOf(c.categoryId, catMap).color; return col ? colorVar(col) : colorVar(CATEGORY_COLORS[i % CATEGORY_COLORS.length]); }} onPick={go} />}
          <ul className="cat-report" data-testid="structure">
            {r.items.map((c) => [row(c), ...(expanded.includes(c.categoryId) ? c.children.map((x) => row(x, c)) : [])])}
          </ul>
          <div className="table-foot muted">
            Итого: <M amount={r.total} />. Категории открывают операции с выбранными счётом и тегом.
          </div>
        </>
      )}
    </div>
  );
}

/** Р12 «Доли»: кольцо по категориям верхнего уровня; щелчок — операции категории. */
function Donut({ items: all, colorOf, onPick }: { items: CategoryItem[]; colorOf: (c: CategoryItem, i: number) => string; onPick: (c: CategoryItem) => void }) {
  const [hover, setHover] = useState<number | null>(null);
  // Доли — только категорий с тратами больше нуля: возврат без покупки в периоде даёт
  // отрицательную сумму, и дуга пошла бы назад, перекрыв соседние.
  const items = all.filter((c) => c.amount > 0);
  const total = items.reduce((s, c) => s + c.amount, 0);
  const share = (c: CategoryItem) => (total > 0 ? Math.round((c.amount * 100) / total) : 0);
  if (items.length === 0) return null;
  const R = 70;
  const r0 = 44;
  const C = 90;
  let acc = 0;
  const arcs = items.map((c, i) => {
    const a0 = (acc / (total || 1)) * Math.PI * 2;
    acc += c.amount;
    const a1 = (acc / (total || 1)) * Math.PI * 2;
    const pt = (a: number, rad: number) => `${(C + rad * Math.sin(a)).toFixed(2)} ${(C - rad * Math.cos(a)).toFixed(2)}`;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    // Полный круг одной категорией — два полукруга.
    const d =
      items.length === 1
        ? `M${pt(0, R)} A${R} ${R} 0 1 1 ${pt(Math.PI, R)} A${R} ${R} 0 1 1 ${pt(0, R)} M${pt(0, r0)} A${r0} ${r0} 0 1 0 ${pt(Math.PI, r0)} A${r0} ${r0} 0 1 0 ${pt(0, r0)}Z`
        : `M${pt(a0, R)} A${R} ${R} 0 ${large} 1 ${pt(a1, R)} L${pt(a1, r0)} A${r0} ${r0} 0 ${large} 0 ${pt(a0, r0)}Z`;
    return { c, i, d };
  });
  const h = hover != null ? items[hover] : null;
  return (
    <div className="share-donut" data-testid="structure-donut" onMouseLeave={() => setHover(null)}>
      <svg viewBox="0 0 180 180" role="img" aria-label="Доли категорий">
        {arcs.map(({ c, i, d }) => (
          <path key={c.categoryId} d={d} fill={colorOf(c, i)} fillRule="evenodd" className={hover === i ? "donut-arc active" : "donut-arc"} onMouseEnter={() => setHover(i)} onClick={() => onPick(c)}>
            <title>
              {c.name}: {share(c)} %
            </title>
          </path>
        ))}
        <text x={C} y={C - 2} textAnchor="middle" className="donut-main">
          {h ? `${share(h)} %` : "100 %"}
        </text>
        <text x={C} y={C + 14} textAnchor="middle" className="donut-sub">
          {h ? h.name.slice(0, 16) : "всего"}
        </text>
      </svg>
      <ul className="share-legend">
        {arcs.slice(0, 8).map(({ c, i }) => (
          <li key={c.categoryId} onMouseEnter={() => setHover(i)}>
            <i className="swatch" style={{ background: colorOf(c, i) }} /> {c.name} <span className="muted">{share(c)} %</span>
          </li>
        ))}
        {items.length > 8 && <li className="muted">и ещё {items.length - 8}</li>}
      </ul>
    </div>
  );
}

function monthsRange(kind: Kind, period: Period): [string, string] {
  if (kind === "month") return [shiftMonth(period.month, -11), period.month];
  if (kind === "custom") return [period.start.slice(0, 7), period.end.slice(0, 7)];
  // Квартал и год: месяцы, которые заканчиваются внутри периода.
  const months = kind === "quarter" ? 3 : 12;
  const [y, m] = period.month.split("-").map(Number);
  const first = kind === "quarter" ? Math.floor((m - 1) / 3) * 3 + 1 : 1;
  const from = `${y}-${String(first).padStart(2, "0")}`;
  return [from, shiftMonth(from, months - 1)];
}

function Months({ period, kind, filter, onFilter, openOperations, onDraft }: {
  period: Period; kind: Kind; filter: ReportFilter; onFilter: (filter: ReportFilter) => void;
  openOperations: OpenOperations; onDraft: (d: Partial<Figure>) => void;
}) {
  const [from, to] = monthsRange(kind, period);
  useEffect(() => onDraft?.({ accountId: filter.accountId ?? null, tagId: filter.tagId ?? null }), [filter, onDraft]);
  const [chart, setChart] = useChartKind("months");
  const report = useQuery({ queryKey: ["reportByMonth", from, to, filter], queryFn: () => api.reportByMonth(from, to, filter) });
  const openMonth = (month: Period, type?: CategoryKind) => openOperations({
    ...filter, dateFrom: month.start, dateTo: month.end, types: type ? [type] : undefined, counted: type ? true : undefined,
  }, `month-${month.month}-${type ?? "all"}`);
  const r = report.data;
  return (
    <div className="card">
      <h2>
        Доходы и расходы по месяцам: {monthTitle(from).toLowerCase()} – {monthTitle(to).toLowerCase()}
      </h2>
      <div className="filters-row reports-controls">
        <ReportFilterBar value={filter} onChange={onFilter} />
        <span className="spacer" />
        <ChartKindTabs value={chart} onChange={setChart} testid="months-chart" options={[["bars", "Столбцы"], ["line", "Линия"]]} />
      </div>
      {report.isPending && <p className="muted reports-status" role="status">Загружаем данные по месяцам…</p>}
      {report.error && <p className="error">{String(report.error)}</p>}
      {r && (
        <>
          <MonthsChart r={r} line={chart === "line"} />
          <table className="table months-table" data-testid="months">
            <thead>
              <tr>
                <th>Месяц</th>
                <th className="num">Доходы</th>
                <th className="num">Расходы</th>
                <th className="num">Сальдо</th>
                <th className="num">Норма сбережений</th>
              </tr>
            </thead>
            <tbody>
              {r.months.map((m) => (
                <tr
                  key={m.period.month}
                  className="clickable"
                  data-testid="month-row"
                  data-month={m.period.month}
                  title="Показать все операции по дате записи за месяц"
                  onClick={() => openMonth(m.period)}
                >
                  <td className="main">
                    <button type="button" className="link" data-report-source={`month-${m.period.month}-all`} title="Показать все операции по дате записи за месяц" onClick={(e) => {
                      e.stopPropagation();
                      openMonth(m.period);
                    }}>
                      {monthTitle(m.period.month)}
                    </button>
                  </td>
                  <td className="num plus">
                    <button type="button" className="link" data-report-source={`month-${m.period.month}-income`} title="Показать операции по доходам" onClick={(e) => {
                      e.stopPropagation();
                      openMonth(m.period, "income");
                    }}>
                      <M amount={m.income} />
                      <span className="sr-only"> — открыть доходы за {monthTitle(m.period.month)}</span>
                    </button>
                  </td>
                  <td className="num">
                    <button type="button" className="link" data-report-source={`month-${m.period.month}-expense`} title="Показать операции по расходам" onClick={(e) => {
                      e.stopPropagation();
                      openMonth(m.period, "expense");
                    }}>
                      <M amount={m.expense} />
                      <span className="sr-only"> — открыть расходы и возвраты за {monthTitle(m.period.month)}</span>
                    </button>
                  </td>
                  <td className={m.balance < 0 ? "num over" : "num"}>
                    <M amount={m.balance} signed />
                  </td>
                  <td className="num">{m.savingsRate == null ? "—" : `${m.savingsRate} %`}</td>
                </tr>
              ))}
              <tr className="total-row">
                <td className="main">Итого</td>
                <td className="num plus">
                  <M amount={r.income} />
                </td>
                <td className="num">
                  <M amount={r.expense} />
                </td>
                <td className={r.balance < 0 ? "num over" : "num"}>
                  <M amount={r.balance} signed />
                </td>
                <td className="num" data-testid="months-savings-rate">
                  {r.savingsRate == null ? "—" : `${r.savingsRate} %`}
                </td>
              </tr>
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

const W = 900;
const H = 220;
const PAD_B = 24;

/** Столбцы «доходы / расходы» по месяцам; ось одна, подписи в тексте, подсказка при наведении. */
export function MonthsChart({ r, line }: { r: MonthsReport; line?: boolean }) {
  const [hover, setHover] = useState<number | null>(null);
  const settings = useSettings().data;
  const minorUnits = useCurrencies().data?.find(c => c.code === r.baseCurrency)?.minorUnits;
  const { min, max, step } = netWorthScale(r.months.flatMap(m => [m.income, m.expense]), 3);
  const ticks = Array.from({ length: Math.round((max - min) / step) + 1 }, (_, i) => min + i * step);
  const short = (v: number) => !settings || settings.hide_amounts === "1" ? "•••" : minorUnits == null ? "—" : axisLabel(v, minorUnits);
  const PAD_L = axisPad(ticks.map(short));
  const plotW = W - PAD_L - 8;
  const plotH = H - PAD_B - 12;
  const slot = plotW / r.months.length;
  const barW = Math.min(18, slot * 0.38);
  const y = (v: number) => 12 + plotH - ((v - min) / (max - min)) * plotH;

  return (
    <div className="chart" onMouseLeave={() => setHover(null)}>
      <div className="legend">
        <span>
          <i className="swatch income" /> Доходы
        </span>
        <span>
          <i className="swatch expense" /> Расходы
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Доходы и расходы по месяцам">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD_L} x2={W - 8} y1={y(t)} y2={y(t)} className="grid" />
            <text x={PAD_L - 8} y={y(t) + 4} className="axis" textAnchor="end">
              {short(t)}
            </text>
          </g>
        ))}
        {line && (
          <>
            <path d={r.months.map((m, i) => `${i ? "L" : "M"}${(PAD_L + slot * i + slot / 2).toFixed(1)} ${y(m.income).toFixed(1)}`).join(" ")} className="line-income" data-testid="months-line" />
            <path d={r.months.map((m, i) => `${i ? "L" : "M"}${(PAD_L + slot * i + slot / 2).toFixed(1)} ${y(m.expense).toFixed(1)}`).join(" ")} className="line-expense" />
          </>
        )}
        {r.months.map((m, i) => {
          const cx = PAD_L + slot * i + slot / 2;
          return (
            <g key={m.period.month} onMouseEnter={() => setHover(i)}>
              <rect x={cx - slot / 2} y={0} width={slot} height={H} className={hover === i ? "hit active" : "hit"} />
              {!line && <path d={bar(cx - barW - 1, barW, y(m.income), y(0))} className="bar-income" style={{ "--i": i } as React.CSSProperties} />}
              {!line && <path d={bar(cx + 1, barW, y(m.expense), y(0))} className="bar-expense" style={{ "--i": i } as React.CSSProperties} />}
              {line && <circle cx={cx} cy={y(m.income)} r={hover === i ? 4.5 : 3} className="dot-income" />}
              {line && <circle cx={cx} cy={y(m.expense)} r={hover === i ? 4.5 : 3} className="dot-expense" />}
              <text x={cx} y={H - 6} className="axis" textAnchor="middle">
                {monthTitle(m.period.month).slice(0, 3)}
              </text>
            </g>
          );
        })}
      </svg>
      {hover != null && (
        <div className="tooltip" style={{ left: `${((PAD_L + slot * hover + slot / 2) / W) * 100}%` }}>
          <div className="main">{monthTitle(r.months[hover].period.month)}</div>
          <div>
            <i className="swatch income" /> Доходы <M amount={r.months[hover].income} />
          </div>
          <div>
            <i className="swatch expense" /> Расходы <M amount={r.months[hover].expense} />
          </div>
          <div className="muted">
            Сальдо <M amount={r.months[hover].balance} signed />
          </div>
        </div>
      )}
    </div>
  );
}

/** Свободный конец столбца скруглён по обе стороны нулевой оси. */
function bar(x: number, w: number, top: number, base: number) {
  const h = base - top;
  if (h === 0) return "";
  const rr = Math.min(4, w / 2, Math.abs(h));
  const corner = top + Math.sign(h) * rr;
  return `M${x},${base}V${corner}Q${x},${top} ${x + rr},${top}H${x + w - rr}Q${x + w},${top} ${x + w},${corner}V${base}Z`;
}

function Balances({ period, date: selected, onDate }: { period: Period; date: string | null; onDate: (date: string) => void }) {
  const t = today();
  const date = selected ?? (period.end < t ? period.end : t);
  const report = useQuery({ queryKey: ["reportBalances", date], queryFn: () => api.reportBalances(date), enabled: !!date });
  const showTransactions = useUi((u) => u.showTransactions);
  const r = report.data;
  return (
    <div className="card">
      <div className="screen-head">
        <h2>
          Остатки по счетам
          <Hint of="reports.balances" />
        </h2>
        <label className="check">
          на дату
          <input type="date" name="balancesDate" value={date} onChange={(e) => e.target.value && onDate(e.target.value)} />
        </label>
      </div>
      {report.error && <p className="error">{String(report.error)}</p>}
      {r && r.rows.length === 0 && <p className="muted">На эту дату счетов ещё не было.</p>}
      {r && r.rows.length > 0 && (
        <table className="table" data-testid="balances">
          <tbody>
            {r.rows.map((a) => (
              <tr
                key={a.accountId}
                className={a.archived ? "clickable archived" : "clickable"}
                data-testid="balance-row"
                data-account={a.name}
                title="Показать операции счёта до этой даты"
                onClick={() => showTransactions({ accountId: a.accountId, dateTo: date })}
              >
                <td>
                  <div className="main">{a.name}</div>
                  <div className="sub">
                    {ACCOUNT_TYPES[a.type as keyof typeof ACCOUNT_TYPES] ?? a.type}
                    {!a.includeInTotal && " · не в общем балансе"}
                  </div>
                </td>
                <td className="num">
                  <Money amount={a.balance} symbol={a.currencySymbol} minorUnits={a.minorUnits} />
                </td>
                <td className="num muted">
                  {a.currencyCode !== r.baseCurrency && (a.baseValue == null ? "нет курса" : <M amount={a.baseValue} />)}
                </td>
              </tr>
            ))}
            <tr className="total-row">
              <td className="main">Итого в общем балансе</td>
              <td className="num" data-testid="balances-total">
                <M amount={r.total} />
              </td>
              <td />
            </tr>
          </tbody>
        </table>
      )}
      {r && r.missingRates.length > 0 && <p className="hint warn">Нет курса для {r.missingRates.join(", ")} на эту дату: такие счета не вошли в итог.</p>}
    </div>
  );
}
