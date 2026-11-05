// Г4 и Г6: своё меню и главная кнопка «+». Настройки вида этого компьютера (localStorage),
// копия уходит в базу через uiPrefs, поэтому переживает перенос и восстановление копии.
import { useEffect, useState } from "react";
import { SECTIONS, type SectionId } from "./sections";
import { pushPref } from "./uiPrefs";

export const NAV_KEY = "kazna.navLayout";
export const ADD_KEY = "kazna.addMain";
const NAV_EVENT = "kazna:nav";

/** Порядок разделов, скрытые разделы и «Мои виды» вверху меню. «Настройки» всегда последние. */
export type NavLayout = { order: SectionId[]; hidden: SectionId[]; viewsTop: boolean };
export type AddMain = "expense" | "income" | "transfer";

/** Разделы, которые нельзя убрать из меню: без них не вернуться к настройке. */
export const NAV_FIXED: SectionId[] = ["home", "settings"];
const MOVABLE = SECTIONS.map((s) => s.id).filter((id) => id !== "settings") as SectionId[];

export const DEFAULT_NAV: NavLayout = { order: MOVABLE, hidden: [], viewsTop: false };

const isId = (x: unknown): x is SectionId => typeof x === "string" && MOVABLE.includes(x as SectionId);

/** Разобрать сохранённое меню: неизвестные разделы отбрасываются, новые (из обновления) встают в конец. */
export function parseNav(raw: string | null | undefined): NavLayout {
  try {
    const v = JSON.parse(raw || "{}");
    if (!v || typeof v !== "object") return DEFAULT_NAV;
    const order: SectionId[] = Array.isArray(v.order) ? [...new Set((v.order as unknown[]).filter(isId))] : [];
    for (const id of MOVABLE) if (!order.includes(id)) order.push(id);
    const hidden: SectionId[] = Array.isArray(v.hidden) ? [...new Set((v.hidden as unknown[]).filter(isId))].filter((id) => !NAV_FIXED.includes(id)) : [];
    return { order, hidden, viewsTop: v.viewsTop === true };
  } catch {
    return DEFAULT_NAV;
  }
}

export function isDefaultNav(l: NavLayout): boolean {
  return !l.viewsTop && l.hidden.length === 0 && l.order.every((id, i) => id === DEFAULT_NAV.order[i]);
}

export function parseAddMain(raw: string | null | undefined): AddMain {
  return raw === "income" || raw === "transfer" ? raw : "expense";
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  pushPref(key, value);
  try {
    localStorage.setItem(key, value);
  } catch {
    /* без запоминания */
  }
  window.dispatchEvent(new Event(NAV_EVENT));
}

export const savedNav = () => parseNav(read(NAV_KEY));
export const savedAddMain = () => parseAddMain(read(ADD_KEY));
export const saveNav = (l: NavLayout) => write(NAV_KEY, JSON.stringify(l));
export const saveAddMain = (v: AddMain) => write(ADD_KEY, v);

/** Сообщить меню и кнопке «+», что настройки пришли из базы (после восстановления копии). */
export const notifyNav = () => window.dispatchEvent(new Event(NAV_EVENT));

/** Текущее меню и главная кнопка; обновляются сразу после изменения в Настройках. */
export function useNavPrefs() {
  const [state, setState] = useState(() => ({ nav: savedNav(), addMain: savedAddMain() }));
  useEffect(() => {
    const on = () => setState({ nav: savedNav(), addMain: savedAddMain() });
    window.addEventListener(NAV_EVENT, on);
    return () => window.removeEventListener(NAV_EVENT, on);
  }, []);
  return state;
}

/** Разделы в порядке меню, без скрытых и выключенных модулей; «Настройки» в конце.
 *  Этот же порядок задаёт Ctrl+1…9. */
export function navSections(l: NavLayout, sectionOn: (id: SectionId) => boolean) {
  const ids = [...l.order.filter((id) => !l.hidden.includes(id)), "settings" as SectionId];
  return ids.filter(sectionOn).map((id) => SECTIONS.find((s) => s.id === id)!);
}
