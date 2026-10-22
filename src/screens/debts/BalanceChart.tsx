import { useId, useMemo, useState, type MouseEvent } from "react";
import { formatDate } from "../../lib/dates";
import { balancePoints, dayNumber, type Point } from "../../lib/loan";
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
  const hidden = useSettings().data?.hide_amounts === "1";
  const gid = useId().replace(/:/g, "");
  const [hover, setHover] = useState<number | null>(null);
  const { a, b, x0, x1, years } = useMemo(() => {
    const a = balancePoints(base, issueDate, principal);
    const b = withEarly ? balancePoints(withEarly, issueDate, principal) : null;
    const x0 = dayNumber(issueDate);
    const x1 = Math.max(x0 + 1, ...a.map((p) => dayNumber(p.date)), ...(b ?? []).map((p) => dayNumber(p.date)));
    const firstYear = Number(issueDate.slice(0, 4)) + 1;
    const lastYear = Number(a[a.length - 1].date.slice(0, 4));
    const step = Math.max(1, Math.ceil((lastYear - firstYear + 1) / 8));
    const years: number[] = [];
    for (let y = firstYear; y <= lastYear; y += step) years.push(y);
    return { a, b, x0, x1, years };
  }, [base, withEarly, issueDate, principal]);
  const top = Math.max(principal, 1);
  const x = (d: string) => PAD.l + ((dayNumber(d) - x0) / (x1 - x0)) * (W - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (1 - v / top) * (H - PAD.t - PAD.b);
  const line = (pts: Point[]) => pts.map((p, i) => `${i ? "L" : "M"}${x(p.date).toFixed(1)},${y(p.balance).toFixed(1)}`).join("");
  const area = (pts: Point[]) => `${line(pts)}L${x(pts[pts.length - 1].date).toFixed(1)},${y(0)}L${x(pts[0].date).toFixed(1)},${y(0)}Z`;
  const main = b ?? a;
  const money = (v: number) => (hidden ? HIDDEN_AMOUNT : formatMoney(v, symbol, minorUnits));
  const hp = hover === null ? null : main[hover];

  // Ближайшая точка основной линии к мыши.
  const onMove = (e: MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    let best = 0;
    main.forEach((p, i) => Math.abs(x(p.date) - px) < Math.abs(x(main[best].date) - px) && (best = i));
    setHover(best);
  };

  return (
    <div className="loan-chart" data-testid="loan-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Остаток долга по датам" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        <defs>
          <linearGradient id={`fill-${gid}`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="var(--accent)" stopOpacity="0.22" />
            <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75, 1].map((f) => (
          <line key={f} className="grid" x1={PAD.l} x2={W - PAD.r} y1={y(top * f)} y2={y(top * f)} />
        ))}
        <line className="axis-line" x1={PAD.l} x2={W - PAD.r} y1={y(0)} y2={y(0)} />
        {years.map((yr) => {
          const d = `${yr}-01-01`;
          return dayNumber(d) <= x1 ? (
            <text key={yr} className="axis" x={x(d)} y={H - 6} textAnchor="middle">
              {yr}
            </text>
          ) : null;
        })}
        <path className="area" d={area(main)} fill={`url(#fill-${gid})`} />
        {b && <path className="line-base" d={line(a)} />}
        <path className="line-main draw" d={line(main)} pathLength={1} />
        {hp && (
          <g className="hover">
            <line x1={x(hp.date)} x2={x(hp.date)} y1={PAD.t} y2={y(0)} />
            <circle cx={x(hp.date)} cy={y(hp.balance)} r={4} />
          </g>
        )}
      </svg>
      <div className="loan-chart-foot">
        {hp ? (
          <span>
            {formatDate(hp.date)}: остаток <b>{money(hp.balance)}</b>
          </span>
        ) : (
          <span className="legend">
            {b && (
              <>
                <i className="key base" /> без досрочек
              </>
            )}
            <i className="key main" /> {b ? "с досрочками" : "остаток долга"}
          </span>
        )}
      </div>
    </div>
  );
}
