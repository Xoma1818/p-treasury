import type { CSSProperties } from "react";
import { section, type SectionId } from "../lib/sections";
import { Hint } from "./Hint";

// Значки разделов: линии 1.8 px в квадрате 24×24, цвет — от раздела.
const PATHS: Record<SectionId, string[]> = {
  home: ["M3.5 11 12 4l8.5 7", "M5.5 9.5V19a1 1 0 0 0 1 1h3.5v-5.5h4V20h3.5a1 1 0 0 0 1-1V9.5"],
  transactions: ["M4 8h14", "M14.5 4.5 18 8l-3.5 3.5", "M20 16H6", "M9.5 12.5 6 16l3.5 3.5"],
  calendar: ["M4.5 6.5h15v13h-15z", "M4.5 10.5h15", "M8.5 3.5v5", "M15.5 3.5v5", "M8 14h2", "M14 14h2", "M8 17h2"],
  budget: ["M12 3.5a8.5 8.5 0 1 0 8.5 8.5H12z", "M15 3.9A8.5 8.5 0 0 1 20.1 9H15z"],
  debts: ["M3.5 7.5h17v10h-17z", "M12 12.5m-2.2 0a2.2 2.2 0 1 0 4.4 0a2.2 2.2 0 1 0-4.4 0", "M6.5 10.5v4", "M17.5 10.5v4"],
  reports: ["M4.5 20h15", "M7 16.5v-5", "M12 16.5V6", "M17 16.5v-8"],
  forecast: ["M3.5 18.5 9 13l3.5 3 8-8.5", "M15 7.5h5.5V13"],
  accounts: ["M3.5 6.5h17v12h-17z", "M3.5 10.5h17", "M7 15h4"],
  categories: ["M4.5 4.5h6v6h-6z", "M13.5 4.5h6v6h-6z", "M4.5 13.5h6v6h-6z", "M16.5 13.5m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0"],
  notes: ["M6.5 3.5h8l4 4v13h-12z", "M14.5 3.5v4h4", "M9 12h6", "M9 16h4"],
  settings: [
    "M12 9.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6z",
    "M19.3 13.2a7.4 7.4 0 0 0 0-2.4l1.9-1.4-1.9-3.3-2.2.9a7.4 7.4 0 0 0-2.1-1.2L14.7 3.5h-3.8l-.3 2.3a7.4 7.4 0 0 0-2.1 1.2l-2.2-.9-1.9 3.3 1.9 1.4a7.4 7.4 0 0 0 0 2.4l-1.9 1.4 1.9 3.3 2.2-.9a7.4 7.4 0 0 0 2.1 1.2l.3 2.3h3.8l.3-2.3a7.4 7.4 0 0 0 2.1-1.2l2.2.9 1.9-3.3z",
  ],
};

/** Значок раздела в цветной плашке. */
export function SectionIcon({ id, size = "md" }: { id: SectionId; size?: "md" | "lg" }) {
  return (
    <span className={`icon-tile ${size}`} style={{ "--c": section(id).color } as CSSProperties} aria-hidden="true">
      <svg viewBox="0 0 24 24">
        {PATHS[id].map((d) => (
          <path key={d} d={d} />
        ))}
      </svg>
    </span>
  );
}

/** Заголовок экрана: значок, название и одна строка о том, что здесь делать. */
export function ScreenTitle({ id }: { id: SectionId }) {
  const s = section(id);
  return (
    <div className="screen-title">
      <SectionIcon id={id} size="lg" />
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
