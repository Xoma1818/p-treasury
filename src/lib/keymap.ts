// Г10: свои горячие клавиши. Действия окна (новая операция, поиск, справка…) можно
// переназначить в Настройках → «Клавиши». Стандартные сочетания (Ctrl+Z, Ctrl+A,
// Ctrl+1…9, Esc) закреплены. Хранится в окне, копия — в базе (uiPrefs).
import { useEffect, useState } from "react";
import { pushPref } from "./uiPrefs";

export const KEYS_KEY = "kazna.keys";
const KEYS_EVENT = "kazna:keys";

export const KEY_ACTIONS = [
  { id: "newExpense", label: "Новая операция (расход)", def: "Ctrl+N" },
  { id: "newIncome", label: "Новый доход", def: "" },
  { id: "newTransfer", label: "Новый перевод", def: "Ctrl+T" },
  { id: "palette", label: "Поиск по всему: разделы, счета, заметки, операции", def: "Ctrl+K" },
  { id: "search", label: "Поиск по операциям (в Заметках — по заметкам)", def: "Ctrl+F" },
  { id: "hideAmounts", label: "Скрыть или показать суммы", def: "Ctrl+H" },
  { id: "help", label: "Справка по клавишам", def: "F1" },
] as const;

export type KeyAction = (typeof KEY_ACTIONS)[number]["id"];
/** Свои назначения поверх стандартных; "" — выключено. */
export type KeyMap = Partial<Record<KeyAction, string>>;

/** Закреплённые сочетания: их нельзя отдать другому действию. */
export const FIXED_KEYS: [combo: string, action: string][] = [
  ["Ctrl+Enter", "Сохранить форму"],
  ["Ctrl+Z", "Отменить последнее действие"],
  ["Ctrl+Y", "Повторить отменённое"],
  ["Ctrl+A", "Выделить всё"],
  ["Ctrl+C", "Копировать"],
  ["Ctrl+V", "Вставить"],
  ["Ctrl+X", "Вырезать"],
  ["Escape", "Закрыть окно"],
  ...Array.from({ length: 9 }, (_, i) => [`Ctrl+${i + 1}`, "Разделы меню по порядку"] as [string, string]),
];

const isAction = (x: string): x is KeyAction => KEY_ACTIONS.some((a) => a.id === x);

/** Сочетание из нажатия: «Ctrl+Shift+N», «F2». Только модификатор — null. */
export function comboOf(e: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">): string | null {
  let key: string;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (/^F\d{1,2}$/.test(e.key)) key = e.key;
  else if (["Escape", "Enter", "Space"].includes(e.code)) key = e.code;
  else if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) return null;
  else if (e.key.length === 1) key = e.key.toUpperCase();
  else key = e.key;
  const mods = [(e.ctrlKey || e.metaKey) && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift"].filter(Boolean);
  return [...mods, key].join("+");
}

/** Годится ли сочетание для действия окна: F-клавиша или с Ctrl/Alt. */
export const usable = (combo: string) => /^F\d{1,2}$/.test(combo) || /^(Ctrl|Alt)\+/.test(combo);

export function parseKeys(raw: string | null | undefined): KeyMap {
  try {
    const v = JSON.parse(raw || "{}");
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v).filter(([k, x]) => isAction(k) && typeof x === "string" && (x === "" || usable(x)))) as KeyMap;
  } catch {
    return {};
  }
}

/** Итоговое сочетание действия. */
export const comboFor = (m: KeyMap, id: KeyAction) => m[id] ?? KEY_ACTIONS.find((a) => a.id === id)!.def;

/** Действие по сочетанию. */
export function actionFor(m: KeyMap, combo: string): KeyAction | null {
  return KEY_ACTIONS.find((a) => comboFor(m, a.id) === combo)?.id ?? null;
}

/** Кто уже занял сочетание (кроме самого действия): название или null. */
export function takenBy(m: KeyMap, id: KeyAction, combo: string): string | null {
  const fixed = FIXED_KEYS.find(([c]) => c === combo);
  if (fixed) return fixed[1];
  const other = KEY_ACTIONS.find((a) => a.id !== id && comboFor(m, a.id) === combo);
  return other ? other.label : null;
}

/** Назначить; совпадающее с умолчанием хранится как умолчание. */
export function assign(m: KeyMap, id: KeyAction, combo: string): KeyMap {
  const next = { ...m };
  if (combo === KEY_ACTIONS.find((a) => a.id === id)!.def) delete next[id];
  else next[id] = combo;
  return next;
}

export const isDefaultKeys = (m: KeyMap) => Object.keys(m).length === 0;

function read(): string | null {
  try {
    return localStorage.getItem(KEYS_KEY);
  } catch {
    return null;
  }
}

export const savedKeys = () => parseKeys(read());

export function saveKeys(m: KeyMap) {
  const v = JSON.stringify(m);
  pushPref(KEYS_KEY, v);
  try {
    localStorage.setItem(KEYS_KEY, v);
  } catch {
    /* продержится до перезапуска */
  }
  window.dispatchEvent(new Event(KEYS_EVENT));
}

export const notifyKeys = () => window.dispatchEvent(new Event(KEYS_EVENT));

export function useKeyMap(): KeyMap {
  const [m, setM] = useState(savedKeys);
  useEffect(() => {
    const on = () => setM(savedKeys());
    window.addEventListener(KEYS_EVENT, on);
    return () => window.removeEventListener(KEYS_EVENT, on);
  }, []);
  return m;
}
