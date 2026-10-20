import { create } from "zustand";
import type { Txn, TxnType } from "./api";
import type { SectionId } from "./sections";

export type TxnFormState = { mode: "new"; type: TxnType; date?: string } | { mode: "edit"; txn: Txn } | null;

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
}

export const useUi = create<UiState>((set) => ({
  section: "home",
  visit: 0,
  go: (section) => set((s) => ({ section, visit: s.visit + 1 })),
  txnFilter: null,
  showTransactions: (txnFilter) => set({ txnFilter, section: "transactions" }),
  txnForm: null,
  openTxnForm: (txnForm) => set({ txnForm }),
}));
