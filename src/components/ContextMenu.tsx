import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { create } from "zustand";

/** Г2: меню по правой кнопке мыши. Строка вызывает `openContextMenu(e, пункты)`,
 *  меню одно на всё окно и закрывается по Esc, щелчку мимо, прокрутке и выбору пункта. */
export interface CtxItem {
  text: ReactNode;
  onClick: () => void;
  danger?: boolean;
  hint?: string;
}

interface CtxState {
  menu: { x: number; y: number; items: CtxItem[] } | null;
  show: (x: number, y: number, items: CtxItem[]) => void;
  hide: () => void;
}

const useCtx = create<CtxState>((set) => ({
  menu: null,
  show: (x, y, items) => set({ menu: { x, y, items } }),
  hide: () => set({ menu: null }),
}));

export function openContextMenu(e: React.MouseEvent, items: CtxItem[]) {
  if (items.length === 0) return;
  e.preventDefault();
  e.stopPropagation();
  useCtx.getState().show(e.clientX, e.clientY, items);
}

export function ContextMenuHost() {
  const { menu, hide } = useCtx();
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  // Меню не выходит за край окна: у правого и нижнего края открывается влево и вверх.
  useLayoutEffect(() => {
    if (!menu || !box.current) return setPos(null);
    const r = box.current.getBoundingClientRect();
    setPos({ left: Math.min(menu.x, innerWidth - r.width - 8), top: Math.min(menu.y, innerHeight - r.height - 8) });
  }, [menu]);
  useEffect(() => {
    if (!menu) return;
    box.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const onDown = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && hide();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") return hide();
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      const btns = [...(box.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
      const i = btns.indexOf(document.activeElement as HTMLButtonElement);
      btns[(i + (e.key === "ArrowDown" ? 1 : btns.length - 1)) % btns.length]?.focus();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("blur", hide);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("blur", hide);
    };
  }, [menu, hide]);
  if (!menu) return null;
  return (
    <div
      ref={box}
      className="menu-pop ctx-menu"
      role="menu"
      data-testid="context-menu"
      style={{ left: pos?.left ?? menu.x, top: pos?.top ?? menu.y, visibility: pos ? "visible" : "hidden" }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {menu.items.map((it, i) => (
        <button
          key={i}
          role="menuitem"
          className={it.danger ? "menu-item danger" : "menu-item"}
          onClick={() => {
            hide();
            it.onClick();
          }}
        >
          <span>{it.text}</span>
          {it.hint && <kbd>{it.hint}</kbd>}
        </button>
      ))}
    </div>
  );
}
