// Теги в форме операции (Г6): ввод «#ремонт» или «ремонт», без повторов.

/** Имя тега из ввода: без «#» и лишних пробелов; пусто — null (как в ядре). */
export function cleanTag(raw: string): string | null {
  const s = raw.trim().replace(/^#+/, "").trim().split(/\s+/).filter(Boolean).join(" ");
  return s ? s : null;
}

/** Добавить тег, если такого ещё нет (без учёта регистра). */
export function addTag(list: string[], raw: string): string[] {
  const t = cleanTag(raw);
  if (!t || list.some((x) => x.toLowerCase() === t.toLowerCase())) return list;
  return [...list, t];
}

/** Подсказки: существующие теги, которые начинаются или содержат набранное и ещё не выбраны. */
export function tagSuggestions(all: string[], typed: string, chosen: string[], limit = 6): string[] {
  const q = (cleanTag(typed) ?? "").toLowerCase();
  const taken = new Set(chosen.map((c) => c.toLowerCase()));
  const free = all.filter((t) => !taken.has(t.toLowerCase()));
  if (!q) return free.slice(0, limit);
  const starts = free.filter((t) => t.toLowerCase().startsWith(q));
  const inner = free.filter((t) => !t.toLowerCase().startsWith(q) && t.toLowerCase().includes(q));
  return [...starts, ...inner].slice(0, limit);
}
