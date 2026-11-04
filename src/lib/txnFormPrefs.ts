// Г9: настройка формы операции. Какие поля видны всегда (а не под «Ещё»), какой счёт
// и какая дата подставляются в новую операцию. Хранится в окне, копия — в базе (uiPrefs).
import { useEffect, useState } from "react";
import { pushPref } from "./uiPrefs";

export const FORM_KEY = "kazna.txnForm";
const LAST_DATE_KEY = "kazna.lastTxnDate";
const FORM_EVENT = "kazna:txnForm";

export type TxnFormPrefs = {
  /** Комментарий и теги видны всегда, без «Ещё». */
  pinNote: boolean;
  pinTags: boolean;
  /** "last" — последний использованный счёт для этого типа, иначе id счёта. */
  account: string;
  /** Дата новой операции: сегодня или как в прошлой введённой. */
  date: "today" | "last";
};

export const DEFAULT_FORM: TxnFormPrefs = { pinNote: false, pinTags: false, account: "last", date: "today" };

export function parseForm(raw: string | null | undefined): TxnFormPrefs {
  try {
    const v = JSON.parse(raw || "{}");
    if (!v || typeof v !== "object") return DEFAULT_FORM;
    return {
      pinNote: v.pinNote === true,
      pinTags: v.pinTags === true,
      account: typeof v.account === "string" && v.account ? v.account : "last",
      date: v.date === "last" ? "last" : "today",
    };
  } catch {
    return DEFAULT_FORM;
  }
}

export function isDefaultForm(p: TxnFormPrefs): boolean {
  return !p.pinNote && !p.pinTags && p.account === "last" && p.date === "today";
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* без запоминания */
  }
}

export const savedForm = () => parseForm(read(FORM_KEY));

export function saveForm(p: TxnFormPrefs) {
  const v = JSON.stringify(p);
  pushPref(FORM_KEY, v);
  write(FORM_KEY, v);
  window.dispatchEvent(new Event(FORM_EVENT));
}

export const notifyForm = () => window.dispatchEvent(new Event(FORM_EVENT));

/** Дата последней введённой операции — для «как в прошлой». Только на этом компьютере. */
export const rememberTxnDate = (date: string) => write(LAST_DATE_KEY, date);

/** Дата новой операции по настройке. Явно заданная дата (из календаря, напоминания) главнее. */
export function newTxnDate(p: TxnFormPrefs, today: string): string {
  if (p.date !== "last") return today;
  const last = read(LAST_DATE_KEY);
  return last && /^\d{4}-\d{2}-\d{2}$/.test(last) ? last : today;
}

/** Счёт новой операции: выбранный в настройке, если он есть и открыт; иначе — последний использованный. */
export function preferredAccount(p: TxnFormPrefs, open: { id: string }[]): string | null {
  return p.account !== "last" && open.some((a) => a.id === p.account) ? p.account : null;
}

export function useTxnFormPrefs(): TxnFormPrefs {
  const [p, setP] = useState(savedForm);
  useEffect(() => {
    const on = () => setP(savedForm());
    window.addEventListener(FORM_EVENT, on);
    return () => window.removeEventListener(FORM_EVENT, on);
  }, []);
  return p;
}
