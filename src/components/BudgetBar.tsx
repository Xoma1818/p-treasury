import { type BarLevel } from "../lib/budgetLevel";

/** Общая легенда полосы на Главной и в месячном бюджете. */
export function BudgetBar({ percent, level }: { percent: number; level: BarLevel }) {
  const color = level === "ok" ? "" : ` ${level}`;
  return <>
    <div className={`bar${color}`} title={`${percent} %`}>
      <span style={{ width: `${Math.max(0, Math.min(percent, 100))}%` }} />
    </div>
    <span className={`percent${color}`} data-testid="percent">{percent} %</span>
    {level === "used" && <span className="budget-limit-status">Лимит использован</span>}
  </>;
}
