import type { HomeBlock } from "./homeLayout";
import { useSettings } from "./queries";
import type { SectionId } from "./sections";

/** Г3: модули, которые можно выключить (Настройки → «Возможности»).
 *  Выключенный модуль убирает свои пункты меню, карточки и вкладки; данные остаются. */
export const MODULES = {
  invest: { title: "Инвестиции", hint: "Карточка на Главной и оценка стоимости счетов", blocks: ["invest"] as HomeBlock[], sections: [] as SectionId[] },
  debts: { title: "Займы и долги", hint: "Раздел меню и платежи по долгам на Главной", blocks: [] as HomeBlock[], sections: ["debts"] as SectionId[] },
  events: { title: "Поездки и события", hint: "Карточка в Бюджете", blocks: [] as HomeBlock[], sections: [] as SectionId[] },
  habits: { title: "Привычки", hint: "Дни без трат в Календаре", blocks: [] as HomeBlock[], sections: [] as SectionId[] },
  subs: { title: "Подписки", hint: "Регулярные платежи на Главной и в Отчётах", blocks: ["subs"] as HomeBlock[], sections: [] as SectionId[] },
  forecast: { title: "Взгляд вперёд", hint: "Раздел меню и карточка на Главной", blocks: ["ahead"] as HomeBlock[], sections: ["forecast"] as SectionId[] },
  notes: { title: "Заметки", hint: "Раздел меню", blocks: [] as HomeBlock[], sections: ["notes"] as SectionId[] },
} as const;

export type ModuleId = keyof typeof MODULES;
export const MODULE_IDS = Object.keys(MODULES) as ModuleId[];

/** Выключенные модули из настройки `ui_modules` (JSON-список). Ошибочное значение — всё включено. */
export function parseModulesOff(raw: string | undefined): ModuleId[] {
  try {
    const v = JSON.parse(raw || "[]");
    return Array.isArray(v) ? v.filter((x): x is ModuleId => typeof x === "string" && x in MODULES) : [];
  } catch {
    return [];
  }
}

export function useModules() {
  const off = parseModulesOff(useSettings().data?.ui_modules);
  const on = (m: ModuleId) => !off.includes(m);
  const sectionOn = (s: SectionId) => !off.some((m) => MODULES[m].sections.includes(s));
  const blockOn = (b: HomeBlock) => !off.some((m) => MODULES[m].blocks.includes(b));
  return { off, on, sectionOn, blockOn };
}
