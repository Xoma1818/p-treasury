import { create } from "zustand";
import type { Txn, TxnType } from "./api";
import type { SectionId } from "./sections";

export type TxnFormState = { mode: "new"; type: TxnType; date?: string } | { mode: "edit"; txn: Txn } | null;

interface UiState {
  section: SectionId;
  go: (section: SectionId) => void;
  /** Переход в «Операции» с фильтром (из Главной, Счетов, Категорий). */
  txnFilter: { accountId?: string; categoryId?: string } | null;
  showTransactions: (f: { accountId?: string; categoryId?: string }) => void;
  txnForm: TxnFormState;
  openTxnForm: (s: TxnFormState) => void;
}

export const useUi = create<UiState>((set) => ({
  section: "home",
  go: (section) => set({ section }),
  txnFilter: null,
  showTransactions: (txnFilter) => set({ txnFilter, section: "transactions" }),
  txnForm: null,
  openTxnForm: (txnForm) => set({ txnForm }),
}));
