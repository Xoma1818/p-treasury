import { ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useUi } from "../lib/store";

/** Шапка Главной (п. 1 плана): одна мятная «+ Расход», доход и перевод — в меню ▾.
 *  Меню закрывается по Esc, щелчку мимо и после выбора пункта. */
export function AddMenu() {
  const openTxnForm = useUi((s) => s.openTxnForm);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const pick = (type: "income" | "transfer") => {
    setOpen(false);
    openTxnForm({ mode: "new", type });
  };
  return (
    <div className="split-btn" ref={box} data-testid="add-menu">
      <button className="btn primary" onClick={() => openTxnForm({ mode: "new", type: "expense" })} title="Ctrl+N">
        + Расход
      </button>
      <button
        className="btn primary split-toggle"
        aria-label="Другие операции"
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="add-menu-toggle"
        onClick={() => setOpen(!open)}
      >
        <ChevronDown size={16} aria-hidden />
      </button>
      {open && (
        <div className="menu-pop" role="menu">
          <button role="menuitem" className="menu-item" onClick={() => pick("income")}>
            + Доход
          </button>
          <button role="menuitem" className="menu-item" onClick={() => pick("transfer")}>
            Перевод
          </button>
        </div>
      )}
    </div>
  );
}
