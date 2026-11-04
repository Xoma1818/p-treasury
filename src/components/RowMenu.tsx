import { MoreHorizontal } from "lucide-react";
import type { ReactNode } from "react";
import { usePopup } from "../lib/usePopup";

/** Меню «⋯» в строке таблицы (п. 13): редкие действия убраны с глаз, но в одном нажатии. */
export function RowMenu({ label, items }: { label: string; items: { text: ReactNode; onClick: () => void; danger?: boolean }[] }) {
  const { open, setOpen, ref } = usePopup();
  return (
    <div className="row-menu" ref={ref}>
      <button className="icon-btn" aria-label={label} aria-haspopup="menu" aria-expanded={open} data-testid="row-menu" onClick={() => setOpen(!open)}>
        <MoreHorizontal size={16} aria-hidden />
      </button>
      {open && (
        <div className="menu-pop" role="menu">
          {items.map((it, i) => (
            <button
              key={i}
              role="menuitem"
              className={it.danger ? "menu-item danger" : "menu-item"}
              onClick={() => {
                setOpen(false);
                it.onClick();
              }}
            >
              {it.text}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
