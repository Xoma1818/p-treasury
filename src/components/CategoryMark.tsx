import { useMemo } from "react";
import type { Category } from "../lib/api";
import { CATEGORY_ICONS, colorVar, lookOf, type Look } from "../lib/categoryLook";
import { useCategories } from "../lib/queries";

/** Карта категорий по id для значков (общий кэш запроса категорий). */
export function useCategoryMap(): Map<string, Category> {
  const all = useCategories(true).data;
  return useMemo(() => new Map((all ?? []).map((c) => [c.id, c])), [all]);
}

/** Р22: кружок со значком в цвете категории; без значка и цвета ничего не рисует. */
export function LookMark({ look, size = 18 }: { look: Look; size?: number }) {
  if (!look.icon && !look.color) return null;
  const Icon = look.icon ? CATEGORY_ICONS[look.icon]?.icon : null;
  const color = look.color ? colorVar(look.color) : "var(--muted)";
  return (
    <span className="cat-mark" style={{ width: size, height: size, color, background: `color-mix(in srgb, ${color} 16%, transparent)` }} data-testid="cat-mark" aria-hidden="true">
      {Icon ? <Icon size={Math.round(size * 0.62)} strokeWidth={2} /> : <span className="cat-dot" style={{ background: color }} />}
    </span>
  );
}

export function CategoryMark({ id, size }: { id: string | null | undefined; size?: number }) {
  const map = useCategoryMap();
  return <LookMark look={lookOf(id, map)} size={size} />;
}
