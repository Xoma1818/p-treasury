import { AmountInput } from "../../components/Fields";
import type { EarlyFrequency, RecalcMode } from "../../lib/api";
import { emptyEarly, FREQUENCIES, MODES, type EarlyLine, type RateLine } from "../../lib/loan";

/** Строки «Досрочные погашения»: сумма · как часто (с даты) · что уменьшать, кнопки «×» и «+». */
export function EarlyEditor({ lines, onChange, minorUnits, symbol, defaultDate, bullet }: { lines: EarlyLine[]; onChange: (l: EarlyLine[]) => void; minorUnits: number; symbol: string; defaultDate: string; bullet?: boolean }) {
  const set = (i: number, patch: Partial<EarlyLine>) => onChange(lines.map((l, k) => (k === i ? { ...l, ...patch } : l)));
  return (
    <div className="loan-lines" data-testid="early-lines">
      {lines.map((l, i) => (
        <div key={i} className="loan-line early-line" data-testid="early-line">
          <span className="amount-with-sym">
            <AmountInput name={`early-amount-${i}`} value={l.amount} onChange={(v) => set(i, { amount: v })} minorUnits={minorUnits} />
            <span className="sym">{symbol}</span>
          </span>
          <select name={`early-freq-${i}`} aria-label="Как часто" value={l.frequency} onChange={(e) => set(i, { frequency: e.target.value as EarlyFrequency })}>
            {(Object.keys(FREQUENCIES) as EarlyFrequency[]).map((f) => (
              <option key={f} value={f}>
                {FREQUENCIES[f]}
              </option>
            ))}
          </select>
          <span className="loan-line-label">{l.frequency === "once" ? "" : "с"}</span>
          <input name={`early-date-${i}`} type="date" aria-label={l.frequency === "once" ? "Дата досрочки" : "С какой даты"} value={l.date} onChange={(e) => set(i, { date: e.target.value })} />
          {!bullet && (
            <select name={`early-mode-${i}`} aria-label="Что уменьшать" value={l.mode} onChange={(e) => set(i, { mode: e.target.value as RecalcMode })}>
              {(Object.keys(MODES) as RecalcMode[]).map((m) => (
                <option key={m} value={m}>
                  {MODES[m]}
                </option>
              ))}
            </select>
          )}
          <button type="button" className="icon-btn line-del" aria-label="Убрать досрочку" title="Убрать" onClick={() => onChange(lines.filter((_, k) => k !== i))}>
            ×
          </button>
        </div>
      ))}
      <button type="button" className="btn small add-line" onClick={() => onChange([...lines, emptyEarly(lines[lines.length - 1]?.date || defaultDate)])}>
        + Досрочное погашение
      </button>
    </div>
  );
}

/** Строки «Ставка меняется?»: с даты — ставка. */
export function RateEditor({ lines, onChange, defaultDate }: { lines: RateLine[]; onChange: (l: RateLine[]) => void; defaultDate: string }) {
  const set = (i: number, patch: Partial<RateLine>) => onChange(lines.map((l, k) => (k === i ? { ...l, ...patch } : l)));
  return (
    <div className="loan-lines" data-testid="rate-lines">
      {lines.map((l, i) => (
        <div key={i} className="loan-line rate-line">
          <span className="loan-line-label">с</span>
          <input name={`rate-from-${i}`} type="date" aria-label="С какой даты" value={l.from} onChange={(e) => set(i, { from: e.target.value })} />
          <span className="loan-line-label">—</span>
          <span className="amount-with-sym">
            <input name={`rate-value-${i}`} className="amount" inputMode="decimal" aria-label="Ставка, %" value={l.rate} onChange={(e) => set(i, { rate: e.target.value })} placeholder="0" />
            <span className="sym">%</span>
          </span>
          <button type="button" className="icon-btn line-del" aria-label="Убрать ставку" title="Убрать" onClick={() => onChange(lines.filter((_, k) => k !== i))}>
            ×
          </button>
        </div>
      ))}
      <button type="button" className="btn small add-line" onClick={() => onChange([...lines, { from: defaultDate, rate: "" }])}>
        + Ставка с даты
      </button>
    </div>
  );
}
