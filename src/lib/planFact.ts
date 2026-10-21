/** «План — факт» месяца: доходы, расходы и инвестиции и насколько факт совпадает с планом. */

export type PlanFactKind = "income" | "expense" | "invest";

export interface PlanFactRow {
  kind: PlanFactKind;
  plan: number;
  fact: number;
  /** Факт − план. */
  diff: number;
  /** Факт в процентах от плана; `null` без плана. */
  percent: number | null;
  /** Хорошо ли отклонение: доходов и инвестиций больше плана, расходов меньше. */
  good: boolean;
}

export interface PlanFact {
  rows: PlanFactRow[];
  /** Доходы − расходы − инвестиции: по плану и по факту. */
  leftPlan: number;
  leftFact: number;
  /** На сколько процентов факт совпал с планом (100 — ровно по плану); `null`, если плана нет. */
  match: number | null;
}

function row(kind: PlanFactKind, plan: number, fact: number): PlanFactRow {
  const diff = fact - plan;
  return {
    kind,
    plan,
    fact,
    diff,
    percent: plan > 0 ? Math.round((fact / plan) * 100) : null,
    good: kind === "expense" ? diff <= 0 : diff >= 0,
  };
}

export function planFact(v: { incomePlan: number; incomeFact: number; expensePlan: number; expenseFact: number; investPlan: number; investFact: number }): PlanFact {
  const rows = [row("income", v.incomePlan, v.incomeFact), row("expense", v.expensePlan, v.expenseFact), row("invest", v.investPlan, v.investFact)];
  const planned = rows.filter((r) => r.plan > 0);
  const total = planned.reduce((s, r) => s + r.plan, 0);
  const miss = planned.reduce((s, r) => s + Math.abs(r.diff), 0);
  return {
    rows,
    leftPlan: v.incomePlan - v.expensePlan - v.investPlan,
    leftFact: v.incomeFact - v.expenseFact - v.investFact,
    match: total > 0 ? Math.max(0, Math.round(100 - (miss / total) * 100)) : null,
  };
}
