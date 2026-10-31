import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { useExport } from "../components/DataTools";
import { Compare } from "./Compare";
import { FxGain } from "./FxGain";
import { parseView, SavedViews } from "../components/SavedViews";
import { ErrorText } from "../components/Modal";
import { BaseMoney, Money } from "../components/Money";
import { ACCOUNT_TYPES, api, type CategoryItem, type CategoryKind, type MonthsReport, type ReportPeriodKind, type Period } from "../lib/api";
import { formatDate, monthTitle, shiftMonth, today } from "../lib/dates";
import { formatAmount } from "../lib/money";
import { useMonthOf, useSettings } from "../lib/queries";
import { useUi } from "../lib/store";
import { ScreenTitle } from "../components/SectionIcon";
import { SubscriptionsReport } from "../components/Subscriptions";
import { YearReviewReport } from "../components/YearReview";
import { Hint } from "../components/Hint";
import { NetWorthReport } from "../components/NetWorth";
import { TagReport } from "../components/Tags";

const M = BaseMoney;

type Tab = "structure" | "months" | "balances" | "compare" | "fx" | "subs" | "year" | "tag" | "networth";

/** Сохранённый вид отчёта: вкладка и вид периода; период берётся текущий. */
interface ReportView {
  tab: Tab;
  kind: Kind;
  custom?: { start: string; end: string } | null;
}
type Kind = ReportPeriodKind | "custom";

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

/** Экран «Отчёты»: структура, по месяцам, остатки. Каждая цифра ведёт к своим операциям. */
export function Reports() {
  const current = useMonthOf(today()).data;
  const [tab, setTab] = useState<Tab>(() => {
    const t = useUi.getState().reportTab as Tab | null;
    if (t) useUi.setState({ reportTab: null });
    return t ?? "structure";
  });
  const [kind, setKind] = useState<Kind>("month");
  const [anchor, setAnchor] = useState<string | null>(null);
  const [custom, setCustom] = useState<{ start: string; end: string } | null>(null);
  const applyView = (v: ReportView) => {
    setTab(v.tab);
    setKind(v.kind);
    setAnchor(null);
    if (v.custom) setCustom(v.custom);
  };
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
  const period: Period | undefined =
    kind === "custom" ? (custom && month ? { month, ...custom } : current) : fixed.data;

  const summary = useQuery({
    queryKey: ["summary", period?.start, period?.end],
    queryFn: () => api.periodSummary(period!.start, period!.end),
    enabled: !!period,
  });
  const s = summary.data;
  const showTransactions = useUi((u) => u.showTransactions);
  const all = () => period && showTransactions({ dateFrom: period.start, dateTo: period.end });
  const exp = useExport(`P-Treasury — отчёт ${period ? `${period.start} — ${period.end}` : ""}`, async (path) => {
    if (!period) return;
    if (tab === "structure") return api.exportReport("categories", period.start, period.end, path);
    // 28-е число всегда внутри своего расчётного месяца при любом «первом дне месяца» (1–28).
    const [from, to] = monthsRange(kind, period);
    return api.exportReport("months", `${from}-28`, `${to}-28`, path);
  });

  // Сравнение, подписки и итоги года выбирают период сами.
  const ownPeriod = tab === "compare" || tab === "subs" || tab === "year" || tab === "networth";
  // Итоги периода сверху не нужны там, где отчёт показывает свои.
  const noTiles = ownPeriod || tab === "tag";
  return (
    <section className="screen wide">
      <div className="screen-head">
        <ScreenTitle id="reports" />
        {!ownPeriod && (
        <div className="period-picker">
          <select name="periodKind" aria-label="Период" value={kind} onChange={(e) => {
            const k = e.target.value as Kind;
            if (k === "custom" && period) setCustom({ start: period.start, end: period.end });
            setKind(k);
          }}>
            {KINDS.map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
          {kind === "custom" ? (
            <>
              <input type="date" name="reportFrom" aria-label="С даты" value={custom?.start ?? ""} onChange={(e) => e.target.value && setCustom((c) => ({ start: e.target.value, end: c?.end ?? e.target.value }))} />
              <span className="muted">—</span>
              <input type="date" name="reportTo" aria-label="По дату" value={custom?.end ?? ""} onChange={(e) => e.target.value && setCustom((c) => ({ start: c?.start ?? e.target.value, end: e.target.value }))} />
            </>
          ) : (
            month && (
              <div className="month-switch">
                <button className="icon-btn" aria-label="Предыдущий период" onClick={() => setAnchor(shiftMonth(month, -STEP[kind]))}>
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
                <button className="icon-btn" aria-label="Следующий период" onClick={() => setAnchor(shiftMonth(month, STEP[kind]))}>
                  <ChevronRight size={18} strokeWidth={1.75} aria-hidden="true" />
                </button>
              </div>
            )
          )}
          {tab !== "balances" && tab !== "fx" && tab !== "tag" && (
            <button className="btn" onClick={exp.run} aria-busy={exp.busy} data-done={exp.done || undefined} disabled={exp.busy || !period} title="Отчёт на вкладке в Excel или CSV">
              Выгрузить
            </button>
          )}
        </div>
        )}
      </div>
      {exp.done && (
        <p className="ok" data-testid="export-done">
          Выгружено: {exp.done}
        </p>
      )}
      <ErrorText error={exp.error} />

      {s && !noTiles && (
        <div className="tiles">
          <div className="card tile clickable" data-testid="report-income" onClick={all}>
            <div className="tile-label">Доходы</div>
            <div className="tile-value plus">
              <M amount={s.income} />
            </div>
          </div>
          <div className="card tile clickable" data-testid="report-expense" onClick={all}>
            <div className="tile-label">Расходы</div>
            <div className="tile-value">
              <M amount={s.expense} />
            </div>
          </div>
          <div className="card tile" data-testid="report-balance">
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
      )}
      {s && !noTiles && s.missingRates.length > 0 && (
        <div className="card hint warn">Нет курса для {s.missingRates.join(", ")}: такие операции не вошли. Курс вводится в Настройках.</div>
      )}

      <SavedViews<ReportView>
        kind="report"
        current={{ tab, kind, custom: kind === "custom" ? custom : null }}
        onApply={applyView}
      />
      <div className="tabs report-tabs" role="tablist">
        {(
          [
            ["structure", "Структура"],
            ["months", "По месяцам"],
            ["balances", "Остатки на дату"],
            ["compare", "Сравнение"],
            ["fx", "Курсовая разница"],
            ["subs", "Подписки"],
            ["year", "Итоги года"],
            ["tag", "По тегу"],
            ["networth", "Чистые активы"],
          ] as [Tab, string][]
        ).map(([t, label]) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "tab active" : "tab"} onClick={() => setTab(t)}>
            {label}
          </button>
        ))}
      </div>

      {period && tab === "structure" && <Structure period={period} />}
      {period && tab === "months" && <Months period={period} kind={kind} />}
      {period && tab === "balances" && <Balances period={period} />}
      {tab === "compare" && <Compare />}
      {period && tab === "fx" && <FxGain period={period} />}
      {tab === "subs" && <SubscriptionsReport />}
      {tab === "year" && <YearReviewReport />}
      {period && tab === "tag" && <TagReport period={period} />}
      {tab === "networth" && <NetWorthReport />}
    </section>
  );
}

function Structure({ period }: { period: Period }) {
  const [kind, setKind] = useState<CategoryKind>("expense");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const report = useQuery({
    queryKey: ["reportByCategory", kind, period.start, period.end],
    queryFn: () => api.reportByCategory(kind, period.start, period.end),
  });
  const showTransactions = useUi((u) => u.showTransactions);
  const go = (c: CategoryItem) => showTransactions({ categoryId: c.categoryId, dateFrom: period.start, dateTo: period.end });
  const r = report.data;
  const max = r?.items[0]?.amount ?? 0;
  const toggle = (id: string) => setOpen((o) => {
    const n = new Set(o);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });

  const row = (c: CategoryItem, child = false) => (
    <li key={child ? `c-${c.categoryId}` : c.categoryId} className={child ? "cat-row child" : "cat-row"} data-testid={child ? "cat-child" : "cat-row"} data-category={c.name}>
      <span className="cat-name">
        {!child && c.children.length > 0 ? (
          <button className="icon-btn small" aria-label={open.has(c.categoryId) ? "Свернуть" : "Раскрыть"} aria-expanded={open.has(c.categoryId)} onClick={() => toggle(c.categoryId)}>
            {open.has(c.categoryId) ? <ChevronDown size={14} strokeWidth={2} aria-hidden="true" /> : <ChevronRight size={14} strokeWidth={2} aria-hidden="true" />}
          </button>
        ) : (
          <span className="icon-gap" />
        )}
        <button className="link cat-link" title="Показать операции" onClick={() => go(c)}>
          {c.name}
        </button>
      </span>
      <span className="cat-bar" title={`${c.name}: ${c.percent} %`}>
        <span className={kind === "income" ? "bar-fill income" : "bar-fill"} style={{ width: `${max ? Math.max((c.amount / max) * 100, 0.5) : 0}%` }} />
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
        <div className="tabs small">
          {(["expense", "income"] as CategoryKind[]).map((k) => (
            <button key={k} className={kind === k ? "tab active" : "tab"} onClick={() => setKind(k)}>
              {k === "expense" ? "Расходы" : "Доходы"}
            </button>
          ))}
        </div>
      </div>
      {report.error && <p className="error">{String(report.error)}</p>}
      {r && r.items.length === 0 && <p className="muted">За этот период операций нет.</p>}
      {r && r.items.length > 0 && (
        <>
          <ul className="cat-report" data-testid="structure">
            {r.items.map((c) => [row(c), ...(open.has(c.categoryId) ? c.children.map((x) => row(x, true)) : [])])}
          </ul>
          <div className="table-foot muted">
            Итого: <M amount={r.total} />. Нажмите на категорию, чтобы увидеть её операции.
          </div>
        </>
      )}
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

function Months({ period, kind }: { period: Period; kind: Kind }) {
  const [from, to] = monthsRange(kind, period);
  const report = useQuery({ queryKey: ["reportByMonth", from, to], queryFn: () => api.reportByMonth(from, to) });
  const showTransactions = useUi((u) => u.showTransactions);
  const r = report.data;
  return (
    <div className="card">
      <h2>
        Доходы и расходы по месяцам: {monthTitle(from).toLowerCase()} – {monthTitle(to).toLowerCase()}
      </h2>
      {report.error && <p className="error">{String(report.error)}</p>}
      {r && (
        <>
          <MonthsChart r={r} />
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
                  title="Показать операции месяца"
                  onClick={() => showTransactions({ dateFrom: m.period.start, dateTo: m.period.end })}
                >
                  <td className="main">{monthTitle(m.period.month)}</td>
                  <td className="num plus">
                    <M amount={m.income} />
                  </td>
                  <td className="num">
                    <M amount={m.expense} />
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
const PAD_L = 56;
const PAD_B = 24;

/** Столбцы «доходы / расходы» по месяцам; ось одна, подписи в тексте, подсказка при наведении. */
export function MonthsChart({ r }: { r: MonthsReport }) {
  const [hover, setHover] = useState<number | null>(null);
  const hidden = useSettings().data?.hide_amounts === "1";
  const max = Math.max(...r.months.map((m) => Math.max(m.income, m.expense)), 1);
  const nice = niceMax(max);
  const plotW = W - PAD_L - 8;
  const plotH = H - PAD_B - 12;
  const slot = plotW / r.months.length;
  const barW = Math.min(18, (slot - 10) / 2);
  const y = (v: number) => 12 + plotH - (v / nice) * plotH;
  const ticks = [0, nice / 2, nice];
  // Подписи оси в тысячах: «50 тыс.».
  const short = (v: number) => (hidden ? "•••" : v === 0 ? "0" : `${formatAmount(Math.round(v / 1000), 2)} тыс.`);

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
        {r.months.map((m, i) => {
          const cx = PAD_L + slot * i + slot / 2;
          return (
            <g key={m.period.month} onMouseEnter={() => setHover(i)}>
              <rect x={cx - slot / 2} y={0} width={slot} height={H} className={hover === i ? "hit active" : "hit"} />
              <path d={bar(cx - barW - 1, barW, y(m.income), y(0))} className="bar-income" style={{ "--i": i } as React.CSSProperties} />
              <path d={bar(cx + 1, barW, y(m.expense), y(0))} className="bar-expense" style={{ "--i": i } as React.CSSProperties} />
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

/** Столбец со скруглённым верхом, прижатый к оси. */
function bar(x: number, w: number, top: number, base: number) {
  const h = base - top;
  if (h <= 0) return "";
  const rr = Math.min(4, w / 2, h);
  return `M${x},${base}V${top + rr}Q${x},${top} ${x + rr},${top}H${x + w - rr}Q${x + w},${top} ${x + w},${top + rr}V${base}Z`;
}

function niceMax(v: number) {
  const exp = 10 ** Math.floor(Math.log10(v));
  for (const k of [1, 2, 2.5, 5, 10]) if (k * exp >= v) return k * exp;
  return 10 * exp;
}

function Balances({ period }: { period: Period }) {
  const t = today();
  const [date, setDate] = useState(period.end < t ? period.end : t);
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
          <input type="date" name="balancesDate" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
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
