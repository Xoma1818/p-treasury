/** Р4: как открывается существующая операция — панелью справа (по умолчанию) или окном.
 *  Настройка интерфейса этого компьютера, хранится в localStorage. */
import { pushPref } from "./uiPrefs";

export type TxnOpen = "panel" | "dialog";
const KEY = "kazna.txnOpen";

export function savedTxnOpen(): TxnOpen {
  try {
    return localStorage.getItem(KEY) === "dialog" ? "dialog" : "panel";
  } catch {
    return "panel";
  }
}

export function saveTxnOpen(v: TxnOpen) {
  pushPref(KEY, v);
  try {
    localStorage.setItem(KEY, v);
  } catch {
    /* без запоминания */
  }
}
