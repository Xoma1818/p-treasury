// Г5: своя панель кнопок в шапке «Операций». Человек сам решает, что видно всегда:
// «Загрузить выписку», «Выгрузить», любимые шаблоны. Остальное лежит в «⋯».
// Хранится в окне, копия — в базе (uiPrefs), как меню и форма.
import { useEffect, useState } from "react";
import { pushPref } from "./uiPrefs";

export const HEAD_KEY = "kazna.txnHead";
const HEAD_EVENT = "kazna:txnHead";

/** Встроенные действия шапки; шаблон — `tpl:<id>`. «+ Операция» видна всегда. */
export const HEAD_BUILTIN = ["import", "export"] as const;
export type HeadBuiltin = (typeof HEAD_BUILTIN)[number];

/** Что видно в шапке, в порядке показа. */
export type HeadBar = { shown: string[] };

export const DEFAULT_HEAD: HeadBar = { shown: ["import", "export"] };

const isId = (x: unknown): x is string => typeof x === "string" && (HEAD_BUILTIN.includes(x as HeadBuiltin) || /^tpl:.+/.test(x));

export function parseHead(raw: string | null | undefined): HeadBar {
  try {
    const v = JSON.parse(raw || "null");
    if (!v || typeof v !== "object" || !Array.isArray(v.shown)) return DEFAULT_HEAD;
    return { shown: [...new Set((v.shown as unknown[]).filter(isId))] };
  } catch {
    return DEFAULT_HEAD;
  }
}

export const isDefaultHead = (h: HeadBar) => h.shown.length === DEFAULT_HEAD.shown.length && h.shown.every((id, i) => id === DEFAULT_HEAD.shown[i]);

/** Показать или убрать в «⋯»; новое встаёт в конец. */
export const toggleHead = (h: HeadBar, id: string): HeadBar => ({ shown: h.shown.includes(id) ? h.shown.filter((x) => x !== id) : [...h.shown, id] });

/** Шаблоны в шапке, которых больше нет, не показываются. */
export const shownTemplates = (h: HeadBar, ids: string[]) => h.shown.filter((x) => x.startsWith("tpl:") && ids.includes(x.slice(4))).map((x) => x.slice(4));

function read(): string | null {
  try {
    return localStorage.getItem(HEAD_KEY);
  } catch {
    return null;
  }
}

export const savedHead = () => parseHead(read());

export function saveHead(h: HeadBar) {
  const v = JSON.stringify(h);
  pushPref(HEAD_KEY, v);
  try {
    localStorage.setItem(HEAD_KEY, v);
  } catch {
    /* без запоминания */
  }
  window.dispatchEvent(new Event(HEAD_EVENT));
}

export const notifyHead = () => window.dispatchEvent(new Event(HEAD_EVENT));

export function useHeadBar(): HeadBar {
  const [h, setH] = useState(savedHead);
  useEffect(() => {
    const on = () => setH(savedHead());
    window.addEventListener(HEAD_EVENT, on);
    return () => window.removeEventListener(HEAD_EVENT, on);
  }, []);
  return h;
}
