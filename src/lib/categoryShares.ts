import type { CategoryReport } from "./api";

/** Доли описывают целое только при неотрицательных слагаемых и ненулевом итоге. */
export function shareUnavailable(report: CategoryReport): string | null {
  if (report.items.some(item => item.amount < 0 || item.children.some(child => child.amount < 0))) {
    return "В разбивке есть отрицательные суммы. Показаны суммы категорий с учётом возвратов.";
  }
  return report.total === 0 ? "Итог равен нулю. Доли не определены." : null;
}

export function homeShares(report: CategoryReport) {
  const parts = report.items.slice(0, 4).map(c => ({ id: `cat:${c.categoryId}`, name: c.name, amount: c.amount }));
  const rest = report.items.slice(4).reduce((sum, item) => sum + item.amount, 0);
  if (rest > 0) parts.push({ id: "rest", name: "Остальное", amount: rest });
  return parts;
}
