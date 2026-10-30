// Типизированный доступ к командам ядра. UI не пишет SQL и не знает о базе.
import { invoke } from "@tauri-apps/api/core";

export interface AppInfo {
  version: string;
  schemaVersion: number;
  supportedSchemaVersion: number;
  dbPath: string;
  preMigrationBackup: string | null;
  onboardingDone: boolean;
  today: string;
  /** Переносная версия: данные в папке data рядом с программой. */
  portable: boolean;
  dataDir: string;
}

export interface BudgetFileRow {
  name: string;
  path: string;
  current: boolean;
  missing: boolean;
  main: boolean;
}

export interface Currency {
  code: string;
  name: string;
  symbol: string;
  minorUnits: number;
}

export interface ExchangeRate {
  date: string;
  fromCode: string;
  toCode: string;
  rate: string;
  /** `manual` — введён вручную, `cbr` — загружен с сайта ЦБ РФ. */
  source: string;
}

export interface CbrImport {
  /** Дата, на которую ЦБ установил курсы (в выходные — последний рабочий день). */
  date: string;
  updated: string[];
  keptManual: string[];
  missing: string[];
}

export type AccountType = "cash" | "debit" | "credit" | "savings" | "investment";

/** Вид брокерского счёта: обычный, ИИС или ПДС. */
export type InvestKind = "broker" | "iis" | "pds";

export interface Account {
  id: string;
  name: string;
  type: AccountType;
  currencyCode: string;
  currencySymbol: string;
  minorUnits: number;
  openingBalance: number;
  openingDate: string;
  creditLimit: number | null;
  includeInTotal: boolean;
  sortOrder: number;
  archived: boolean;
  balance: number;
  available: number | null;
  /** Для брокерского счёта. */
  investKind: InvestKind | null;
  /** Для брокерского счёта: сколько стоит сейчас. */
  value: number | null;
}

export interface AccountInput {
  name: string;
  type: AccountType;
  currencyCode: string;
  openingBalance: number;
  openingDate: string;
  creditLimit: number | null;
  includeInTotal: boolean;
  investKind?: InvestKind | null;
}

export interface Totals {
  baseCurrency: string;
  baseSymbol: string;
  total: number;
  missingRates: string[];
}

export type CategoryKind = "expense" | "income";

export interface Category {
  id: string;
  parentId: string | null;
  name: string;
  kind: CategoryKind;
  sortOrder: number;
  archived: boolean;
  transactionCount: number;
}

export type TxnType = "expense" | "income" | "transfer" | "adjustment";

export interface TxnInput {
  type: TxnType;
  date: string;
  accountId: string;
  amount: number;
  categoryId: string | null;
  toAccountId: string | null;
  toAmount: number | null;
  payee: string | null;
  note: string | null;
}

export interface Txn {
  id: string;
  type: TxnType;
  date: string;
  accountId: string;
  accountName: string;
  currencySymbol: string;
  minorUnits: number;
  amount: number;
  toAccountId: string | null;
  toAccountName: string | null;
  toCurrencySymbol: string | null;
  toMinorUnits: number | null;
  toAmount: number | null;
  categoryId: string | null;
  categoryName: string | null;
  payee: string | null;
  note: string | null;
  debtId: string | null;
  eventId: string | null;
  eventName: string | null;
  /** Общий идентификатор частей разбитого чека (Г3). */
  splitId: string | null;
  /** Трата учитывается в месячных расчётах N месяцев (2–24). */
  spreadMonths: number | null;
  /** Теги операции по алфавиту. */
  tags: string[];
}

export interface TxnFilter {
  dateFrom?: string;
  dateTo?: string;
  accountId?: string;
  categoryId?: string;
  types?: TxnType[];
  search?: string;
  /** Операции поездки или события. */
  eventId?: string;
  /** Операции с тегом. */
  tagId?: string;
  limit?: number;
  offset?: number;
}

export interface Page {
  items: Txn[];
  total: number;
}

export interface PayeeHint {
  payee: string;
  categoryId: string | null;
  accountId: string;
}

export interface Defaults {
  accountId: string | null;
  categoryId: string | null;
  toAccountId: string | null;
}

export interface PeriodSummary {
  baseCurrency: string;
  income: number;
  expense: number;
  adjustments: number;
  savingsRate: number | null;
  missingRates: string[];
}

export interface CategoryItem {
  categoryId: string;
  name: string;
  amount: number;
  percent: number;
  children: CategoryItem[];
}

export interface CategoryReport {
  baseCurrency: string;
  total: number;
  items: CategoryItem[];
  missingRates: string[];
}

export type CompareBy = "category" | "payee" | "account";

/** Два периода: `a` — с чем сравниваем, `b` — что сравниваем. */
export interface ComparePeriods {
  aFrom: string;
  aTo: string;
  bFrom: string;
  bTo: string;
}

export interface CompareRow {
  key: string;
  name: string;
  a: number;
  b: number;
  diff: number;
  percent: number | null;
  presence: "both" | "onlyA" | "onlyB";
  children: CompareRow[];
}

export interface Comparison {
  baseCurrency: string;
  kind: CategoryKind;
  by: CompareBy;
  summaryA: PeriodSummary;
  summaryB: PeriodSummary;
  totalA: number;
  totalB: number;
  diff: number;
  percent: number | null;
  rows: CompareRow[];
  missingRates: string[];
}

export interface MonthRow {
  period: Period;
  income: number;
  expense: number;
  balance: number;
  savingsRate: number | null;
}

export interface MonthsReport {
  baseCurrency: string;
  months: MonthRow[];
  income: number;
  expense: number;
  balance: number;
  savingsRate: number | null;
  missingRates: string[];
}

export interface BalanceRow {
  accountId: string;
  name: string;
  type: string;
  currencyCode: string;
  currencySymbol: string;
  minorUnits: number;
  balance: number;
  baseValue: number | null;
  includeInTotal: boolean;
  archived: boolean;
}

export interface BalancesReport {
  date: string;
  baseCurrency: string;
  rows: BalanceRow[];
  total: number;
  missingRates: string[];
}

export type Repayment = "annuity" | "differentiated" | "bullet";
export type Direction = "lent" | "borrowed";

export interface LoanInput {
  principal: number;
  rateBp: number;
  repayment: Repayment;
  termMonths: number | null;
  issueDate: string;
  firstPaymentDate: string | null;
  maturityDate: string | null;
  /** По умолчанию `monthly` (как раньше). */
  interestMethod?: InterestMethod;
  /** За какой период введена ставка; `rateBp` всегда годовая. */
  ratePeriod?: RatePeriod;
  /** Как часто платить; `termMonths` тогда — число платежей. */
  payEvery?: PayEvery;
}

export interface LoanRow {
  seq: number;
  dueDate: string;
  payment: number;
  principalPart: number;
  interestPart: number;
  balanceAfter: number;
}

export interface Schedule {
  rows: LoanRow[];
  firstPayment: number;
  lastPayment: number;
  totalPayment: number;
  totalInterest: number;
  maturityDate: string;
}

export interface DebtInput {
  direction: Direction;
  counterparty: string;
  note: string | null;
  currencyCode: string;
  principal: number;
  issueDate: string;
  rateBp: number;
  repaymentType: Repayment;
  termMonths: number | null;
  firstPaymentDate: string | null;
  maturityDate: string | null;
  accountId: string | null;
  /** По умолчанию `daily`. */
  interestMethod?: InterestMethod;
  ratePeriod?: RatePeriod;
  payEvery?: PayEvery;
  rateChanges?: RateChangeInput[];
  plannedEarly?: PlannedEarlyInput[];
}

export interface ScheduleRow extends LoanRow {
  id: string;
  status: "pending" | "paid" | "partial";
  overdue: boolean;
}

export interface DebtPayment {
  id: string;
  date: string;
  principal: number;
  interest: number;
  scheduleSeq: number | null;
  recalcMode: string | null;
  accountName: string | null;
}

export interface DebtCard {
  id: string;
  direction: Direction;
  counterparty: string;
  note: string | null;
  accountId: string;
  currencyCode: string;
  currencySymbol: string;
  minorUnits: number;
  principal: number;
  issueDate: string;
  rateBp: number;
  repaymentType: Repayment;
  termMonths: number | null;
  maturityDate: string;
  status: "active" | "closed";
  outstanding: number;
  principalPaid: number;
  interestPaid: number;
  interestPlanned: number;
  nextPayment: ScheduleRow | null;
  overdueCount: number;
  overdueAmount: number;
  defaultAccountId: string | null;
  interestMethod: InterestMethod;
  ratePeriod: RatePeriod;
  payEvery: PayEvery;
  firstPaymentDate: string | null;
}

export interface DebtDetail {
  card: DebtCard;
  schedule: ScheduleRow[];
  payments: DebtPayment[];
  rateChanges: (RateChangeInput & { id: string })[];
  holidays: (HolidayInput & { id: string })[];
  plannedEarly: (PlannedEarlyInput & { id: string })[];
  rowAmounts: (RowAmountInput & { id: string })[];
}

// --- Займы 0.16 ---

export type InterestMethod = "daily" | "monthly";
export type RecalcMode = "reduce_payment" | "reduce_term";
export type HolidayKind = "interest_only" | "shift";
export type EarlyFrequency = "once" | "monthly" | "quarterly" | "yearly";
export type RatePeriod = "year" | "month" | "day";
export type PayEvery = "month" | "quarter" | "two_weeks";

/** Своя сумма строки графика: следующие строки пересчитываются. */
export interface RowAmountInput {
  seq: number;
  amount: number;
  mode: RecalcMode;
}

export interface RateChangeInput {
  /** С какой даты действует ставка, YYYY-MM-DD. */
  from: string;
  rateBp: number;
}

export interface HolidayInput {
  fromSeq: number;
  /** 1–12. */
  months: number;
  kind: HolidayKind;
}

export interface PlannedEarlyInput {
  amount: number;
  startDate: string;
  frequency: EarlyFrequency;
  endDate: string | null;
  mode: RecalcMode;
}

/** Строка расчёта: строка графика с отметкой и видом. */
export interface SimRow extends LoanRow {
  status: "pending" | "paid" | "partial";
  kind: "regular" | "interest_only" | "after_shift";
}

/** Досрочный платёж (фактический или плановый) — не строка графика. */
export interface EarlyRow {
  date: string;
  principal: number;
  interest: number;
  balanceAfter: number;
  planned: boolean;
}

export interface LoanTotals {
  /** Ближайший неоплаченный платёж (0 — закрыт). */
  payment: number;
  totalInterest: number;
  totalPayment: number;
  maturityDate: string;
  rowsLeft: number;
  interestLeft: number;
}

export interface SimView {
  rows: SimRow[];
  early: EarlyRow[];
  totals: LoanTotals;
}

export interface CalcInput extends LoanInput {
  rateChanges?: RateChangeInput[];
  holidays?: HolidayInput[];
  plannedEarly?: PlannedEarlyInput[];
  rowAmounts?: RowAmountInput[];
  /** Что рассчитать; по умолчанию платёж. */
  solve?: "payment" | "term" | "principal" | "rate";
  /** Желаемый платёж для расчёта срока или суммы. */
  payment?: number | null;
}

export interface CalcResult {
  principal: number;
  /** Годовая ставка (рассчитанная, если считали ставку). */
  rateBp: number;
  termMonths: number | null;
  payment: number;
  base: SimView;
  withEarly: SimView | null;
  savings: number;
}

export interface TermsInput {
  principal: number;
  issueDate: string;
  rateBp: number;
  repaymentType: Repayment;
  termMonths: number | null;
  firstPaymentDate: string | null;
  maturityDate: string | null;
  interestMethod: InterestMethod;
  ratePeriod?: RatePeriod;
  payEvery?: PayEvery;
}

export interface QuoteInput {
  date: string;
  amount: number;
  kind: "scheduled" | "early";
  mode?: RecalcMode | null;
}

export interface Quote {
  interest: number;
  principal: number;
  before: SimView;
  after: SimView;
  newPayment: number;
  savings: number;
  compare: LoanCompare;
}

export interface Forecast {
  from: string;
  rows: SimRow[];
  early: EarlyRow[];
  totals: LoanTotals;
  base: LoanTotals;
  savings: number;
}

/** Предпросмотр правки условий: с уже внесёнными платежами, ставками и каникулами. */
export interface TermsPreview {
  before: SimView;
  after: SimView;
  compare: LoanCompare;
}

/** Итоги займа для «было → станет» перед сохранением. */
export interface LoanSnap {
  rateBp: number;
  /** С какой даты действует ставка; null — с выдачи. */
  rateFrom: string | null;
  ratePeriod: RatePeriod;
  payments: number;
  paymentsLeft: number;
  payment: number;
  /** Переплата: все проценты за весь срок. */
  overpayment: number;
  maturityDate: string;
}

export interface LoanCompare {
  before: LoanSnap;
  after: LoanSnap;
}

/** Несохранённое изменение займа для предпросмотра. */
export type LoanChangeInput =
  | { kind: "rateChange"; from: string; rateBp: number }
  | { kind: "holiday"; fromSeq: number; months: number; holidayKind: HolidayKind }
  | { kind: "rowAmount"; seq: number; amount: number; mode: RecalcMode }
  | { kind: "plannedEarly"; list: PlannedEarlyInput[] };

export interface DebtVersion {
  /** null у текущего графика. */
  id: string | null;
  createdAt: string;
  reason: string;
  payment: number;
  totalInterest: number;
  totalPayment: number;
  maturityDate: string;
  rows: (LoanRow & { status: string })[];
}

export interface DebtVersions {
  /** От старых к новым; каждый — график до изменения из reason. */
  versions: DebtVersion[];
  current: DebtVersion;
  savings: number;
}

export interface ScheduleDoc {
  title: string;
  lenderName: string;
  borrowerName: string;
  terms: {
    principal: number;
    currencyCode: string;
    currencySymbol: string;
    minorUnits: number;
    rateBp: number;
    rateChanges: RateChangeInput[];
    holidays: HolidayInput[];
    termMonths: number | null;
    repaymentType: Repayment;
    interestMethod: InterestMethod;
    issueDate: string;
    firstPaymentDate: string | null;
  };
  rows: {
    seq: number | null;
    date: string;
    payment: number;
    interest: number;
    principal: number;
    balance: number;
    paid: boolean;
    note: string | null;
  }[];
  totals: { totalPayment: number; overpayment: number; maturityDate: string };
  withSignatures: boolean;
  createdOn: string;
}

export interface PaymentInput {
  date: string;
  accountId: string;
  principal: number;
  interest: number;
  scheduleId: string | null;
  recalcMode: "reduce_payment" | "reduce_term" | null;
}

export interface UpcomingPayment {
  debtId: string;
  scheduleId: string;
  counterparty: string;
  direction: Direction;
  dueDate: string;
  payment: number;
  currencySymbol: string;
  minorUnits: number;
  overdue: boolean;
}

export interface DebtSummary {
  baseCurrency: string;
  baseSymbol: string;
  owedToMe: number;
  iOwe: number;
  /** Имущество по последней оценке. */
  assets: number;
  netWorth: number;
  accountsTotal: number;
  missingRates: string[];
  upcoming: UpcomingPayment[];
}

export const REPAYMENTS: Record<Repayment, string> = {
  annuity: "Аннуитет (равные платежи)",
  differentiated: "Дифференцированный",
  bullet: "Разовый возврат в конце",
};

export type ReportPeriodKind = "month" | "quarter" | "year";

export interface Period {
  /** «2026-11» */
  month: string;
  start: string;
  end: string;
}

export interface BudgetLine {
  categoryId: string;
  categoryName: string;
  parentId: string | null;
  kind: CategoryKind;
  limit: number;
  actual: number;
  remaining: number;
  percent: number;
  over: boolean;
}

export interface Budget {
  id: string | null;
  period: Period;
  currencyCode: string;
  currencySymbol: string;
  note: string | null;
  lines: BudgetLine[];
  plannedExpense: number;
  plannedIncome: number;
  actualExpense: number;
  actualIncome: number;
  unbudgetedExpense: number;
  /** Расходы поездок и событий за месяц: в факт бюджета не входят. */
  eventExpense: number;
  safeToSpendToday: number | null;
  /** Расходы по лимитам к концу месяца при текущем темпе (только текущий месяц). */
  forecastExpense: number | null;
  missingRates: string[];
}

/** Откуда брать лимиты: среднее за 3 месяца или тот же месяц год назад. */
export type FillMode = "average3" | "last_year";

export interface Cushion {
  baseCurrency: string;
  baseSymbol: string;
  liquid: number;
  avgMonthlyExpense: number | null;
  /** Месяцы в десятых: 42 = 4,2 месяца. */
  monthsTenths: number | null;
  monthsCounted: number;
  goalMonths: number;
  missingRates: string[];
}

/** Известная по дате сумма прогноза: + приход, − расход, в основной валюте. */
export interface ForecastItem {
  date: string;
  title: string;
  /** `reminder`, `debt`, `planned` или `change` (изменение сценария). */
  kind: "reminder" | "debt" | "planned" | "change";
  amount: number;
}

/** Цель со сроком внутри прогноза: `free` < 0 — к сроку не хватит. */
export interface GoalMark {
  id: string;
  name: string;
  deadline: string;
  month: string;
  need: number;
  closing: number;
  free: number;
}
export interface ForecastAccount {
  id: string;
  name: string;
  included: boolean;
}
export interface ForecastMonth {
  month: string;
  start: string;
  end: string;
  opening: number;
  regularIncome: number;
  regularExpense: number;
  plannedIncome: number;
  plannedExpense: number;
  /** Поправка на сезонность (со знаком), уже входит в `regular*`. */
  seasonIncome: number;
  seasonExpense: number;
  closing: number;
  items: ForecastItem[];
  scenario: { delta: number; closing: number; items: ForecastItem[] } | null;
}

export interface Forecast {
  baseCurrency: string;
  currencySymbol: string;
  minorUnits: number;
  today: string;
  liquid: number;
  historyMonths: number;
  avgIncome: number;
  avgExpense: number;
  excludedCategories: string[];
  /** Учтена сезонность: учёт ведётся не меньше года. */
  seasonal: boolean;
  /** Счета, выключенные из прогноза. */
  excludedAccounts: string[];
  goals: GoalMark[];
  months: ForecastMonth[];
  lowestMonth: string;
  lowestBalance: number;
  shortMonth: string | null;
  cushionTenths: number | null;
  scenarioId: string | null;
  scenarioName: string | null;
  scenarioLowestBalance: number | null;
  scenarioShortMonth: string | null;
  missingRates: string[];
}

export type ChangeKind = "once" | "monthly" | "income_pct" | "expense_pct";

export interface ChangeInput {
  kind: ChangeKind;
  title: string;
  /** Для once и monthly: + доход, − трата. */
  amount: number | null;
  /** Для income_pct и expense_pct: от −100 до 1000. */
  percent: number | null;
  startMonth: string;
  months: number | null;
}

export interface ScenarioChange extends ChangeInput {
  id: string;
}

export interface Scenario {
  id: string;
  name: string;
  changes: ScenarioChange[];
}

export interface FlowNode {
  id: string;
  name: string;
  amount: number;
}

export interface MoneyFlow {
  baseCurrency: string;
  currencySymbol: string;
  minorUnits: number;
  period: Period;
  income: FlowNode[];
  expense: FlowNode[];
  totalIncome: number;
  totalExpense: number;
  invested: number;
  saved: number;
  missingRates: string[];
}

export interface Valuation {
  date: string;
  value: number;
}

export type InvestPlanMode = "" | "amount" | "percent";

export interface InvestMonth {
  month: string;
  start: string;
  end: string;
  /** onlyMonth — свой план только на этот месяц. */
  plan: { mode: InvestPlanMode; value: number; onlyMonth: boolean };
  /** План в основной валюте; для процента — от доходов месяца. */
  planned: number | null;
  income: number;
  /** Отложено: переводы на брокерские счета минус выводы. */
  saved: number;
  percent: number | null;
  missingRates: string[];
}

export interface InvestAccount {
  id: string;
  name: string;
  investKind: InvestKind;
  currencyCode: string;
  currencySymbol: string;
  minorUnits: number;
  invested: number;
  value: number;
  result: number;
  valuedOn: string | null;
  history: Valuation[];
}

export interface InvestOverview {
  baseCurrency: string;
  baseSymbol: string;
  accounts: InvestAccount[];
  invested: number;
  value: number;
  result: number;
  /** Результат в десятых процента: 67 = 6,7 %. */
  resultTenths: number | null;
  month: InvestMonth;
  tax: { year: number; contributed: number; limit: number; left: number; deduction: number } | null;
  passiveIncome: number;
  missingRates: string[];
}

export interface FxRow {
  accountId: string;
  name: string;
  currencyCode: string;
  currencySymbol: string;
  minorUnits: number;
  startBalance: number;
  endBalance: number;
  startRate: string | null;
  endRate: string | null;
  gain: number | null;
  avgBuyRate: string | null;
  bought: number;
}

export interface FxReport {
  baseCurrency: string;
  baseSymbol: string;
  rows: FxRow[];
  totalGain: number;
  missingRates: string[];
}

export type ViewKind = "transactions" | "report";

/** Черновик операции из строки быстрого ввода или текста SMS банка. */
export interface QuickDraft {
  type: "expense" | "income" | "transfer";
  amount: number | null;
  date: string;
  accountId: string | null;
  toAccountId: string | null;
  categoryId: string | null;
  payee: string | null;
  merchant: string | null;
  ruleId: string | null;
  source: "line" | "sms";
  missing: string[];
  /** Теги из слов с «#»: «леруа 4500 #ремонт». */
  tags: string[];
}

/** Правило автокатегоризации: текст получателя → категория. */
export interface Rule {
  id: string;
  pattern: string;
  categoryId: string;
  categoryName: string;
  kind: "expense" | "income";
  payee: string | null;
}

export interface RuleInput {
  pattern: string;
  categoryId: string;
  payee: string | null;
}

export type AssetKind = "realty" | "vehicle" | "other";

export interface AssetInput {
  name: string;
  kind: AssetKind;
  currencyCode: string;
  value: number;
  date: string;
  note: string | null;
}

export interface Asset {
  id: string;
  name: string;
  kind: AssetKind;
  currencyCode: string;
  currencySymbol: string;
  minorUnits: number;
  note: string | null;
  value: number;
  valuedOn: string;
  history: { date: string; value: number }[];
}

export interface EventInput {
  name: string;
  startDate: string;
  endDate: string;
  budget: number | null;
  note: string | null;
}

export interface BudgetEvent {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  budget: number | null;
  note: string | null;
  spent: number;
  count: number;
  unassigned: number;
  baseSymbol: string;
  baseMinorUnits: number;
  state: "upcoming" | "current" | "past";
  missingRates: string[];
}

export interface SplitInput {
  date: string;
  accountId: string;
  categoryId: string;
  payee: string | null;
  note: string | null;
  total: number;
  myShare: number;
  friends: { name: string; amount: number }[];
}

export interface WeekSummary {
  from: string;
  to: string;
  expense: number;
  income: number;
  prevExpense: number;
  noSpendDays: number;
  topCategory: string | null;
  topAmount: number;
  streak: number;
  currencySymbol: string;
  minorUnits: number;
}

export interface SavedView {
  id: string;
  name: string;
  kind: ViewKind;
  /** JSON с параметрами вида. */
  params: string;
}

export interface Setup {
  baseCurrency: string;
  accounts: AccountInput[];
  defaultCategories: boolean;
}

export type Settings = Record<string, string>;

export type Repeat = "once" | "daily" | "weekly" | "monthly" | "yearly";

export const REPEATS: Record<Repeat, string> = {
  once: "Один раз",
  daily: "Ежедневно",
  weekly: "Еженедельно",
  monthly: "Ежемесячно",
  yearly: "Ежегодно",
};

export interface ReminderKey {
  source: "reminder" | "debt";
  refId: string;
  scheduledAt: string;
}

export interface Occurrence {
  key: ReminderKey;
  title: string;
  amount: number | null;
  currencySymbol: string;
  minorUnits: number;
  txnType: "expense" | "income" | null;
  accountId: string | null;
  categoryId: string | null;
  note: string | null;
  debtId: string | null;
  dueDate: string | null;
  status: "pending" | "done" | "snoozed" | "dismissed";
  dueAt: string;
  notifiedAt: string | null;
  completedAt: string | null;
  transactionId: string | null;
}

export interface ReminderInput {
  title: string;
  /** «2026-11-10T09:00», местное время. */
  startAt: string;
  repeat: Repeat;
  dayOfMonth: number | null;
  endDate: string | null;
  amount: number | null;
  txnType: "expense" | "income" | null;
  accountId: string | null;
  categoryId: string | null;
  note: string | null;
}

export interface Reminder extends ReminderInput {
  id: string;
  active: boolean;
  nextAt: string | null;
}

export interface RemindersOverview {
  overdue: Occurrence[];
  upcoming: Occurrence[];
  done: Occurrence[];
  reminders: Reminder[];
}

export interface NoteInput {
  body: string;
  date: string | null;
  transactionId?: string | null;
  accountId?: string | null;
  debtId?: string | null;
  budgetId?: string | null;
}

export interface Note extends NoteInput {
  id: string;
  link: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NoteFilter {
  query?: string;
  dateFrom?: string;
  dateTo?: string;
  transactionId?: string;
  accountId?: string;
  debtId?: string;
  budgetId?: string;
}

export interface DebtDue {
  debtId: string;
  scheduleId: string;
  counterparty: string;
  direction: Direction;
  payment: number;
  currencySymbol: string;
  minorUnits: number;
  status: ScheduleRow["status"];
}

export interface CalendarDay {
  date: string;
  income: number;
  expense: number;
  debts: DebtDue[];
  reminders: Occurrence[];
  notes: number;
  /** Заметки дня и комментарии к операциям — текст для клетки календаря. */
  memos: string[];
  /** День без трат (прошедший, учёт уже вёлся). */
  noSpend: boolean;
}

export interface CalendarMonth {
  month: string;
  baseCurrency: string;
  currencySymbol: string;
  minorUnits: number;
  days: CalendarDay[];
  income: number;
  expense: number;
  plannedExpense: number;
  plannedIncome: number;
  missingRates: string[];
}

export interface ImportRow {
  line: number;
  date: string;
  type: string;
  account: string;
  amount: string;
  category: string;
  payee: string;
  error: string | null;
  duplicate: boolean;
}

export interface ImportPreview {
  rows: ImportRow[];
  valid: number;
  errors: number;
  duplicates: number;
  /** «Сбер», «Т-Банк»; null — CSV по шаблону. */
  bank: string | null;
  accountId: string | null;
}

export interface BackupStatus {
  lastBackupAt: string | null;
  autobackupDir: string;
  autobackupKeep: string;
  reminderDue: boolean;
  defaultName: string;
}

/** Папка сохранности: копия базы, прошлые копии и Excel-зеркало. */
export interface VaultStatus {
  on: boolean;
  dir: string;
  defaultDir: string;
  custom: boolean;
  syncedAt: string | null;
  error: string | null;
  keep: string;
  /** Последняя копия, прошедшая проверку восстановления. */
  verified: VerifiedBackup | null;
  /** Ошибка последней проверки восстановления. */
  verifyError: string | null;
}

export interface VerifiedBackup {
  path: string;
  checkedAt: string;
  schemaVersion: number;
  accounts: number;
  transactions: number;
  lastDate: string | null;
}

export interface VaultPlace {
  label: string;
  path: string;
}

/** Данные, найденные для переноса: копия `.ptreasury` или «Все данные.xlsx». */
export interface VaultFound {
  path: string;
  name: string;
  kind: "copy" | "excel";
  accounts: number;
  transactions: number;
  lastDate: string | null;
  savedAt: string | null;
  folder: string | null;
}

export interface BackupInfo {
  path: string;
  schemaVersion: number;
  accounts: number;
  transactions: number;
  lastDate: string | null;
}

export interface UpdateInfo {
  configured: boolean;
  current: string;
  version: string | null;
  notes: string | null;
}

export interface TemplateInput {
  name: string;
  type: "expense" | "income" | "transfer";
  amount: number | null;
  accountId: string | null;
  toAccountId: string | null;
  categoryId: string | null;
  payee: string | null;
  note: string | null;
}

export interface Template extends TemplateInput {
  id: string;
  currencySymbol: string | null;
  minorUnits: number;
  /** Хватает данных, чтобы создать операцию сразу. */
  complete: boolean;
  useCount: number;
}

export interface UndoStep {
  id: number;
  label: string;
}

export interface UndoState {
  undo: UndoStep | null;
  redo: UndoStep | null;
}

export interface GoalInput {
  name: string;
  target: number;
  currencyCode: string;
  accountId: string | null;
  deadline: string | null;
}

export type GoalStatus = "reached" | "on_track" | "behind" | "no_pace";

export interface Goal {
  id: string;
  name: string;
  target: number;
  currencyCode: string;
  currencySymbol: string;
  minorUnits: number;
  accountId: string | null;
  accountName: string | null;
  deadline: string | null;
  saved: number;
  percent: number;
  remaining: number;
  pacePerMonth: number | null;
  forecastDate: string | null;
  /** Больше 100 лет при нынешнем темпе: даты нет. */
  forecastFar: boolean;
  needPerMonth: number | null;
  status: GoalStatus;
  missingRate: boolean;
}

export type SubPeriod = "week" | "month" | "quarter" | "year";

export const SUB_PERIODS: Record<SubPeriod, string> = {
  week: "в неделю",
  month: "в месяц",
  quarter: "в квартал",
  year: "в год",
};

export interface Subscription {
  key: string;
  payee: string;
  categoryName: string | null;
  period: SubPeriod;
  amount: number;
  currencySymbol: string;
  minorUnits: number;
  baseAmount: number | null;
  yearly: number | null;
  count: number;
  lastDate: string;
  nextDate: string;
  hidden: boolean;
}

export interface SubscriptionsReport {
  baseCurrency: string;
  items: Subscription[];
  yearlyTotal: number;
  monthlyTotal: number;
}

export interface YearReview {
  year: number;
  baseCurrency: string;
  income: number;
  expense: number;
  savingsRate: number | null;
  prevIncome: number;
  prevExpense: number;
  months: MonthRow[];
  bestMonth: string | null;
  costliestMonth: string | null;
  topCategories: CategoryItem[];
  biggestPurchase: { date: string; amount: number; payee: string | null; categoryName: string | null } | null;
  topPayee: { name: string; count: number; amount: number } | null;
  noSpendDays: number;
  days: number;
  transactionCount: number;
  missingRates: string[];
}

export interface SearchHit {
  /** `tag` — открыть операции с тегом (id тега). */
  kind: "note" | "event" | "debt" | "asset" | "goal" | "tag";
  id: string;
  title: string;
  detail: string | null;
}

export interface ImportFileResult {
  name: string;
  added: number;
  skipped: number;
  error: string | null;
}

export interface ScanResult {
  files: ImportFileResult[];
  added: number;
}

// --- 0.16 «Быстрые победы» ---

/** Дополнения формы операции: «Учитывать по месяцам» и теги. */
export interface TxnExtra {
  /** 2–24 или null — в месяце траты. Только для расхода. */
  spreadMonths: number | null;
  tags: string[];
}

/** Итог выделенных или найденных операций в основной валюте (Г1). */
export interface Sums {
  baseCurrency: string;
  count: number;
  expense: number;
  income: number;
  /** Доходы − расходы. */
  total: number;
  missingRates: string[];
}

/** Результат массового действия (Г2). */
export interface BulkResult {
  changed: number;
  /** Пропущено: переводы и корректировки при смене категории, платежи по долгам, другая валюта. */
  skipped: number;
}

export interface ReceiptPartInput {
  categoryId: string;
  amount: number;
  note?: string | null;
}

export interface ReceiptInput {
  date: string;
  accountId: string;
  payee: string | null;
  note: string | null;
  /** Сумма чека; сумма строк должна быть равна ей. */
  total: number;
  parts: ReceiptPartInput[];
  tags?: string[];
  /** Событие всего чека; null снимает привязку при сохранении. */
  eventId?: string | null;
}

export interface ReceiptPart {
  id: string;
  categoryId: string;
  categoryName: string;
  amount: number;
  note: string | null;
}

export interface Receipt {
  splitId: string;
  date: string;
  accountId: string;
  payee: string | null;
  total: number;
  eventId: string | null;
  tags: string[];
  parts: ReceiptPart[];
}

export interface Tag {
  id: string;
  name: string;
  count: number;
}

export interface TagReport {
  tagId: string;
  name: string;
  baseCurrency: string;
  from: string;
  to: string;
  expense: number;
  income: number;
  count: number;
  byCategory: { categoryId: string; name: string; amount: number }[];
  byMonth: { month: string; expense: number; income: number }[];
  missingRates: string[];
}

/** Сравнение категории с обычным (А2). */
export interface UsualRow {
  categoryId: string;
  parentId: string | null;
  name: string;
  current: number;
  usual: number;
  diff: number;
  /** +34 или −40; null, если обычно 0. */
  percent: number | null;
  /** Разница ≥ 25 % и ≥ 1 000 в основной валюте. */
  notable: boolean;
}

export interface UsualReport {
  month: string;
  baseCurrency: string;
  baseSymbol: string;
  from: string;
  to: string;
  /** 0 — истории нет, сравнение не показывается. */
  monthsCounted: number;
  items: UsualRow[];
  /** «Необычно в этом месяце»: до трёх верхних категорий. */
  home: UsualRow[];
  missingRates: string[];
}

/** Строка карточки «Проверьте» (А3). */
export interface Check {
  key: string;
  kind: "duplicate" | "large" | "price";
  title: string;
  detail: string;
  date: string;
  transactionId: string;
  /** У дубля — операция для «Удалить второй». */
  secondId: string | null;
}

/** Чистые активы на конец месяца (В3). */
export interface NetWorthPoint {
  month: string;
  date: string;
  cash: number;
  investments: number;
  assets: number;
  owedToMe: number;
  iOwe: number;
  net: number;
  change: number | null;
}

export interface NetWorthHistory {
  baseCurrency: string;
  baseSymbol: string;
  points: NetWorthPoint[];
  missingRates: string[];
}

export const isTauri = () => "__TAURI_INTERNALS__" in window;

export const api = {
  appInfo: () => invoke<AppInfo>("app_info"),
  getSettings: () => invoke<Settings>("get_settings"),
  setSetting: (key: string, value: string) => invoke<void>("set_setting", { key, value }),
  listCurrencies: () => invoke<Currency[]>("list_currencies"),
  listRates: () => invoke<ExchangeRate[]>("list_rates"),
  setRate: (date: string, from: string, to: string, rate: string) => invoke<void>("set_rate", { date, from, to, rate }),
  deleteRate: (date: string, from: string, to: string) => invoke<void>("delete_rate", { date, from, to }),
  rateOn: (from: string, to: string, date: string) => invoke<string | null>("rate_on", { from, to, date }),
  loadCbrRates: (date: string) => invoke<CbrImport>("load_cbr_rates", { date }),
  /** Автозагрузка курсов раз в день; `null` — выключена или сегодня уже была. */
  autoCbrRates: (date: string) => invoke<CbrImport | null>("auto_cbr_rates", { date }),
  finishOnboarding: (setup: Setup) => invoke<void>("finish_onboarding", { setup }),
  seedDemo: () => invoke<void>("seed_demo"),
  clearDemo: () => invoke<void>("clear_demo"),
  listAccounts: (includeArchived = false) => invoke<Account[]>("list_accounts", { includeArchived }),
  createAccount: (input: AccountInput) => invoke<string>("create_account", { input }),
  updateAccount: (id: string, input: AccountInput) => invoke<void>("update_account", { id, input }),
  archiveAccount: (id: string, archived: boolean) => invoke<void>("archive_account", { id, archived }),
  adjustBalance: (id: string, actualBalance: number, date: string, note: string | null) =>
    invoke<string | null>("adjust_balance", { id, actualBalance, date, note }),
  totals: (date: string) => invoke<Totals>("totals", { date }),
  listCategories: (includeArchived = false) => invoke<Category[]>("list_categories", { includeArchived }),
  createCategory: (input: { name: string; kind: CategoryKind; parentId: string | null }) =>
    invoke<string>("create_category", { input }),
  updateCategory: (id: string, name: string, parentId: string | null) =>
    invoke<void>("update_category", { id, name, parentId }),
  archiveCategory: (id: string, archived: boolean) => invoke<void>("archive_category", { id, archived }),
  deleteCategory: (id: string, moveTo: string | null) => invoke<void>("delete_category", { id, moveTo }),
  listTransactions: (filter: TxnFilter) => invoke<Page>("list_transactions", { filter }),
  createTransaction: (input: TxnInput, eventId: string | null = null) => invoke<string>("create_transaction", { input, eventId }),
  moveTransaction: (id: string, date: string) => invoke<void>("move_transaction", { id, date }),
  splitExpense: (input: SplitInput) => invoke<{ expenseId: string | null; debtIds: string[] }>("split_expense", { input }),
  updateTransaction: (id: string, input: TxnInput) => invoke<void>("update_transaction", { id, input }),
  deleteTransaction: (id: string) => invoke<void>("delete_transaction", { id }),
  payeeHints: (kind: TxnType, query: string) => invoke<PayeeHint[]>("payee_hints", { kind, query }),
  transactionDefaults: (kind: TxnType) => invoke<Defaults>("transaction_defaults", { kind }),
  periodSummary: (from: string, to: string) => invoke<PeriodSummary>("period_summary", { from, to }),
  reportPeriod: (kind: ReportPeriodKind, month: string) => invoke<Period>("report_period", { kind, month }),
  reportByCategory: (kind: CategoryKind, from: string, to: string) => invoke<CategoryReport>("report_by_category", { kind, from, to }),
  comparePeriods: (kind: CategoryKind, by: CompareBy, periods: ComparePeriods) => invoke<Comparison>("compare_periods", { kind, by, periods }),
  reportByMonth: (fromMonth: string, toMonth: string) => invoke<MonthsReport>("report_by_month", { fromMonth, toMonth }),
  reportBalances: (date: string) => invoke<BalancesReport>("report_balances", { date }),
  calcLoan: (input: LoanInput) => invoke<Schedule>("calc_loan", { input }),
  compareLoans: (input: LoanInput) => invoke<{ annuity: Schedule; differentiated: Schedule }>("compare_loans", { input }),
  listDebts: () => invoke<DebtCard[]>("list_debts"),
  getDebt: (id: string) => invoke<DebtDetail>("get_debt", { id }),
  debtSummary: () => invoke<DebtSummary>("debt_summary"),
  createDebt: (input: DebtInput) => invoke<string>("create_debt", { input }),
  updateDebtInfo: (id: string, counterparty: string, note: string | null) => invoke<void>("update_debt_info", { id, counterparty, note }),
  deleteDebt: (id: string) => invoke<void>("delete_debt", { id }),
  payDebt: (id: string, input: PaymentInput) => invoke<string>("pay_debt", { id, input }),
  deleteDebtPayment: (paymentId: string) => invoke<void>("delete_debt_payment", { paymentId }),
  planLoan: (input: CalcInput) => invoke<CalcResult>("plan_loan", { input }),
  updateDebtTerms: (id: string, input: TermsInput) => invoke<void>("update_debt_terms", { id, input }),
  addDebtRateChange: (id: string, input: RateChangeInput) => invoke<string>("add_debt_rate_change", { id, input }),
  deleteDebtRateChange: (rateChangeId: string) => invoke<void>("delete_debt_rate_change", { rateChangeId }),
  addDebtHoliday: (id: string, input: HolidayInput) => invoke<string>("add_debt_holiday", { id, input }),
  deleteDebtHoliday: (holidayId: string) => invoke<void>("delete_debt_holiday", { holidayId }),
  setDebtRowAmount: (id: string, input: RowAmountInput) => invoke<string>("set_debt_row_amount", { id, input }),
  deleteDebtRowAmount: (rowAmountId: string) => invoke<void>("delete_debt_row_amount", { rowAmountId }),
  setDebtPlannedEarly: (id: string, list: PlannedEarlyInput[]) => invoke<void>("set_debt_planned_early", { id, list }),
  quoteDebtPayment: (id: string, input: QuoteInput) => invoke<Quote>("quote_debt_payment", { id, input }),
  debtForecast: (id: string) => invoke<Forecast>("debt_forecast", { id }),
  debtVersions: (id: string) => invoke<DebtVersions>("debt_versions", { id }),
  debtScheduleDoc: (id: string, withForecast: boolean) => invoke<ScheduleDoc>("debt_schedule_doc", { id, withForecast }),
  calcScheduleDoc: (input: CalcInput, currencyCode: string | null) => invoke<ScheduleDoc>("calc_schedule_doc", { input, currencyCode }),
  exportScheduleXlsx: (path: string, doc: ScheduleDoc) => invoke<void>("export_schedule_xlsx", { path, doc }),
  exportSchedulePdf: (path: string, doc: ScheduleDoc) => invoke<void>("export_schedule_pdf", { path, doc }),
  previewDebtTerms: (id: string, input: TermsInput) => invoke<TermsPreview>("preview_debt_terms", { id, input }),
  previewDebtChange: (id: string, input: LoanChangeInput) => invoke<LoanCompare>("preview_debt_change", { id, input }),
  getBudget: (month: string) => invoke<Budget>("get_budget", { month }),
  monthOf: (date: string) => invoke<Period>("month_of", { date }),
  createBudget: (month: string, copyPrevious: boolean) => invoke<string>("create_budget", { month, copyPrevious }),
  setBudgetLimit: (budgetId: string, categoryId: string, limit: number | null) =>
    invoke<void>("set_budget_limit", { budgetId, categoryId, limit }),
  setBudgetNote: (budgetId: string, note: string | null) => invoke<void>("set_budget_note", { budgetId, note }),
  deleteBudget: (budgetId: string) => invoke<void>("delete_budget", { budgetId }),
  fillBudget: (budgetId: string, mode: FillMode, categoryId: string | null = null) =>
    invoke<number>("fill_budget", { budgetId, mode, categoryId }),
  cushion: () => invoke<Cushion>("cushion"),
  forecast: (scenarioId: string | null) => invoke<Forecast>("forecast", { scenarioId }),
  listScenarios: () => invoke<Scenario[]>("list_scenarios"),
  forecastAccounts: () => invoke<ForecastAccount[]>("forecast_accounts"),
  setForecastExcluded: (ids: string[]) => invoke<void>("set_forecast_excluded", { ids }),
  createScenario: (input: { name: string; changes: ChangeInput[] }) => invoke<string>("create_scenario", { input }),
  updateScenario: (id: string, input: { name: string; changes: ChangeInput[] }) => invoke<void>("update_scenario", { id, input }),
  deleteScenario: (id: string) => invoke<void>("delete_scenario", { id }),
  moneyFlow: (kind: "month" | "year", month: string) => invoke<MoneyFlow>("money_flow", { kind, month }),
  investOverview: () => invoke<InvestOverview>("invest_overview"),
  investMonth: (month: string) => invoke<InvestMonth>("invest_month", { month }),
  setInvestValue: (accountId: string, date: string, value: number) => invoke<void>("set_invest_value", { accountId, date, value }),
  deleteInvestValue: (accountId: string, date: string) => invoke<void>("delete_invest_value", { accountId, date }),
  /** С `month` — план только на этот месяц, без — общий на каждый месяц. */
  setInvestPlan: (mode: InvestPlanMode, value: number, month: string | null = null) => invoke<void>("set_invest_plan", { mode, value, month }),
  clearInvestMonthPlan: (month: string) => invoke<void>("clear_invest_month_plan", { month }),
  reportFx: (from: string, to: string) => invoke<FxReport>("report_fx", { from, to }),
  listViews: (kind: ViewKind | null = null) => invoke<SavedView[]>("list_views", { kind }),
  createView: (name: string, kind: ViewKind, params: unknown) =>
    invoke<string>("create_view", { input: { name, kind, params: JSON.stringify(params) } }),
  deleteView: (id: string) => invoke<void>("delete_view", { id }),
  quickParse: (text: string) => invoke<QuickDraft>("quick_parse", { text }),
  rememberRule: (merchant: string, categoryId: string, payee: string | null) =>
    invoke<string>("remember_rule", { merchant, categoryId, payee }),
  listRules: () => invoke<Rule[]>("list_rules"),
  createRule: (input: RuleInput) => invoke<string>("create_rule", { input }),
  deleteRule: (id: string) => invoke<void>("delete_rule", { id }),
  openQuick: () => invoke<void>("open_quick"),
  hideQuick: (saved: boolean) => invoke<void>("hide_quick", { saved }),
  setQuickHotkey: (hotkey: string) => invoke<void>("set_quick_hotkey", { hotkey }),
  listAssets: () => invoke<Asset[]>("list_assets"),
  createAsset: (input: AssetInput) => invoke<string>("create_asset", { input }),
  updateAsset: (id: string, input: AssetInput) => invoke<void>("update_asset", { id, input }),
  deleteAsset: (id: string) => invoke<void>("delete_asset", { id }),
  listEvents: () => invoke<BudgetEvent[]>("list_events"),
  createEvent: (input: EventInput) => invoke<string>("create_event", { input }),
  updateEvent: (id: string, input: EventInput) => invoke<void>("update_event", { id, input }),
  deleteEvent: (id: string) => invoke<void>("delete_event", { id }),
  assignEvent: (eventId: string | null, txnIds: string[]) => invoke<number>("assign_event", { eventId, txnIds }),
  eventCandidates: (id: string) => invoke<string[]>("event_candidates", { id }),
  eventsOn: (date: string) => invoke<[string, string][]>("events_on", { date }),
  lastWeek: () => invoke<WeekSummary>("last_week"),
  noSpendStreak: () => invoke<number>("no_spend_streak"),
  listFiles: () => invoke<BudgetFileRow[]>("list_files"),
  createFile: (name: string) => invoke<string>("create_file", { name }),
  openFile: (path: string) => invoke<void>("open_file", { path }),
  switchFile: (path: string) => invoke<void>("switch_file", { path }),
  renameFile: (path: string, name: string) => invoke<void>("rename_file", { path, name }),
  forgetFile: (path: string) => invoke<void>("forget_file", { path }),
  calendarMonth: (month: string) => invoke<CalendarMonth>("calendar_month", { month }),
  calendarRange: (from: string, to: string) => invoke<CalendarMonth>("calendar_range", { from, to }),
  remindersOverview: () => invoke<RemindersOverview>("reminders_overview"),
  missedReminders: () => invoke<Occurrence[]>("missed_reminders"),
  createReminder: (input: ReminderInput) => invoke<string>("create_reminder", { input }),
  updateReminder: (id: string, input: ReminderInput) => invoke<void>("update_reminder", { id, input }),
  setReminderActive: (id: string, active: boolean) => invoke<void>("set_reminder_active", { id, active }),
  deleteReminder: (id: string) => invoke<void>("delete_reminder", { id }),
  completeReminder: (key: ReminderKey, transactionId: string | null = null) =>
    invoke<void>("complete_reminder", { key, transactionId }),
  snoozeReminder: (key: ReminderKey, until: string) => invoke<void>("snooze_reminder", { key, until }),
  dismissReminder: (key: ReminderKey) => invoke<void>("dismiss_reminder", { key }),
  reopenReminder: (key: ReminderKey) => invoke<void>("reopen_reminder", { key }),
  listNotes: (filter: NoteFilter) => invoke<Note[]>("list_notes", { filter }),
  createNote: (input: NoteInput) => invoke<string>("create_note", { input }),
  updateNote: (id: string, input: NoteInput) => invoke<void>("update_note", { id, input }),
  deleteNote: (id: string) => invoke<void>("delete_note", { id }),
  exportSummary: (from: string, to: string, path: string) => invoke<void>("export_summary", { from, to, path }),
  exportTransactions: (filter: TxnFilter, path: string) => invoke<void>("export_transactions", { filter, path }),
  exportReport: (report: "categories" | "months", from: string, to: string, path: string) =>
    invoke<void>("export_report", { report, from, to, path }),
  exportComparison: (kind: CategoryKind, by: CompareBy, periods: ComparePeriods, path: string) =>
    invoke<void>("export_comparison", { kind, by, periods, path }),
  importPreview: (path: string, accountId?: string | null) => invoke<ImportPreview>("import_preview", { path, accountId: accountId ?? null }),
  importCsv: (path: string, skipErrors: boolean, accountId?: string | null) => invoke<number>("import_csv", { path, skipErrors, accountId: accountId ?? null }),
  saveBytes: (path: string, data: Uint8Array) => invoke<void>("save_bytes", { path, data: Array.from(data) }),
  writeImportTemplate: (path: string) => invoke<void>("write_import_template", { path }),
  backupStatus: () => invoke<BackupStatus>("backup_status"),
  backupNow: (path: string) => invoke<void>("backup_now", { path }),
  inspectBackup: (path: string) => invoke<BackupInfo>("inspect_backup", { path }),
  restoreBackup: (path: string) => invoke<string>("restore_backup", { path }),
  vaultStatus: () => invoke<VaultStatus>("vault_status"),
  vaultSync: () => invoke<VaultStatus>("vault_sync"),
  /** Пробное восстановление: свежая копия папки сохранности (без пути) или выбранный файл. */
  verifyBackup: (path?: string) => invoke<VaultStatus>("verify_backup", { path: path ?? null }),
  vaultPlaces: () => invoke<VaultPlace[]>("vault_places"),
  setVaultDir: (path: string | null) => invoke<VaultStatus>("set_vault_dir", { path }),
  vaultScan: (dirs?: string[]) => invoke<VaultFound[]>("vault_scan", { dirs: dirs ?? null }),
  vaultInspect: (path: string) => invoke<VaultFound>("vault_inspect", { path }),
  vaultTransfer: (found: VaultFound) => invoke<string>("vault_transfer", { found }),
  openFolder: (path: string) => invoke<void>("open_folder", { path }),
  checkUpdate: () => invoke<UpdateInfo>("check_update"),
  installUpdate: () => invoke<void>("install_update"),
  changelog: () => invoke<string>("changelog"),
  listTemplates: () => invoke<Template[]>("list_templates"),
  createTemplate: (input: TemplateInput) => invoke<string>("create_template", { input }),
  deleteTemplate: (id: string) => invoke<void>("delete_template", { id }),
  applyTemplate: (id: string, date: string) => invoke<string>("apply_template", { id, date }),
  templateUsed: (id: string) => invoke<void>("template_used", { id }),
  undoState: () => invoke<UndoState>("undo_state"),
  undo: () => invoke<string | null>("undo"),
  listGoals: () => invoke<Goal[]>("list_goals"),
  createGoal: (input: GoalInput) => invoke<string>("create_goal", { input }),
  updateGoal: (id: string, input: GoalInput) => invoke<void>("update_goal", { id, input }),
  deleteGoal: (id: string) => invoke<void>("delete_goal", { id }),
  goalDeposit: (id: string, date: string, amount: number) => invoke<void>("goal_deposit", { id, date, amount }),
  listSubscriptions: () => invoke<SubscriptionsReport>("list_subscriptions"),
  hideSubscription: (key: string, hide: boolean) => invoke<void>("hide_subscription", { key, hide }),
  yearReview: (year: number) => invoke<YearReview>("year_review", { year }),
  globalSearch: (query: string) => invoke<SearchHit[]>("global_search", { query }),
  autoImportDir: () => invoke<string>("auto_import_dir"),
  autoImportNow: () => invoke<ScanResult>("auto_import_now"),
  createTransactionFull: (input: TxnInput, extra: TxnExtra, eventId: string | null = null) =>
    invoke<string>("create_transaction_full", { input, eventId, extra }),
  updateTransactionFull: (id: string, input: TxnInput, extra: TxnExtra) =>
    invoke<void>("update_transaction_full", { id, input, extra }),
  setTransactionSpread: (id: string, months: number | null) => invoke<void>("set_transaction_spread", { id, months }),
  sumSelected: (ids: string[]) => invoke<Sums>("sum_selected", { ids }),
  sumFiltered: (filter: TxnFilter) => invoke<Sums>("sum_filtered", { filter }),
  bulkSetCategory: (ids: string[], categoryId: string) => invoke<BulkResult>("bulk_set_category", { ids, categoryId }),
  bulkSetPayee: (ids: string[], payee: string | null) => invoke<BulkResult>("bulk_set_payee", { ids, payee }),
  bulkSetAccount: (ids: string[], accountId: string) => invoke<BulkResult>("bulk_set_account", { ids, accountId }),
  bulkTag: (ids: string[], tag: string, add: boolean) => invoke<BulkResult>("bulk_tag", { ids, tag, add }),
  bulkDelete: (ids: string[]) => invoke<BulkResult>("bulk_delete", { ids }),
  createReceipt: (input: ReceiptInput) => invoke<string>("create_receipt", { input }),
  updateReceipt: (splitId: string, input: ReceiptInput) => invoke<void>("update_receipt", { splitId, input }),
  deleteReceipt: (splitId: string) => invoke<void>("delete_receipt", { splitId }),
  getReceipt: (splitId: string) => invoke<Receipt>("get_receipt", { splitId }),
  listTags: () => invoke<Tag[]>("list_tags"),
  setTransactionTags: (id: string, tags: string[]) => invoke<void>("set_transaction_tags", { id, tags }),
  renameTag: (id: string, name: string) => invoke<void>("rename_tag", { id, name }),
  mergeTags: (from: string, into: string) => invoke<void>("merge_tags", { from, into }),
  deleteTag: (id: string) => invoke<void>("delete_tag", { id }),
  reportByTag: (tagId: string, from: string, to: string) => invoke<TagReport>("report_by_tag", { tagId, from, to }),
  spendingVsUsual: (month: string) => invoke<UsualReport>("spending_vs_usual", { month }),
  listChecks: () => invoke<Check[]>("list_checks"),
  dismissCheck: (key: string) => invoke<void>("dismiss_check", { key }),
  deleteDuplicate: (secondId: string) => invoke<void>("delete_duplicate", { secondId }),
  /** months: 12, 36 или null — всё время. */
  netWorthHistory: (months: number | null) => invoke<NetWorthHistory>("net_worth_history", { months }),
  redo: () => invoke<string | null>("redo"),
};

export const ACCOUNT_TYPES: Record<AccountType, string> = {
  cash: "Наличные",
  debit: "Карта",
  credit: "Кредитная карта",
  savings: "Вклад / сбережения",
  investment: "Брокерский счёт / ИИС",
};

export const INVEST_KINDS: Record<InvestKind, string> = {
  broker: "Брокерский счёт",
  iis: "ИИС",
  pds: "ПДС",
};

export const TXN_TYPES: Record<TxnType, string> = {
  expense: "Расход",
  income: "Доход",
  transfer: "Перевод",
  adjustment: "Корректировка",
};
