import { create } from "zustand";
import type { SavedView, Txn, TxnType } from "./api";
import type { SectionId } from "./sections";

/** Что подставить в новую операцию (например, из напоминания). */
export interface TxnPrefill {
  amount?: number | null;
  accountId?: string | null;
  toAccountId?: string | null;
  categoryId?: string | null;
  payee?: string | null;
  note?: string | null;
  tags?: string[];
}

export type TxnFormState =
  | { mode: "new"; type: TxnType; date?: string; prefill?: TxnPrefill; onSaved?: (id: string) => Promise<unknown> }
  | { mode: "edit"; txn: Txn }
  | null;

/** Фильтр перехода в «Операции»; без дат — за всё время. */
export interface TxnJump {
  accountId?: string;
  categoryId?: string;
  dateFrom?: string;
  dateTo?: string;
  eventId?: string;
  /** Операции с тегом (Ctrl+K, отчёт «По тегу»). */
  tagId?: string;
  /** Поиск по получателю, комментарию или сумме. */
  search?: string;
  /** Операции одного импорта. */
  importId?: string;
  /** Только эти типы (доходы или расходы из «Как посчитано»). */
  types?: TxnType[];
}

interface UiState {
  section: SectionId;
  /** Растёт при каждом переходе из меню: повторное нажатие пункта открывает раздел с начала. */
  visit: number;
  go: (section: SectionId) => void;
  /** Переход в «Операции» с фильтром (из Главной, Счетов, Категорий). */
  txnFilter: TxnJump | null;
  showTransactions: (f: TxnJump) => void;
  txnForm: TxnFormState;
  openTxnForm: (s: TxnFormState) => void;
  /** Открыть карточку долга (и сразу отметку платежа) из напоминания или календаря. */
  debtJump: { id: string; pay: boolean } | null;
  openDebt: (id: string, pay?: boolean) => void;
  /** Сохранённый вид, открытый из бокового меню: раздел применяет его и очищает. */
  viewJump: SavedView | null;
  openView: (v: SavedView) => void;
  /** Вкладка Отчётов, открытая из другого раздела (например, «Подписки» с Главной). */
  reportTab: string | null;
  openReport: (tab: string) => void;
  /** Поиск по всему (Ctrl+K). */
  palette: boolean;
  setPalette: (open: boolean) => void;
  /** Справка по горячим клавишам (F1). */
  help: boolean;
  setHelp: (open: boolean) => void;
}

export const useUi = create<UiState>((set) => ({
  section: "home",
  visit: 0,
  go: (section) => set((s) => ({ section, visit: s.visit + 1 })),
  txnFilter: null,
  showTransactions: (txnFilter) => set({ txnFilter, section: "transactions" }),
  txnForm: null,
  openTxnForm: (txnForm) => set({ txnForm }),
  debtJump: null,
  openDebt: (id, pay = false) => set((s) => ({ debtJump: { id, pay }, section: "debts", visit: s.visit + 1 })),
  viewJump: null,
  openView: (v) => set((s) => ({ viewJump: v, section: v.kind === "report" ? "reports" : "transactions", visit: s.visit + 1 })),
  reportTab: null,
  openReport: (reportTab) => set((s) => ({ reportTab, section: "reports", visit: s.visit + 1 })),
  palette: false,
  setPalette: (palette) => set({ palette }),
  help: false,
  setHelp: (help) => set({ help }),
}));
