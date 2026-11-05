// Г12: тонкие настройки вида — экран при запуске, начало недели, копейки и «₽» или «RUB».
// Хранятся в окне, копия — в базе (uiPrefs). Пороги «Необычно» и «Проверьте» — настройки
// базы: по ним считает ядро.
import { useEffect, useState } from "react";
import { SECTIONS, type SectionId } from "./sections";
import { pushPref } from "./uiPrefs";

export const FINE_KEY = "kazna.fine";
const FINE_EVENT = "kazna:fine";
const LAST_KEY = "kazna.lastSection";

export interface Fine {
  /** Экран при запуске; «last» — где закончили. */
  start: SectionId | "last";
  week: "mon" | "sun";
  /** Показывать копейки (центы). Без них суммы округляются до целых — только на экране. */
  kopecks: boolean;
  /** Код валюты («RUB») вместо значка («₽»). */
  code: boolean;
}

export const DEFAULT_FINE: Fine = { start: "home", week: "mon", kopecks: true, code: false };

const isSection = (x: unknown): x is SectionId => SECTIONS.some((s) => s.id === x);

export function parseFine(raw: string | null | undefined): Fine {
  try {
    const v = JSON.parse(raw || "null");
    if (!v || typeof v !== "object") return DEFAULT_FINE;
    return {
      start: v.start === "last" || isSection(v.start) ? v.start : "home",
      week: v.week === "sun" ? "sun" : "mon",
      kopecks: v.kopecks !== false,
      code: v.code === true,
    };
  } catch {
    return DEFAULT_FINE;
  }
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

let current: Fine = parseFine(read(FINE_KEY));
/** Текущие настройки для мест вне React (formatMoney, даты). */
export const fine = () => current;

export function saveFine(f: Fine) {
  const v = JSON.stringify(f);
  pushPref(FINE_KEY, v);
  try {
    localStorage.setItem(FINE_KEY, v);
  } catch {
    /* без запоминания */
  }
  notifyFine();
}

/** Перечитать из окна (после восстановления из базы) и сообщить экрану. */
export function notifyFine() {
  current = parseFine(read(FINE_KEY));
  window.dispatchEvent(new Event(FINE_EVENT));
}

export function useFine(): Fine {
  const [f, setF] = useState(current);
  useEffect(() => {
    const on = () => setF(fine());
    window.addEventListener(FINE_EVENT, on);
    return () => window.removeEventListener(FINE_EVENT, on);
  }, []);
  return f;
}

/** С какого экрана начать. */
export function startSection(f: Fine = current): SectionId {
  if (f.start !== "last") return f.start;
  const last = read(LAST_KEY);
  return isSection(last) && last !== "settings" ? last : "home";
}

export function rememberSection(s: SectionId) {
  if (current.start !== "last") return;
  try {
    localStorage.setItem(LAST_KEY, s);
  } catch {
    /* без запоминания */
  }
}

/** Значок валюты → код (для «RUB» вместо «₽»). */
const CODES: Record<string, string> = { "₽": "RUB", $: "USD", "€": "EUR", "¥": "CNY", "£": "GBP", "₸": "KZT" };
export const currencyLabel = (symbol: string, f: Fine = current) => (f.code ? (CODES[symbol] ?? symbol) : symbol);

/** Без копеек суммы на экране округляются до целых. */
export const shownAmount = (amount: number, minorUnits: number, f: Fine = current) => {
  if (f.kopecks || minorUnits <= 0) return amount;
  const k = 10 ** minorUnits;
  return Math.round(amount / k) * k;
};

/** Номер дня недели от её начала: 0 — понедельник (или воскресенье). */
export const weekdayIndex = (jsDay: number, f: Fine = current) => (f.week === "sun" ? jsDay : (jsDay + 6) % 7);
