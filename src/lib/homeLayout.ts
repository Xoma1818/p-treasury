/** Карточки Главной: порядок и скрытые сохраняются в настройке `home_layout` (JSON). */
export const HOME_BLOCKS = {
  quick: "Быстрый ввод",
  summary: "Сводка месяца",
  tiles: "Баланс и месяц",
  checks: "Проверьте",
  unusual: "Необычно в этом месяце",
  figures: "Свои цифры",
  trend: "Полгода и куда ушли деньги",
  cushion: "Финансовая подушка",
  ahead: "Взгляд вперёд",
  invest: "Инвестиции",
  goals: "Цели накоплений",
  subs: "Регулярные платежи",
  days: "Траты по дням",
  templates: "Шаблоны",
  spend: "Куда тратите",
  accounts: "Счета",
  recent: "Последние операции",
  plans: "Бюджет и платежи по долгам",
  reminders: "Ближайшие напоминания",
} as const;

export type HomeBlock = keyof typeof HOME_BLOCKS;

export interface HomeLayout {
  order: HomeBlock[];
  hidden: HomeBlock[];
  /** Старая общая строка «Счета и последние операции» сохраняет свои пропорции. */
  groupedMain?: boolean;
  /** Г7: карточки в половину ширины (две в ряд); остальные — во всю строку. */
  half?: HomeBlock[];
}

const ALL = Object.keys(HOME_BLOCKS) as HomeBlock[];

/** Основные карточки. Счета и последние операции изначально занимают общую строку. */
export const DEFAULT_SHOWN: HomeBlock[] = ["quick", "tiles", "checks", "plans", "accounts", "recent"];

export const DEFAULT_LAYOUT: HomeLayout = { order: ALL, hidden: ALL.filter((b) => !DEFAULT_SHOWN.includes(b)), groupedMain: true };

/** Место для активных предупреждений в видимой раскладке. Карточка «Проверьте»
 * может уже стоять выше сводки, а в основной раскладке сводка скрыта. */
export function withOverspendSlot(blocks: HomeBlock[]): (HomeBlock | "overspend")[] {
  const checks = blocks.indexOf("checks");
  if (checks < 0) return blocks;
  const summary = blocks.indexOf("summary");
  const tiles = blocks.indexOf("tiles");
  const index = Math.min(checks, summary >= 0 ? summary + 1 : Math.max(tiles, 0));
  return [...blocks.slice(0, index), "overspend", ...blocks.slice(index)];
}

/** Разбор настройки: пусто — карточки по умолчанию; неизвестные карточки отбрасываются,
 * новые (из обновлений) встают после той карточки, за которой идут по умолчанию.
 * В раскладке до 0.21 новые карточки видны (как было), в новой — скрыты. */
export function parseLayout(raw: string | undefined | null): HomeLayout {
  if (!raw) return DEFAULT_LAYOUT;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return DEFAULT_LAYOUT;
  }
  if (!value || typeof value !== "object" || !("order" in value) || !Array.isArray(value.order)) return DEFAULT_LAYOUT;
  const saved = value as Record<string, unknown>;
  const legacy = saved.v !== 3;
  const known = (list: unknown): HomeBlock[] => {
    const blocks = new Set<HomeBlock>();
    if (Array.isArray(list)) {
      for (const id of list) {
        if (legacy && id === "main") {
          blocks.add("accounts");
          blocks.add("recent");
        } else if (ALL.includes(id)) {
          blocks.add(id);
        }
      }
    }
    return [...blocks];
  };
  const order = known(saved.order);
  const hidden = known(saved.hidden);
  const half = known(saved.half);
  for (const b of ALL) {
    if (order.includes(b)) continue;
    if ((saved.v === 2 || saved.v === 3) && !DEFAULT_SHOWN.includes(b) && !hidden.includes(b)) hidden.push(b);
    const prev = ALL.slice(0, ALL.indexOf(b)).reverse().find((p) => order.includes(p));
    order.splice(prev ? order.indexOf(prev) + 1 : 0, 0, b);
  }
  const grouped = (legacy || saved.groupedMain === true) && mainTogether(order) && half.includes("accounts") === half.includes("recent");
  return { order, hidden, ...(grouped && { groupedMain: true }), ...(half.length && { half }) };
}

function mainTogether(order: HomeBlock[]) {
  const index = order.indexOf("accounts");
  return index >= 0 && order[index + 1] === "recent";
}

function independentMain(layout: HomeLayout): HomeLayout {
  if (!layout.groupedMain) return layout;
  const { groupedMain: _, ...rest } = layout;
  return rest;
}

function reorderSlots(order: HomeBlock[], visible: HomeBlock[], sorted: HomeBlock[]) {
  const slots = new Set(visible);
  let index = 0;
  return order.map((block) => slots.has(block) ? sorted[index++] : block);
}

/** Переставляем только карточки включённых модулей. Остальные сохраняют свои места. */
function replaceVisible(l: HomeLayout, block: HomeBlock, visible: HomeBlock[], ordered: HomeBlock[]): HomeLayout {
  if (visible.every((b, i) => b === ordered[i])) return l;
  const childMoved = block === "accounts" || block === "recent";
  const insertedBetween = visible.includes("accounts") && visible.includes("recent") && !mainTogether(ordered);
  if (l.groupedMain && mainTogether(l.order) && !childMoved && !insertedBetween) {
    // В прежней раскладке пара занимала один слот. При переносе другой карточки
    // мимо пары выключенный модуль должен остаться именно в своём слоте.
    const groupedSlots = (blocks: HomeBlock[]) => [...new Set(blocks.map((b) => b === "recent" ? "accounts" : b))];
    const sorted = reorderSlots(groupedSlots(l.order), groupedSlots(visible), groupedSlots(ordered));
    return { ...l, order: sorted.flatMap((b) => b === "accounts" ? ["accounts", "recent"] : [b]) };
  }
  return { ...independentMain(l), order: reorderSlots(l.order, visible, ordered) };
}

/** Передвинуть карточку на `delta` видимых позиций (−1 — выше). */
export function moveBlock(l: HomeLayout, block: HomeBlock, delta: number, visible = l.order): HomeLayout {
  const order = [...visible];
  const i = order.indexOf(block);
  if (i < 0) return l;
  const j = Math.max(0, Math.min(order.length - 1, i + delta));
  order.splice(i, 1);
  order.splice(j, 0, block);
  return replaceVisible(l, block, visible, order);
}

/** Поставить карточку перед другой (перетаскиванием). */
export function placeBefore(l: HomeLayout, block: HomeBlock, target: HomeBlock, visible = l.order): HomeLayout {
  if (block === target || !visible.includes(block) || !visible.includes(target)) return l;
  const order = visible.filter((b) => b !== block);
  order.splice(order.indexOf(target), 0, block);
  return replaceVisible(l, block, visible, order);
}

export function toggleBlock(l: HomeLayout, block: HomeBlock): HomeLayout {
  const hidden = l.hidden.includes(block) ? l.hidden.filter((b) => b !== block) : [...l.hidden, block];
  return { ...l, hidden };
}

/** Половина ширины ↔ вся строка. */
export function toggleHalf(l: HomeLayout, block: HomeBlock): HomeLayout {
  const cur = l.half ?? [];
  const half = cur.includes(block) ? cur.filter((b) => b !== block) : [...cur, block];
  const { half: _, ...rest } = block === "accounts" || block === "recent" ? independentMain(l) : l;
  return half.length ? { ...rest, half } : rest;
}

/** Сброс действующих карточек оставляет персональные настройки выключенных модулей. */
export function resetLayout(layout: HomeLayout, editable = layout.order): HomeLayout {
  if (!editable.length) return layout;
  const active = new Set(editable);
  const defaults = ALL.filter((block) => active.has(block));
  let index = 0;
  const order = layout.order.map((block) => active.has(block) ? defaults[index++] : block);
  const hidden = order.filter((block) => (active.has(block) ? DEFAULT_LAYOUT.hidden : layout.hidden).includes(block));
  const half = layout.half?.filter((block) => !active.has(block));
  const resetPair = active.has("accounts") && active.has("recent");
  const grouped = (resetPair || layout.groupedMain) && mainTogether(order) && half?.includes("accounts") === half?.includes("recent");
  return { order, hidden, ...(grouped && { groupedMain: true }), ...(half?.length && { half }) };
}

/** Раскладка к сохранению: всегда в новом виде. */
export function toSetting(l: HomeLayout): string {
  return JSON.stringify({ v: 3, order: l.order, hidden: l.hidden, ...(l.half?.length && { half: l.half }), ...(l.groupedMain && { groupedMain: true }) });
}
