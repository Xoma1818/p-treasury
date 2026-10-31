import {
  ArrowLeftRight,
  CalendarDays,
  ChartColumn,
  ChartPie,
  HandCoins,
  House,
  LayoutGrid,
  type LucideIcon,
  Settings,
  StickyNote,
  TrendingUp,
  Wallet,
} from "lucide-react";
import { section, type SectionId } from "../lib/sections";
import { Hint } from "./Hint";

// Значки разделов (0.25): набор Lucide, линия 1.75, без цветных плашек.
// Серые; у открытого раздела — цвет акцента (styles.css, «Лаконичный»).
const ICONS: Record<SectionId, LucideIcon> = {
  home: House,
  transactions: ArrowLeftRight,
  calendar: CalendarDays,
  budget: ChartPie,
  debts: HandCoins,
  reports: ChartColumn,
  forecast: TrendingUp,
  accounts: Wallet,
  categories: LayoutGrid,
  notes: StickyNote,
  settings: Settings,
};

/** Значок раздела. */
export function SectionIcon({ id }: { id: SectionId }) {
  const Icon = ICONS[id];
  return (
    <span className="icon-tile" aria-hidden="true">
      <Icon strokeWidth={1.75} />
    </span>
  );
}

/** Заголовок экрана: крупное название и одна строка о том, что здесь делать. */
export function ScreenTitle({ id }: { id: SectionId }) {
  const s = section(id);
  return (
    <div className="screen-title">
      <div>
        <h1>
          {s.title}
          <Hint of={`section.${id}`} />
        </h1>
        <p className="screen-hint">{s.hint}</p>
      </div>
    </div>
  );
}
