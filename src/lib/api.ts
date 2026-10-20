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

export type AccountType = "cash" | "debit" | "credit" | "savings";

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
}

export interface AccountInput {
  name: string;
  type: AccountType;
  currencyCode: string;
  openingBalance: number;
  openingDate: string;
  creditLimit: number | null;
  includeInTotal: boolean;
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
}

export interface TxnFilter {
  dateFrom?: string;
  dateTo?: string;
  accountId?: string;
  categoryId?: string;
  types?: TxnType[];
  search?: string;
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
}

export interface DebtDetail {
  card: DebtCard;
  schedule: ScheduleRow[];
  payments: DebtPayment[];
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
}

export interface ImportPreview {
  rows: ImportRow[];
  valid: number;
  errors: number;
}

export interface BackupStatus {
  lastBackupAt: string | null;
  autobackupDir: string;
  autobackupKeep: string;
  reminderDue: boolean;
  defaultName: string;
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
  createTransaction: (input: TxnInput) => invoke<string>("create_transaction", { input }),
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
  reportFx: (from: string, to: string) => invoke<FxReport>("report_fx", { from, to }),
  listViews: (kind: ViewKind | null = null) => invoke<SavedView[]>("list_views", { kind }),
  createView: (name: string, kind: ViewKind, params: unknown) =>
    invoke<string>("create_view", { input: { name, kind, params: JSON.stringify(params) } }),
  deleteView: (id: string) => invoke<void>("delete_view", { id }),
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
  importPreview: (path: string) => invoke<ImportPreview>("import_preview", { path }),
  importCsv: (path: string, skipErrors: boolean) => invoke<number>("import_csv", { path, skipErrors }),
  writeImportTemplate: (path: string) => invoke<void>("write_import_template", { path }),
  backupStatus: () => invoke<BackupStatus>("backup_status"),
  backupNow: (path: string) => invoke<void>("backup_now", { path }),
  inspectBackup: (path: string) => invoke<BackupInfo>("inspect_backup", { path }),
  restoreBackup: (path: string) => invoke<string>("restore_backup", { path }),
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
  redo: () => invoke<string | null>("redo"),
};

export const ACCOUNT_TYPES: Record<AccountType, string> = {
  cash: "Наличные",
  debit: "Карта",
  credit: "Кредитная карта",
  savings: "Вклад / сбережения",
};

export const TXN_TYPES: Record<TxnType, string> = {
  expense: "Расход",
  income: "Доход",
  transfer: "Перевод",
  adjustment: "Корректировка",
};
