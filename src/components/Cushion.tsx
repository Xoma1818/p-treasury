import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useAction } from "../lib/useAction";
import { Money } from "./Money";
import { Hint } from "./Hint";

const GOALS = [3, 6, 12];

/** «На сколько месяцев хватит денег» в виде «4,2» (десятые приходят целым числом). */
export function monthsText(tenths: number): string {
  return `${Math.floor(tenths / 10)},${tenths % 10}`;
}

/** Склонение «месяц» для дробного числа месяцев: дроби всегда «месяца». */
export function monthsWord(tenths: number): string {
  if (tenths % 10 !== 0) return "месяца";
  const n = tenths / 10;
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return "месяц";
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return "месяца";
  return "месяцев";
}

/** Главная → «Финансовая подушка»: деньги на счетах / средние расходы, с целью в месяцах. */
export function CushionCard() {
  const c = useQuery({ queryKey: ["cushion"], queryFn: api.cushion }).data;
  const setGoal = useAction((m: number) => api.setSetting("cushion_goal_months", String(m)));
  if (!c) return null;
  const tenths = c.monthsTenths;
  const percent = tenths == null ? 0 : Math.min(100, (tenths / (c.goalMonths * 10)) * 100);
  const reached = tenths != null && tenths >= c.goalMonths * 10;
  return (
    <div className="card cushion" data-testid="home-cushion">
      <div className="cushion-main">
        <div className="tile-label">
          Финансовая подушка
          <Hint of="cushion" />
        </div>
        {tenths == null ? (
          <div className="muted">Появится, когда наберётся хотя бы один полный месяц расходов.</div>
        ) : (
          <div className="cushion-value">
            Денег хватит на <b data-testid="cushion-months">{monthsText(tenths)}</b> {monthsWord(tenths)}
          </div>
        )}
        {c.avgMonthlyExpense != null && (
          <div className="hint">
            <Money amount={c.liquid} symbol={c.baseSymbol} /> на наличных, картах и вкладах при средних расходах{" "}
            <Money amount={c.avgMonthlyExpense} symbol={c.baseSymbol} /> в месяц (за {c.monthsCounted} мес.)
          </div>
        )}
      </div>
      <div className="cushion-goal">
        <div className={reached ? "bar goal reached" : "bar goal"} title={`${Math.round(percent)} % цели`}>
          <span style={{ width: `${percent}%` }} />
        </div>
        <label className="hint">
          цель{" "}
          <select name="cushionGoal" aria-label="Цель подушки в месяцах" value={c.goalMonths} onChange={(e) => setGoal.run(Number(e.target.value))}>
            {[...new Set([...GOALS, c.goalMonths])].sort((a, b) => a - b).map((m) => (
              <option key={m} value={m}>
                {m} мес.
              </option>
            ))}
          </select>
        </label>
        {reached && <div className="hint plus">Цель достигнута</div>}
      </div>
    </div>
  );
}
