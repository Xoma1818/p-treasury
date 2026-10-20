import { create } from "zustand";
import type { Txn, TxnType } from "./api";
import type { SectionId } from "./sections";

/** Что подставить в новую операцию (например, из напоминания). */
export interface TxnPrefill {
  amount?: number | null;
  accountId?: string | null;
  categoryId?: string | null;
  payee?: string | null;
  note?: string | null;
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
}));
