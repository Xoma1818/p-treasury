// Форма займа (калькулятор и «Новый долг» — одна форма): перевод полей в CalcInput
// для ядра и точки диаграммы остатка. Чистые функции, без React.
import type { CalcInput, EarlyFrequency, EarlyRow, InterestMethod, LoanRow, PayEvery, PlannedEarlyInput, RateChangeInput, RatePeriod, RecalcMode, Repayment } from "./api";
import { amountToInput, formatAmount, parseAmount } from "./money";

export type Solve = "payment" | "term" | "principal" | "rate";
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
  /** За какой период введена ставка (и строки «Ставка меняется»). */
  ratePeriod: RatePeriod;
  rates: RateLine[];
  repayment: Repayment;
  /** Как часто платить. */
  payEvery: PayEvery;
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

/** Ставка за период: подпись в списке и после числа. */
export const RATE_PERIODS: Record<RatePeriod, string> = {
  year: "% годовых",
  month: "% в месяц",
  day: "% в день",
};

const PER_YEAR: Record<RatePeriod, number> = { year: 1, month: 12, day: 365 };

export const PAY_EVERY: Record<PayEvery, string> = {
  month: "каждый месяц",
  quarter: "раз в квартал",
  two_weeks: "раз в две недели",
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

/** Ставка за период → годовая в сотых долях процента: «12,5» → 1250,
 *  «1,5» в месяц → 1800, «0,5» в день → 18 250. Пусто — 0; больше 1000 % годовых — ошибка. */
export function parseRate(rate: string, period: RatePeriod = "year"): number | null {
  if (rate.trim() === "") return 0;
  const v = parseAmount(rate, 2);
  if (v === null || v < 0) return null;
  const bp = v * PER_YEAR[period];
  return bp > 100_000 ? null : bp;
}

/** Проценты в сотых без лишних нулей: 50 → «0,5», 1800 → «18». */
const pct = (v: number) => formatAmount(v, 2).replace(/(,\d*?)0+$/, "$1").replace(/,$/, "");

/** Годовая ставка → число для поля в своём периоде (до сотых): 18 250 в день → «0,5». */
export function rateToInput(bp: number, period: RatePeriod = "year"): string {
  return pct(Math.round(bp / PER_YEAR[period]));
}

/** «0,5 % в день», «18 % годовых». */
export function rateLabel(bp: number, period: RatePeriod = "year"): string {
  return `${pct(Math.round(bp / PER_YEAR[period]))} ${RATE_PERIODS[period]}`;
}

/** Пояснение к ставке не за год: «≈ 182,5 % годовых». */
export function annualHint(bp: number, period: RatePeriod): string | undefined {
  return period === "year" || !bp ? undefined : `≈ ${pct(bp)} % годовых`;
}

/** Срок в месяцах → число платежей; раз в квартал — срок кратен трём месяцам. */
export function monthsToPayments(months: number, every: PayEvery): number | null {
  if (every === "quarter") return months % 3 === 0 ? months / 3 : null;
  if (every === "two_weeks") return Math.max(1, Math.round((months * 26) / 12));
  return months;
}

/** Число платежей → месяцы (для поля «срок»). */
export function paymentsToMonths(n: number, every: PayEvery): number {
  return every === "quarter" ? n * 3 : every === "two_weeks" ? Math.round((n * 12) / 26) : n;
}

/** «2 года», «8 платежей раз в квартал (2 года)». */
export function paymentsText(n: number, every: PayEvery = "month"): string {
  if (every === "month") return termText(n);
  const word = n % 10 === 1 && n % 100 !== 11 ? "платёж" : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? "платежа" : "платежей";
  const months = paymentsToMonths(n, every);
  return `${n} ${word} ${PAY_EVERY[every]}${months > 0 ? ` (${every === "two_weeks" ? "≈ " : ""}${termText(months)})` : ""}`;
}

/** Дней между датами YYYY-MM-DD. */
export function daysBetween(from: string, to: string): number | null {
  if (!isDate(from) || !isDate(to)) return null;
  return dayNumber(to) - dayNumber(from);
}

/** Дата через `n` дней. */
export function addDays(date: string, n: number): string {
  if (!isDate(date)) return date;
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

const isDate = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d);

/** Заполненные строки «Ставка меняется?»; недописанные пропускаются. */
export function rateChanges(lines: RateLine[], period: RatePeriod = "year"): RateChangeInput[] {
  const out: RateChangeInput[] = [];
  for (const l of lines) {
    if (!isDate(l.from) || l.rate.trim() === "") continue;
    const bp = parseRate(l.rate, period);
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
  const bullet = f.repayment === "bullet";
  const solve: Solve = bullet ? "payment" : f.solve;
  const rateBp = solve === "rate" ? 0 : parseRate(f.rate, f.ratePeriod);
  if (rateBp === null) return fail("Проверьте ставку: не больше 1000 % годовых");
  if (!isDate(f.issueDate)) return fail("Укажите дату выдачи");
  const principal = solve === "principal" ? 1 : parseAmount(f.amount, minorUnits);
  if (principal === null || principal <= 0) return fail("Введите сумму");
  const payment = solve === "payment" ? null : parseAmount(f.payment, minorUnits);
  if (solve !== "payment" && (payment === null || payment <= 0)) return fail("Введите желаемый платёж");
  const base = { principal, rateBp, repayment: f.repayment, issueDate: f.issueDate, interestMethod: f.method, ratePeriod: f.ratePeriod, payEvery: bullet ? ("month" as const) : f.payEvery };
  const rates = rateChanges(f.rates, f.ratePeriod);
  if (bullet) {
    if (!isDate(f.maturity)) return fail("Укажите дату возврата");
    return {
      error: null,
      input: { ...base, termMonths: null, firstPaymentDate: null, maturityDate: f.maturity, rateChanges: rates, plannedEarly: plannedEarly(f.early, minorUnits), solve: "payment", payment: null },
    };
  }
  const months = solve === "term" ? null : termToMonths(f.term, f.termUnit);
  if (solve !== "term" && months === null) return fail(f.termUnit === "years" ? "Введите срок в годах" : "Введите срок в месяцах (от 1 до 600)");
  // Срок у ядра — число платежей: раз в квартал срок кратен трём месяцам.
  const termMonths = months === null ? null : monthsToPayments(months, f.payEvery);
  if (months !== null && termMonths === null) return fail("Раз в квартал: срок кратен трём месяцам");
  return {
    error: null,
    input: {
      ...base,
      termMonths,
      firstPaymentDate: isDate(f.firstPayment) ? f.firstPayment : null,
      maturityDate: null,
      rateChanges: rates,
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

/** Дата через `n` месяцев; 31.01 + 1 месяц = 28/29.02, как в графике ядра. */
export function addMonths(date: string, n: number): string {
  if (!isDate(date)) return date;
  const [y, m, d] = date.split("-").map(Number);
  const i = y * 12 + (m - 1) + n;
  const yy = Math.floor(i / 12);
  const mm = (i % 12) + 1;
  const last = new Date(yy, mm, 0).getDate();
  return `${yy}-${String(mm).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}
