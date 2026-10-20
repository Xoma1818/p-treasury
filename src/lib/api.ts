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
  source: string;
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
  missingRates: string[];
}

export interface Setup {
  baseCurrency: string;
  accounts: AccountInput[];
  defaultCategories: boolean;
}

export type Settings = Record<string, string>;

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
  finishOnboarding: (setup: Setup) => invoke<void>("finish_onboarding", { setup }),
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
  reportByMonth: (fromMonth: string, toMonth: string) => invoke<MonthsReport>("report_by_month", { fromMonth, toMonth }),
  reportBalances: (date: string) => invoke<BalancesReport>("report_balances", { date }),
  getBudget: (month: string) => invoke<Budget>("get_budget", { month }),
  monthOf: (date: string) => invoke<Period>("month_of", { date }),
  createBudget: (month: string, copyPrevious: boolean) => invoke<string>("create_budget", { month, copyPrevious }),
  setBudgetLimit: (budgetId: string, categoryId: string, limit: number | null) =>
    invoke<void>("set_budget_limit", { budgetId, categoryId, limit }),
  setBudgetNote: (budgetId: string, note: string | null) => invoke<void>("set_budget_note", { budgetId, note }),
  deleteBudget: (budgetId: string) => invoke<void>("delete_budget", { budgetId }),
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
