import type { Budget, BudgetLine, BudgetWarning } from "./api";

export function coverSources(budget: Pick<Budget, "lines">, target: BudgetLine) {
  if (!target.canRebalance || target.remaining >= 0) return [];
  const amount = -target.remaining;
  return budget.lines.filter((line) => line.canRebalance && Math.min(line.baseLimit, line.remaining) >= amount);
}

export function warningCoverTarget(budget: Pick<Budget, "id" | "period" | "lines"> | undefined, warning: BudgetWarning) {
  if (!budget?.id || budget.period.month !== warning.month ||
      budget.period.start !== warning.start || budget.period.end !== warning.end ||
      warning.actual <= warning.limit) return undefined;
  const target = budget.lines.find((line) => line.categoryId === warning.categoryId);
  return target && coverSources(budget, target).length ? target : undefined;
}
