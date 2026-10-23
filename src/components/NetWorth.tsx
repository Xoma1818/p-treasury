// Отчёт «Чистые активы» (В3): значение на конец каждого месяца, под мышкой — разбивка.
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, type NetWorthPoint } from "../lib/api";
import { formatDate, monthTitle } from "../lib/dates";
import { axisLabel, axisPad, changePercent, netWorthScale } from "../lib/netWorth";
import { useSettings } from "../lib/queries";
import { Delta } from "./Dashboard";
import { Hint } from "./Hint";
import { BaseMoney as M } from "./Money";

const RANGES: [number | null, string][] = [
  [12, "12 месяцев"],
  [36, "3 года"],
  [null, "Всё время"],
];

const W = 900;
const H = 240;
const PAD_R = 12;
const PAD_T = 12;
const PAD_B = 24;

export function NetWorthReport() {
  const [months, setMonths] = useState<number | null>(12);
  const h = useQuery({ queryKey: ["netWorth", months], queryFn: () => api.netWorthHistory(months) });
  const r = h.data;
  const last = r?.points[r.points.length - 1];
  const first = r?.points[0];

  return (
    <div className="card" data-testid="networth-report">
      <div className="screen-head">
        <h2>
          Чистые активы
          <Hint of="reports.networth" />
        </h2>
        <div className="tabs small" role="tablist">
          {RANGES.map(([m, label]) => (
            <button key={label} role="tab" aria-selected={months === m} className={months === m ? "tab active" : "tab"} onClick={() => setMonths(m)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      {h.error && <p className="error">{String(h.error)}</p>}
      {r && r.points.length === 0 && <p className="muted">Данных пока нет: добавьте счета и операции.</p>}
      {r && last && first && (
        <>
          <div className="nw-head">
            <div>
              <div className="tile-label">На конец {monthTitle(last.month).toLowerCase()}</div>
              <div className="tile-value" data-testid="networth-last">
                <M amount={last.net} />
              </div>
            </div>
            {r.points.length > 1 && (
              <div>
                <div className="tile-label">За период</div>
                <div className="nw-change">
                  <M amount={last.net - first.net} signed />
                  <Delta pct={first.net !== 0 ? Math.round(((last.net - first.net) / Math.abs(first.net)) * 100) : null} hint={`с ${monthTitle(first.month).toLowerCase()}`} />
                </div>
              </div>
            )}
          </div>
          <NetWorthChart points={r.points} />
          {r.missingRates.length > 0 && <p className="hint warn">Нет курса для {r.missingRates.join(", ")} на некоторые даты: такие суммы не вошли.</p>}
        </>
      )}
    </div>
  );
}

export function NetWorthChart({ points }: { points: NetWorthPoint[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const hidden = useSettings().data?.hide_amounts === "1";
  const { min, max, step } = netWorthScale(points.map((p) => p.net));
  const ticks: number[] = [];
  for (let v = min; v <= max + step / 2; v += step) ticks.push(v);
  const short = (v: number) => (hidden ? "•••" : axisLabel(v));
  // Отступ слева — под самую длинную подпись, чтобы «15 млн» не обрезалось.
  const PAD_L = axisPad(ticks.map(short));
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const slot = plotW / points.length;
  const x = (i: number) => PAD_L + slot * i + slot / 2;
  const y = (v: number) => PAD_T + plotH - ((v - min) / (max - min || 1)) * plotH;
  const line = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(p.net).toFixed(1)}`).join(" ");
  const area = `${line} L${x(points.length - 1).toFixed(1)} ${y(Math.max(min, 0)).toFixed(1)} L${x(0).toFixed(1)} ${y(Math.max(min, 0)).toFixed(1)} Z`;
  // Подписи месяцев: не чаще, чем помещается.
  const every = Math.max(1, Math.ceil(points.length / 12));
  const p = hover != null ? points[hover] : null;

  return (
    <div className="chart nw-chart" onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Чистые активы по месяцам">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD_L} x2={W - PAD_R} y1={y(t)} y2={y(t)} className={t === 0 ? "grid zero" : "grid"} />
            <text x={PAD_L - 8} y={y(t) + 4} className="axis" textAnchor="end">
              {short(t)}
            </text>
          </g>
        ))}
        <path d={area} className="nw-area" />
        <path d={line} className="nw-line" pathLength={1} />
        {points.map((pt, i) => (
          <g key={pt.month} onMouseEnter={() => setHover(i)}>
            <rect x={x(i) - slot / 2} y={0} width={slot} height={H} className={hover === i ? "hit active" : "hit"} />
            {(points.length <= 36 || hover === i) && <circle cx={x(i)} cy={y(pt.net)} r={hover === i ? 5 : 3} className={pt.net < 0 ? "nw-dot neg" : "nw-dot"} />}
            {i % every === 0 && (
              <text x={x(i)} y={H - 6} className="axis" textAnchor="middle">
                {monthTitle(pt.month).slice(0, 3)}
                {points.length > 12 && pt.month.endsWith("-01") ? ` ${pt.month.slice(2, 4)}` : ""}
              </text>
            )}
          </g>
        ))}
      </svg>
      {p && hover != null && (
        <div className="tooltip nw-tip" style={{ left: `${Math.min(Math.max((x(hover) / W) * 100, 14), 86)}%` }} data-testid="networth-tip">
          <div className="main">
            {monthTitle(p.month)} <span className="muted">· на {formatDate(p.date)}</span>
          </div>
          <Row label="Деньги на счетах" v={p.cash} />
          {p.investments !== 0 && <Row label="Инвестиции" v={p.investments} />}
          {p.assets !== 0 && <Row label="Имущество" v={p.assets} />}
          {p.owedToMe !== 0 && <Row label="Мне должны" v={p.owedToMe} />}
          {p.iOwe !== 0 && <Row label="Я должен" v={-p.iOwe} />}
          <div className="nw-tip-row total">
            <span>Чистые активы</span>
            <M amount={p.net} />
          </div>
          {p.change != null && (
            <div className="nw-tip-row muted">
              <span>К прошлому месяцу</span>
              <span>
                <M amount={p.change} signed /> {changePercent(p.net, p.change) != null && `(${fmtPct(changePercent(p.net, p.change)!)})`}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Row({ label, v }: { label: string; v: number }) {
  return (
    <div className="nw-tip-row">
      <span>{label}</span>
      <M amount={v} />
    </div>
  );
}

const fmtPct = (p: number) => (p > 0 ? `+${p} %` : p < 0 ? `−${Math.abs(p)} %` : "0 %");
