import { useId, useMemo, useState } from "react";
import { chartScrub } from "../../lib/chartScrub";
import { formatDate } from "../../lib/dates";
import { addDays, balanceOnDate, balancePoints, dayNumber, type Point } from "../../lib/loan";
import type { EarlyRow, LoanRow } from "../../lib/api";
import { useSettings } from "../../lib/queries";
import { formatMoney, HIDDEN_AMOUNT } from "../../lib/money";

const W = 640;
const H = 220;
const PAD = { l: 8, r: 8, t: 12, b: 24 };

type View = { rows: LoanRow[]; early: EarlyRow[] };

/** Диаграмма остатка долга: пунктир — по графику без досрочек, сплошная — с досрочками.
 *  Цвета из токенов темы; линия «рисуется» один раз (выключается системным «меньше движения»). */
export function BalanceChart({ base, withEarly, issueDate, principal, symbol, minorUnits }: { base: View; withEarly?: View | null; issueDate: string; principal: number; symbol: string; minorUnits: number }) {
  const settings = useSettings().data;
  const hidden = !settings || settings.hide_amounts === "1";
  const gid = useId().replace(/:/g, "");
  const [selectedDate, setSelectedDate] = useState(issueDate);
  const { a, b, x0, x1, days, endDate, years, x, y, mainLine, baseLine, area } = useMemo(() => {
    const a = balancePoints(base, issueDate, principal);
    const b = withEarly ? balancePoints(withEarly, issueDate, principal) : null;
    const x0 = dayNumber(issueDate);
    const baseEnd = a[a.length - 1].date;
    const otherEnd = b ? b[b.length - 1].date : issueDate;
    const endDate = baseEnd > otherEnd ? baseEnd : otherEnd;
    const x1 = Math.max(x0, dayNumber(endDate));
    const firstYear = Number(issueDate.slice(0, 4)) + 1;
    const lastYear = Number(endDate.slice(0, 4));
    const step = Math.max(1, Math.ceil((lastYear - firstYear + 1) / 8));
    const years: number[] = [];
    for (let y = firstYear; y <= lastYear; y += step) years.push(y);
    const days = x1 - x0;
    const x = (d: string) => PAD.l + ((dayNumber(d) - x0) / Math.max(days, 1)) * (W - PAD.l - PAD.r);
    const y = (v: number) => PAD.t + (1 - v / Math.max(principal, 1)) * (H - PAD.t - PAD.b);
    const line = (pts: Point[]) => pts.map((p, i) => i
      ? `H${x(p.date).toFixed(1)}V${y(p.balance).toFixed(1)}`
      : `M${x(p.date).toFixed(1)},${y(p.balance).toFixed(1)}`).join("");
    const main = b ?? a;
    const mainLine = line(main);
    const area = `${mainLine}L${x(main[main.length - 1].date).toFixed(1)},${y(0)}L${x(main[0].date).toFixed(1)},${y(0)}Z`;
    return { a, b, x0, x1, endDate, years, days, x, y, mainLine, baseLine: b ? line(a) : null, area };
  }, [base, withEarly, issueDate, principal]);
  const top = Math.max(principal, 1);
  const money = (v: number) => (hidden ? HIDDEN_AMOUNT : formatMoney(v, symbol, minorUnits));
  const date = selectedDate < issueDate ? issueDate : selectedDate > endDate ? endDate : selectedDate;
  const baseValue = balanceOnDate(a, date) ?? principal;
  const mainValue = b ? balanceOnDate(b, date) ?? principal : baseValue;
  const spokenBalance = b ? `Без досрочек ${money(baseValue)}. С досрочками ${money(mainValue)}` : `Остаток ${money(baseValue)}`;
  const selectDay = (offset: number) => setSelectedDate(addDays(issueDate, offset));
  const value = (v: number) => hidden
    ? <><span aria-hidden="true">{HIDDEN_AMOUNT}</span><span className="sr-only">Сумма скрыта</span></>
    : money(v);

  return (
    <div className="loan-chart" data-testid="loan-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Остаток долга по датам"
        {...chartScrub(PAD.l, W - PAD.r, days, selectDay)}>
        <defs>
          <linearGradient id={`fill-${gid}`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="var(--accent)" stopOpacity="0.22" />
            <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75, 1].map((f) => (
          <line key={f} className="grid" x1={PAD.l} x2={W - PAD.r} y1={y(top * f)} y2={y(top * f)} />
        ))}
        <text className="axis" x={W - PAD.r} y={y(top) - 3} textAnchor="end">
          {money(top)}
        </text>
        <line className="axis-line" x1={PAD.l} x2={W - PAD.r} y1={y(0)} y2={y(0)} />
        {years.map((yr) => {
          const d = `${yr}-01-01`;
          return dayNumber(d) <= x1 ? (
            <text key={yr} className="axis" x={x(d)} y={H - 6} textAnchor="middle">
              {yr}
            </text>
          ) : null;
        })}
        <path className="area" d={area} fill={`url(#fill-${gid})`} />
        {baseLine && <path className="line-base" d={baseLine} />}
        <path className="line-main draw" d={mainLine} pathLength={1} />
        <g className="hover">
          <line x1={x(date)} x2={x(date)} y1={PAD.t} y2={y(0)} />
          {b && baseValue !== mainValue && <circle className="base" cx={x(date)} cy={y(baseValue)} r={4} />}
          <circle cx={x(date)} cy={y(mainValue)} r={4} />
        </g>
      </svg>
      <div className="loan-chart-foot" data-testid="loan-chart-readout">
        <label className="loan-chart-date">
          <span>Дата <time dateTime={date}>{formatDate(date)}</time></span>
          <input type="range" min={0} max={days} step={1} value={dayNumber(date) - x0} disabled={!days}
            aria-label="Дата остатка долга" aria-valuetext={`${formatDate(date)}. ${hidden ? "Сумма скрыта" : spokenBalance}`}
            onChange={(event) => selectDay(event.currentTarget.valueAsNumber)} />
        </label>
        <div className="legend">
          {b && <span><i className="key base" aria-hidden="true" /> Без досрочек <b>{value(baseValue)}</b></span>}
          <span><i className="key main" aria-hidden="true" /> {b ? "С досрочками" : "Остаток"} <b>{value(mainValue)}</b></span>
        </div>
      </div>
    </div>
  );
}
