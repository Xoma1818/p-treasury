// Р22: значок и цвет категории. В базе хранятся имена; подкатегория без своего
// значка или цвета берёт их у родителя.
import type { LucideIcon } from "lucide-react";
import {
  Baby, BookOpen, Briefcase, Bus, Car, Coffee, Coins, Dumbbell, Film, Fuel, Gamepad2, Gift, GraduationCap, HeartPulse, House,
  Landmark, Music, PawPrint, Percent, PiggyBank, Pill, Plane, Receipt, Shirt, ShoppingCart, Smartphone, Sparkles, Utensils, Wallet, Wifi,
  Wrench, Zap,
} from "lucide-react";
import type { Category } from "./api";

export const CATEGORY_ICONS: Record<string, { icon: LucideIcon; label: string }> = {
  "shopping-cart": { icon: ShoppingCart, label: "Покупки" },
  utensils: { icon: Utensils, label: "Еда" },
  coffee: { icon: Coffee, label: "Кафе" },
  car: { icon: Car, label: "Машина" },
  bus: { icon: Bus, label: "Транспорт" },
  fuel: { icon: Fuel, label: "Топливо" },
  house: { icon: House, label: "Дом" },
  zap: { icon: Zap, label: "Коммунальные" },
  smartphone: { icon: Smartphone, label: "Связь" },
  wifi: { icon: Wifi, label: "Интернет" },
  "heart-pulse": { icon: HeartPulse, label: "Здоровье" },
  pill: { icon: Pill, label: "Лекарства" },
  shirt: { icon: Shirt, label: "Одежда" },
  baby: { icon: Baby, label: "Дети" },
  "graduation-cap": { icon: GraduationCap, label: "Учёба" },
  "book-open": { icon: BookOpen, label: "Книги" },
  "gamepad-2": { icon: Gamepad2, label: "Игры" },
  film: { icon: Film, label: "Кино" },
  music: { icon: Music, label: "Музыка" },
  gift: { icon: Gift, label: "Подарки" },
  plane: { icon: Plane, label: "Путешествия" },
  dumbbell: { icon: Dumbbell, label: "Спорт" },
  "paw-print": { icon: PawPrint, label: "Питомцы" },
  wrench: { icon: Wrench, label: "Ремонт" },
  briefcase: { icon: Briefcase, label: "Работа" },
  wallet: { icon: Wallet, label: "Кошелёк" },
  coins: { icon: Coins, label: "Деньги" },
  "piggy-bank": { icon: PiggyBank, label: "Накопления" },
  percent: { icon: Percent, label: "Проценты" },
  receipt: { icon: Receipt, label: "Счета" },
  landmark: { icon: Landmark, label: "Банк, налоги" },
  sparkles: { icon: Sparkles, label: "Прочее" },
};

/** Те же имена, что в ядре (categories::COLORS). */
export const CATEGORY_COLORS = ["mint", "teal", "sky", "blue", "violet", "pink", "rose", "orange", "amber", "olive"] as const;
export type CategoryColor = (typeof CATEGORY_COLORS)[number];
export const COLOR_LABEL: Record<CategoryColor, string> = {
  mint: "Мятный",
  teal: "Бирюзовый",
  sky: "Голубой",
  blue: "Синий",
  violet: "Фиолетовый",
  pink: "Розовый",
  rose: "Красный",
  orange: "Оранжевый",
  amber: "Янтарный",
  olive: "Оливковый",
};

export const isColor = (c: string | null | undefined): c is CategoryColor => CATEGORY_COLORS.includes(c as CategoryColor);
export const colorVar = (c: CategoryColor) => `var(--cat-${c})`;

export interface Look {
  icon: string | null;
  color: CategoryColor | null;
}

/** Свой значок и цвет или родительские. */
export function lookOf(id: string | null | undefined, byId: Map<string, Category>): Look {
  const c = id ? byId.get(id) : undefined;
  if (!c) return { icon: null, color: null };
  const p = c.parentId ? byId.get(c.parentId) : undefined;
  const icon = (c.icon && CATEGORY_ICONS[c.icon] ? c.icon : null) ?? (p?.icon && CATEGORY_ICONS[p.icon] ? p.icon : null);
  const color = (isColor(c.color) ? c.color : null) ?? (isColor(p?.color) ? (p!.color as CategoryColor) : null);
  return { icon, color };
}
