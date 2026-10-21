/** Карточки Главной: порядок и скрытые сохраняются в настройке `home_layout` (JSON). */
export const HOME_BLOCKS = {
  quick: "Быстрый ввод",
  summary: "Сводка месяца",
  tiles: "Баланс и месяц",
  trend: "Полгода и куда ушли деньги",
  cushion: "Финансовая подушка",
  invest: "Инвестиции",
  goals: "Цели накоплений",
  subs: "Регулярные платежи",
  days: "Траты по дням",
  templates: "Шаблоны",
  spend: "Куда тратите",
  main: "Счета и последние операции",
  plans: "Бюджет и платежи по долгам",
  reminders: "Ближайшие напоминания",
} as const;

export type HomeBlock = keyof typeof HOME_BLOCKS;

export interface HomeLayout {
  order: HomeBlock[];
  hidden: HomeBlock[];
}

const ALL = Object.keys(HOME_BLOCKS) as HomeBlock[];
export const DEFAULT_LAYOUT: HomeLayout = { order: ALL, hidden: [] };

/** Разбор настройки: неизвестные карточки отбрасываются, новые (из обновлений) встают
 * после той карточки, за которой идут по умолчанию. */
export function parseLayout(raw: string | undefined | null): HomeLayout {
  let v: Partial<HomeLayout> = {};
  try {
    v = raw ? JSON.parse(raw) : {};
  } catch {
    v = {};
  }
  const known = (list: unknown): HomeBlock[] =>
    Array.isArray(list) ? list.filter((x, i): x is HomeBlock => ALL.includes(x) && list.indexOf(x) === i) : [];
  const order = known(v.order);
  for (const b of ALL) {
    if (order.includes(b)) continue;
    const prev = ALL.slice(0, ALL.indexOf(b)).reverse().find((p) => order.includes(p));
    order.splice(prev ? order.indexOf(prev) + 1 : 0, 0, b);
  }
  return { order, hidden: known(v.hidden) };
}

/** Передвинуть карточку на `delta` позиций (−1 — выше). */
export function moveBlock(l: HomeLayout, block: HomeBlock, delta: number): HomeLayout {
  const order = [...l.order];
  const i = order.indexOf(block);
  const j = Math.max(0, Math.min(order.length - 1, i + delta));
  order.splice(i, 1);
  order.splice(j, 0, block);
  return { ...l, order };
}

/** Поставить карточку перед другой (перетаскиванием). */
export function placeBefore(l: HomeLayout, block: HomeBlock, target: HomeBlock): HomeLayout {
  if (block === target) return l;
  const order = l.order.filter((b) => b !== block);
  order.splice(order.indexOf(target), 0, block);
  return { ...l, order };
}

export function toggleBlock(l: HomeLayout, block: HomeBlock): HomeLayout {
  const hidden = l.hidden.includes(block) ? l.hidden.filter((b) => b !== block) : [...l.hidden, block];
  return { ...l, hidden };
}
