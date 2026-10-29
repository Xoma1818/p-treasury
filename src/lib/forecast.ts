// «Взгляд вперёд» (0.18): подписи изменений сценария, заготовки «что если»
// и раскладка диаграммы «Поток денег». Чистые функции — проверяются тестами.
import type { ChangeInput, ChangeKind, Forecast, MoneyFlow } from "./api";
import { monthTitle, shiftMonth } from "./dates";
import { formatMoney } from "./money";

export const CHANGE_KINDS: [ChangeKind, string][] = [
  ["once", "Разовая сумма"],
  ["monthly", "Каждый месяц"],
  ["income_pct", "Доходы в %"],
  ["expense_pct", "Обычные траты в %"],
];

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

export const monthsText = (n: number) => `${n} ${plural(n, "месяц", "месяца", "месяцев")}`;

/** Подпись изменения: «−45 000 ₽ каждый месяц с июня 2027, 12 месяцев». */
export function describeChange(c: ChangeInput, symbol = "₽", minorUnits = 2): string {
  const span = c.months ? `, ${monthsText(c.months)}` : ", до конца прогноза";
  const from = `с ${genitive(c.startMonth)}`;
  const money = (v: number) => (v > 0 ? "+" : "−") + formatMoney(Math.abs(v), symbol, minorUnits);
  switch (c.kind) {
    case "once":
      return `${money(c.amount ?? 0)} в ${prepositional(c.startMonth)}`;
    case "monthly":
      return `${money(c.amount ?? 0)} каждый месяц ${from}${span}`;
    case "income_pct":
      return `${pctText(c.percent ?? 0)} к доходам ${from}${span}`;
    case "expense_pct":
      return `${pctText(c.percent ?? 0)} к обычным тратам ${from}${span}`;
  }
}

const pctText = (p: number) => (p === -100 ? "−100 % (без дохода)" : `${p > 0 ? "+" : "−"}${Math.abs(p)} %`);

const GENITIVE = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];

const PREPOSITIONAL = ["январе", "феврале", "марте", "апреле", "мае", "июне", "июле", "августе", "сентябре", "октябре", "ноябре", "декабре"];

/** «2027-06» → «июне 2027». */
export function prepositional(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${PREPOSITIONAL[m - 1]} ${y}`;
}

/** «2027-06» → «июня 2027». */
export function genitive(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${GENITIVE[m - 1]} ${y}`;
}

/** Заготовки «что если»: одна кнопка — одно понятное изменение. */
export function presets(firstMonth: string): { label: string; change: ChangeInput }[] {
  const next = shiftMonth(firstMonth, 1);
  return [
    { label: "Ипотека или кредит", change: { kind: "monthly", title: "Ипотека", amount: -4_500_000, percent: null, startMonth: next, months: null } },
    { label: "Крупная покупка", change: { kind: "once", title: "Покупка", amount: -30_000_000, percent: null, startMonth: shiftMonth(firstMonth, 3), months: null } },
    { label: "3 месяца без зарплаты", change: { kind: "income_pct", title: "Без зарплаты", amount: null, percent: -100, startMonth: next, months: 3 } },
    { label: "Прибавка 10 %", change: { kind: "income_pct", title: "Прибавка", amount: null, percent: 10, startMonth: next, months: null } },
    { label: "Тратить на 15 % меньше", change: { kind: "expense_pct", title: "Экономия", amount: null, percent: -15, startMonth: firstMonth, months: null } },
  ];
}

/** Точки графика: «сейчас», затем остаток на конец каждого месяца. */
export function chartPoints(f: Forecast): { label: string; base: number; scenario: number | null }[] {
  const withScenario = f.scenarioId != null;
  return [
    { label: "Сейчас", base: f.liquid, scenario: withScenario ? f.liquid : null },
    ...f.months.map((m) => ({
      label: monthTitle(m.month).slice(0, 3),
      base: m.closing,
      scenario: m.scenario ? m.scenario.closing : null,
    })),
  ];
}

export interface FlowBand {
  key: string;
  name: string;
  amount: number;
  /** `income`, `expense`, `invest`, `saved`, `fromSavings`, `fromInvest`. */
  kind: string;
  /** Полоса у своего края. */
  y0: number;
  y1: number;
  /** Та же полоса у средней колонки «Бюджет». */
  m0: number;
  m1: number;
}

export interface FlowLayout {
  left: FlowBand[];
  right: FlowBand[];
  total: number;
}

/**
 * Раскладка «Потока денег» в три колонки: источники → «Бюджет» → куда ушло.
 * Слева доходы (и «Из накоплений», если тратили больше дохода), справа
 * расходы, вложения и «Осталось». Суммы обеих сторон равны.
 */
export function flowLayout(f: MoneyFlow, height: number, gap = 6): FlowLayout {
  const left: Omit<FlowBand, "y0" | "y1" | "m0" | "m1">[] = f.income.map((n) => ({ key: `i-${n.id}`, name: n.name, amount: n.amount, kind: "income" }));
  const right: Omit<FlowBand, "y0" | "y1" | "m0" | "m1">[] = f.expense.map((n) => ({ key: `e-${n.id}`, name: n.name, amount: n.amount, kind: "expense" }));
  if (f.invested > 0) right.push({ key: "invest", name: "Инвестиции", amount: f.invested, kind: "invest" });
  if (f.invested < 0) left.push({ key: "from-invest", name: "С инвестиций", amount: -f.invested, kind: "fromInvest" });
  if (f.saved > 0) right.push({ key: "saved", name: "Осталось", amount: f.saved, kind: "saved" });
  if (f.saved < 0) left.push({ key: "from-savings", name: "Из накоплений", amount: -f.saved, kind: "fromSavings" });
  const total = Math.max(
    left.reduce((s, n) => s + n.amount, 0),
    right.reduce((s, n) => s + n.amount, 0),
  );
  const place = (nodes: typeof left): FlowBand[] => {
    if (total <= 0) return [];
    const usable = Math.max(1, height - gap * Math.max(0, nodes.length - 1));
    const k = usable / total;
    const mk = height / total;
    let y = 0;
    let m = 0;
    return nodes.map((n) => {
      const h = n.amount * k;
      const mh = n.amount * mk;
      const band = { ...n, y0: y, y1: y + h, m0: m, m1: m + mh };
      y += h + gap;
      m += mh;
      return band;
    });
  };
  return { left: place(left), right: place(right), total };
}

/** Лента между двумя вертикальными отрезками: от (x0, a0–a1) к (x1, b0–b1). */
export function ribbon(x0: number, a0: number, a1: number, x1: number, b0: number, b1: number): string {
  const c = (x0 + x1) / 2;
  const f = (n: number) => n.toFixed(1);
  return `M${f(x0)} ${f(a0)} C${f(c)} ${f(a0)} ${f(c)} ${f(b0)} ${f(x1)} ${f(b0)} L${f(x1)} ${f(b1)} C${f(c)} ${f(b1)} ${f(c)} ${f(a1)} ${f(x0)} ${f(a1)} Z`;
}
