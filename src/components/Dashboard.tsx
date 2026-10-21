import { useQuery } from "@tanstack/react-query";
import { api, type MonthsReport, type Period } from "../lib/api";
import { addDays, monthTitle, shiftMonth, today } from "../lib/dates";
import { useBudget, useMonthOf, useSettings } from "../lib/queries";
import { MonthsChart } from "../screens/Reports";
import { BaseMoney as M } from "./Money";
import { Hint } from "./Hint";

/** Цвета долей в кольце «Куда ушли деньги»: последний — «Остальное». */
const DONUT = ["var(--series-expense)", "#60a5fa", "#a78bfa", "#f472b6", "var(--muted)"];

/** Данные дашборда Главной: полгода по месяцам и те же дни прошлого месяца. */
export function useDashboard(period: Period | undefined) {
  const date = today();
  const months = useQuery({
    queryKey: ["dashMonths", period?.month],
    queryFn: () => api.reportByMonth(shiftMonth(period!.month, -5), period!.month),
    enabled: !!period,
  }).data;
  const prev = useMonthOf(period ? addDays(period.start, -1) : date).data;
  // Сравниваем с тем же числом дней прошлого месяца: месяц ещё идёт.
  const elapsed = period ? daysBetween(period.start, date <= period.end ? date : period.end) : 0;
  const prevEnd = prev ? minDate(addDays(prev.start, elapsed), prev.end) : undefined;
  const prevSame = useQuery({
    queryKey: ["summary", prev?.start, prevEnd],
    queryFn: () => api.periodSummary(prev!.start, prevEnd!),
    enabled: !!period && !!prev && !!prevEnd,
  }).data;
  return { months, prevSame };
}

function daysBetween(a: string, b: string) {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}
function minDate(a: string, b: string) {
  return a < b ? a : b;
}

/** Изменение к прошлому в процентах (null — сравнивать не с чем). */
export function change(cur: number, prev: number | undefined): number | null {
  if (prev == null || prev === 0) return null;
  return Math.round(((cur - prev) / Math.abs(prev)) * 100);
}

/** Плашка «+12 %» / «−14 %»; `lowerIsBetter` — для расходов. */
export function Delta({ pct, lowerIsBetter, hint }: { pct: number | null; lowerIsBetter?: boolean; hint?: string }) {
  if (pct == null) return null;
  const good = pct === 0 ? null : lowerIsBetter ? pct < 0 : pct > 0;
  const text = pct === 0 ? "= " : pct > 0 ? `+${pct} %` : `−${Math.abs(pct)} %`;
  return (
    <span className={good == null ? "delta" : good ? "delta good" : "delta bad"} title={hint} data-testid="delta">
      {pct === 0 ? `${text}прошлый` : text}
    </span>
  );
}

/** Мини-график в плитке: линия прорисовывается слева направо. */
export function Sparkline({ values, className }: { values: number[]; className?: string }) {
  if (values.length < 2) return null;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const d = values.map((v, i) => `${i ? "L" : "M"}${((i * 200) / (values.length - 1)).toFixed(1)} ${(36 - ((v - min) / (max - min || 1)) * 32).toFixed(1)}`).join(" ");
  return (
    <svg className={className ? `spark ${className}` : "spark"} viewBox="0 0 200 40" preserveAspectRatio="none" aria-hidden="true">
      <path d={d} pathLength={1} className="draw" />
    </svg>
  );
}

/** Кольцо прогресса с подписью в центре. */
export function Ring({ percent, size = 120, children, label }: { percent: number; size?: number; children: React.ReactNode; label: string }) {
  const p = Math.max(0, Math.min(100, percent));
  return (
    <div className="ring" style={{ width: size, height: size }} role="img" aria-label={label}>
      <svg viewBox="0 0 140 140" aria-hidden="true">
        <circle cx="70" cy="70" r="58" className="ring-track" />
        <circle cx="70" cy="70" r="58" className="ring-value sweep" pathLength={100} strokeDasharray={`${p} ${100 - p}`} />
      </svg>
      <div className="ring-center">{children}</div>
    </div>
  );
}

/** Ряды «баланс, доходы, расходы, сальдо» за полгода для мини-графиков. */
export function sparkSeries(r: MonthsReport | undefined, total: number | undefined) {
  const income = r?.months.map((m) => m.income) ?? [];
  const expense = r?.months.map((m) => m.expense) ?? [];
  const saldo = r?.months.map((m) => m.balance) ?? [];
  // Баланс на конец каждого месяца: от сегодняшнего назад на сальдо месяцев.
  const balance: number[] = [];
  if (total != null && saldo.length) {
    let b = total;
    for (let i = saldo.length - 1; i >= 0; i--) {
      balance.unshift(b);
      b -= saldo[i];
    }
  }
  return { income, expense, saldo, balance };
}

/** «Сводка месяца»: главное о месяце словами и норма сбережений кольцом. */
export function SummaryCard({ period }: { period: Period }) {
  const month = useQuery({ queryKey: ["summary", period.start, period.end], queryFn: () => api.periodSummary(period.start, period.end) }).data;
  const { prevSame } = useDashboard(period);
  const cats = useQuery({ queryKey: ["byCategory", "expense", period.start, period.end], queryFn: () => api.reportByCategory("expense", period.start, period.end) }).data;
  const budget = useBudget(period.month).data;
  const cal = useQuery({ queryKey: ["calendar", today().slice(0, 7)], queryFn: () => api.calendarMonth(today().slice(0, 7)) }).data;
  if (!month) return <div className="card summary-card" data-testid="home-summary" />;
  const exp = change(month.expense, prevSame?.expense);
  const top = cats?.items[0];
  const noSpend = cal?.days.filter((d) => d.noSpend).length ?? 0;
  const left = daysBetween(today(), period.end);
  const title =
    exp == null ? `Сводка: ${monthTitle(period.month).toLowerCase()}` : exp < 0 ? "Месяц идёт экономнее прошлого" : exp > 0 ? "Тратите больше, чем в прошлом месяце" : "Траты как в прошлом месяце";
  return (
    <div className="card summary-card fade-up" data-testid="home-summary">
      <div className="summary-text">
        <div className="eyebrow">
          Сводка месяца{left >= 0 ? ` · осталось ${left} ${plural(left, "день", "дня", "дней")}` : ""}
          <Hint of="home.summary" />
        </div>
        <h2>{title}</h2>
        <ul className="summary-lines">
          <li>
            <b className={exp == null ? "" : exp <= 0 ? "good" : "bad"}>{exp == null ? "—" : exp <= 0 ? `↓ ${Math.abs(exp)} %` : `↑ ${exp} %`}</b>
            <span>
              Потратили <M amount={month.expense} />
              {prevSame && prevSame.expense > 0 && (
                <>
                  , за те же дни прошлого месяца — <M amount={prevSame.expense} />
                </>
              )}
            </span>
          </li>
          {top && (
            <li>
              <b className="warn">{Math.round(top.percent)} %</b>
              <span>
                Больше всего ушло на «{top.name}»: <M amount={top.amount} />
              </span>
            </li>
          )}
          {budget?.id && budget.safeToSpendToday != null && (
            <li>
              <b className="info">
                <M amount={Math.max(budget.safeToSpendToday, 0)} />
              </b>
              <span>можно тратить сегодня, чтобы уложиться в бюджет</span>
            </li>
          )}
          <li>
            <b className="good">{noSpend}</b>
            <span>{plural(noSpend, "день", "дня", "дней")} без трат в этом месяце</span>
          </li>
        </ul>
      </div>
      {month.savingsRate != null && (
        <Ring percent={month.savingsRate} label={`Норма сбережений ${month.savingsRate} %`}>
          <b>{month.savingsRate} %</b>
          <span>сбережений</span>
        </Ring>
      )}
    </div>
  );
}

export function plural(n: number, one: string, few: string, many: string) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}

/** «Полгода» и «Куда ушли деньги»: столбцы по месяцам и кольцо категорий. */
export function TrendCard({ period }: { period: Period }) {
  const { months } = useDashboard(period);
  const cats = useQuery({ queryKey: ["byCategory", "expense", period.start, period.end], queryFn: () => api.reportByCategory("expense", period.start, period.end) }).data;
  const hidden = useSettings().data?.hide_amounts === "1";
  const items = cats?.items ?? [];
  const top = items.slice(0, 4);
  const rest = items.slice(4).reduce((s, i) => s + i.amount, 0);
  const parts = [...top.map((i) => ({ name: i.name, amount: i.amount })), ...(rest > 0 ? [{ name: "Остальное", amount: rest }] : [])];
  const total = cats?.total ?? 0;
  let acc = 0;
  return (
    <div className="columns trend-row">
      <div className="card fade-up" data-testid="home-trend">
        <h2>
          Доходы и расходы за полгода
          <Hint of="home.trend" />
        </h2>
        {months && <MonthsChart r={months} />}
      </div>
      <div className="card fade-up" data-testid="home-donut">
        <h2>Куда ушли деньги</h2>
        {total === 0 && <p className="muted">В этом месяце расходов пока нет.</p>}
        {total > 0 && (
          <div className="donut-wrap">
            <div className="donut" role="img" aria-label="Расходы месяца по категориям">
              <svg viewBox="0 0 140 140" aria-hidden="true">
                <circle cx="70" cy="70" r="54" className="ring-track" />
                {parts.map((p, i) => {
                  const pct = (p.amount / total) * 100;
                  const seg = (
                    <circle
                      key={p.name}
                      cx="70"
                      cy="70"
                      r="54"
                      className="donut-seg sweep"
                      stroke={DONUT[i === parts.length - 1 && rest > 0 ? 4 : i]}
                      pathLength={100}
                      strokeDasharray={`${Math.max(pct - 0.8, 0.1)} ${100 - Math.max(pct - 0.8, 0.1)}`}
                      strokeDashoffset={-acc}
                      style={{ animationDelay: `${i * 90}ms` }}
                    />
                  );
                  acc += pct;
                  return seg;
                })}
              </svg>
              <div className="ring-center">
                <b>{hidden ? "•••" : <M amount={total} />}</b>
                <span>{monthTitle(period.month).toLowerCase()}</span>
              </div>
            </div>
            <ul className="donut-legend">
              {parts.map((p, i) => (
                <li key={p.name}>
                  <i style={{ background: DONUT[i === parts.length - 1 && rest > 0 ? 4 : i] }} />
                  <span className="name">{p.name}</span>
                  <span className="muted">{Math.round((p.amount / total) * 100)} %</span>
                  <M amount={p.amount} />
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

/** «Траты по дням»: клетки месяца, чем ярче — тем больше потрачено. */
export function DaysCard() {
  const month = today().slice(0, 7);
  const cal = useQuery({ queryKey: ["calendar", month], queryFn: () => api.calendarMonth(month) }).data;
  const hidden = useSettings().data?.hide_amounts === "1";
  if (!cal) return <div className="card" data-testid="home-days" />;
  const max = Math.max(...cal.days.map((d) => d.expense), 1);
  const lead = (new Date(`${cal.days[0].date}T00:00:00`).getDay() + 6) % 7;
  const t = today();
  const noSpend = cal.days.filter((d) => d.noSpend).length;
  const level = (v: number) => (v <= 0 ? 0 : Math.min(4, Math.ceil((v / max) * 4)));
  return (
    <div className="card fade-up" data-testid="home-days">
      <div className="notes-head">
        <h2>
          Траты по дням, {monthTitle(month).toLowerCase()}
          <Hint of="home.days" />
        </h2>
        <span className="muted small">
          {noSpend} {plural(noSpend, "день", "дня", "дней")} без трат
        </span>
      </div>
      <div className="heat">
        {["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].map((w) => (
          <span key={w} className="heat-head">
            {w}
          </span>
        ))}
        {Array.from({ length: lead }, (_, i) => (
          <span key={`e${i}`} />
        ))}
        {cal.days.map((d, i) => {
          const future = d.date > t;
          const amount = hidden ? "•••" : formatShort(d.expense, cal.currencySymbol, cal.minorUnits);
          return (
            <span
              key={d.date}
              className={future ? "heat-cell future" : `heat-cell l${level(d.expense)}`}
              title={future ? undefined : `${Number(d.date.slice(8))}: ${d.expense > 0 ? amount : "без трат"}`}
              style={{ animationDelay: `${i * 12}ms` }}
              data-testid="heat-cell"
            >
              {Number(d.date.slice(8))}
            </span>
          );
        })}
      </div>
      <div className="heat-legend muted small">
        меньше <i className="heat-cell l0" /> <i className="heat-cell l1" /> <i className="heat-cell l2" /> <i className="heat-cell l3" /> <i className="heat-cell l4" /> больше
      </div>
    </div>
  );
}

function formatShort(minor: number, symbol: string, minorUnits: number) {
  const v = Math.round(minor / 10 ** minorUnits);
  return `${v.toLocaleString("ru-RU")} ${symbol}`;
}
