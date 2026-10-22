// Форма займа (калькулятор и «Новый долг» — одна форма): перевод полей в CalcInput
// для ядра и точки диаграммы остатка. Чистые функции, без React.
import type { CalcInput, EarlyFrequency, EarlyRow, InterestMethod, LoanRow, PlannedEarlyInput, RateChangeInput, RecalcMode, Repayment } from "./api";
import { amountToInput, parseAmount } from "./money";

export type Solve = "payment" | "term" | "principal";
export type TermUnit = "years" | "months";

/** Строка «Ставка меняется?»: с даты — ставка. */
export interface RateLine {
  from: string;
  rate: string;
}

/** Строка «Досрочные погашения»: сумма · как часто (с даты) · что уменьшать. */
export interface EarlyLine {
  amount: string;
  frequency: EarlyFrequency;
  date: string;
  mode: RecalcMode;
}

export interface LoanForm {
  solve: Solve;
  amount: string;
  /** Желаемый платёж для расчёта срока или суммы. */
  payment: string;
  term: string;
  termUnit: TermUnit;
  rate: string;
  rates: RateLine[];
  repayment: Repayment;
  issueDate: string;
  /** Начало выплат; пусто — через месяц после выдачи. */
  firstPayment: string;
  /** Дата возврата для разового погашения. */
  maturity: string;
  method: InterestMethod;
  early: EarlyLine[];
}

export const FREQUENCIES: Record<EarlyFrequency, string> = {
  once: "разово",
  monthly: "раз в месяц",
  quarterly: "раз в квартал",
  yearly: "раз в год",
};

export const MODES: Record<RecalcMode, string> = {
  reduce_payment: "уменьшать платёж",
  reduce_term: "уменьшать срок",
};

export const METHODS: Record<InterestMethod, string> = {
  daily: "по дням, как банк",
  monthly: "по месяцам",
};

export const emptyEarly = (date: string): EarlyLine => ({ amount: "", frequency: "once", date, mode: "reduce_term" });

/** Срок в месяцах из поля «срок» и единицы; «1,5» года — 18 месяцев. null — срок не задан или неверен. */
export function termToMonths(term: string, unit: TermUnit): number | null {
  const t = term.trim().replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const v = Number(t);
  const months = unit === "years" ? Math.round(v * 12) : v;
  if (!Number.isInteger(months) || months < 1 || months > 600) return null;
  return months;
}

/** Срок для поля по числу месяцев: целые годы — в годах, иначе в месяцах. */
export function monthsToTerm(months: number, unit: TermUnit): string {
  if (unit === "years") return Number.isInteger(months / 12) ? String(months / 12) : String(Math.round((months / 12) * 100) / 100).replace(".", ",");
  return String(months);
}

/** «12,5» → 1250 базисных пунктов; пусто — 0. */
export function parseRate(rate: string): number | null {
  if (rate.trim() === "") return 0;
  const bp = parseAmount(rate, 2);
  return bp === null || bp < 0 || bp > 100_000 ? null : bp;
}

const isDate = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d);

/** Заполненные строки «Ставка меняется?»; недописанные пропускаются. */
export function rateChanges(lines: RateLine[]): RateChangeInput[] {
  const out: RateChangeInput[] = [];
  for (const l of lines) {
    if (!isDate(l.from) || l.rate.trim() === "") continue;
    const bp = parseRate(l.rate);
    if (bp !== null) out.push({ from: l.from, rateBp: bp });
  }
  return out.sort((a, b) => a.from.localeCompare(b.from));
}

/** Заполненные строки досрочек; без суммы или даты строка пропускается. */
export function plannedEarly(lines: EarlyLine[], minorUnits = 2): PlannedEarlyInput[] {
  const out: PlannedEarlyInput[] = [];
  for (const l of lines) {
    const amount = parseAmount(l.amount, minorUnits);
    if (amount === null || amount <= 0 || !isDate(l.date)) continue;
    out.push({ amount, startDate: l.date, frequency: l.frequency, endDate: null, mode: l.mode });
  }
  return out;
}

/** Строки досрочек для редактора из записанных плановых досрочек займа. */
export function earlyLines(list: PlannedEarlyInput[], minorUnits = 2): EarlyLine[] {
  return list.map((p) => ({ amount: amountToInput(p.amount, minorUnits), frequency: p.frequency, date: p.startDate, mode: p.mode }));
}

export type FormResult = { input: CalcInput; error: null } | { input: null; error: string };

/** Поля формы → запрос к ядру (planLoan). Ошибка — что ещё ввести. */
export function toCalcInput(f: LoanForm, minorUnits = 2): FormResult {
  const fail = (error: string): FormResult => ({ input: null, error });
  const rateBp = parseRate(f.rate);
  if (rateBp === null) return fail("Проверьте ставку");
  if (!isDate(f.issueDate)) return fail("Укажите дату выдачи");
  const bullet = f.repayment === "bullet";
  const solve: Solve = bullet ? "payment" : f.solve;
  const principal = solve === "principal" ? 1 : parseAmount(f.amount, minorUnits);
  if (principal === null || principal <= 0) return fail("Введите сумму");
  const payment = solve === "payment" ? null : parseAmount(f.payment, minorUnits);
  if (solve !== "payment" && (payment === null || payment <= 0)) return fail("Введите желаемый платёж");
  const base = { principal, rateBp, repayment: f.repayment, issueDate: f.issueDate, interestMethod: f.method };
  if (bullet) {
    if (!isDate(f.maturity)) return fail("Укажите дату возврата");
    return {
      error: null,
      input: { ...base, termMonths: null, firstPaymentDate: null, maturityDate: f.maturity, rateChanges: rateChanges(f.rates), plannedEarly: plannedEarly(f.early, minorUnits), solve: "payment", payment: null },
    };
  }
  const termMonths = solve === "term" ? null : termToMonths(f.term, f.termUnit);
  if (solve !== "term" && termMonths === null) return fail(f.termUnit === "years" ? "Введите срок в годах" : "Введите срок в месяцах (от 1 до 600)");
  return {
    error: null,
    input: {
      ...base,
      termMonths,
      firstPaymentDate: isDate(f.firstPayment) ? f.firstPayment : null,
      maturityDate: null,
      rateChanges: rateChanges(f.rates),
      plannedEarly: plannedEarly(f.early, minorUnits),
      solve,
      payment,
    },
  };
}

export interface Point {
  date: string;
  balance: number;
}

/** Остаток долга по датам: выдача, строки графика и досрочки (после досрочки — её остаток). */
export function balancePoints(view: { rows: LoanRow[]; early: EarlyRow[] }, issueDate: string, principal: number): Point[] {
  const pts: Point[] = [{ date: issueDate, balance: principal }];
  const events: (Point & { order: number })[] = [
    ...view.rows.map((r) => ({ date: r.dueDate, balance: r.balanceAfter, order: 1 })),
    ...view.early.map((e) => ({ date: e.date, balance: e.balanceAfter, order: 0 })),
  ];
  events.sort((a, b) => a.date.localeCompare(b.date) || a.order - b.order);
  for (const e of events) pts.push({ date: e.date, balance: e.balance });
  return pts;
}

/** Дни от 1970-01-01 для оси времени (без часовых поясов). */
export const dayNumber = (date: string) => {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 86_400_000;
};

/** «2 года 3 мес.» */
export function termText(months: number): string {
  const y = Math.floor(months / 12);
  const m = months % 12;
  const years = y % 10 === 1 && y % 100 !== 11 ? "год" : [2, 3, 4].includes(y % 10) && ![12, 13, 14].includes(y % 100) ? "года" : "лет";
  return [y ? `${y} ${years}` : "", m ? `${m} мес.` : ""].filter(Boolean).join(" ") || "0 мес.";
}
