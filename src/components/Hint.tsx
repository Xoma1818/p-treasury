import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { HINTS, type HintKey, type HintText } from "../lib/hints";
import { useSettings } from "../lib/queries";

const SHOW_DELAY = 120;
const LEAVE_DELAY = 180;
const GAP = 10;

/** Значок «?» в мятном кружке: под мышкой или фокусом — короткое пояснение,
 *  при желании с примером (`example`) и горячей клавишей (`keys`).
 *  Подсказку видно поверх всего: она рисуется в body и не обрезается карточкой.
 *  Выключаются все разом в Настройках («Показывать подсказки»). */
export function Hint(props: { of: HintKey } | { title: string; children: ReactNode; example?: ReactNode; keys?: string }) {
  const h: HintText | null = "of" in props ? HINTS[props.of] : null;
  const { title, children, example, keys } = h ? { ...h, children: h.text } : (props as Exclude<typeof props, { of: HintKey }>);
  if (useSettings().data?.hints === "0") return null;
  return <HintButton title={title} example={example} keys={keys}>{children}</HintButton>;
}

type HintContent = { title: string; children: ReactNode; example?: ReactNode; keys?: string };

function HintButton({ title, children, example, keys }: HintContent) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const timer = useRef(0);
  const id = useId();
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      window.clearTimeout(timer.current);
      setOpen(false);
    };
    window.addEventListener("keydown", dismiss, true);
    return () => window.removeEventListener("keydown", dismiss, true);
  }, [open]);
  const show = () => {
    window.clearTimeout(timer.current);
    if (!open) timer.current = window.setTimeout(() => setOpen(true), SHOW_DELAY);
  };
  const hide = () => {
    window.clearTimeout(timer.current);
    setOpen(false);
  };
  const leave = () => {
    if (document.activeElement === btn.current) return;
    window.clearTimeout(timer.current);
    if (open) timer.current = window.setTimeout(() => setOpen(false), LEAVE_DELAY);
  };
  return (
    <>
      <button
        ref={btn}
        type="button"
        className={open ? "hint-q open" : "hint-q"}
        aria-label={`Подсказка: ${title}`}
        aria-describedby={open ? id : undefined}
        data-testid="hint"
        onMouseEnter={show}
        onMouseLeave={leave}
        onFocus={show}
        onBlur={(event) => {
          if (event.relatedTarget || !document.getElementById(id)?.matches(":hover")) hide();
        }}
        onKeyDown={(e) => e.key === "Escape" && hide()}
        // Клик не должен открывать карточку или переключать вкладку под значком.
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          window.clearTimeout(timer.current);
          setOpen(!open);
        }}
      />
      {open && btn.current && (
        <Tip id={id} anchor={btn.current} title={title} example={example} keys={keys} onMouseEnter={show} onMouseLeave={leave}>
          {children}
        </Tip>
      )}
    </>
  );
}

function Tip({ id, anchor, title, children, example, keys, onMouseEnter, onMouseLeave }: HintContent & {
  id: string; anchor: HTMLElement; onMouseEnter: () => void; onMouseLeave: () => void;
}) {
  const tip = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; arrow: number; below: boolean } | null>(null);
  useLayoutEffect(() => {
    const a = anchor.getBoundingClientRect();
    const t = tip.current!.getBoundingClientRect();
    const below = a.bottom + GAP + t.height < window.innerHeight - 8 || a.top - GAP - t.height < 8;
    const center = a.left + a.width / 2;
    const left = Math.max(8, Math.min(center - t.width / 2, window.innerWidth - t.width - 8));
    setPos({ left, top: below ? a.bottom + GAP : a.top - GAP - t.height, arrow: center - left, below });
  }, [anchor]);
  return createPortal(
    <div
      ref={tip}
      id={id}
      role="tooltip"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onClick={(event) => event.stopPropagation()}
      data-testid="hint-tip"
      className={`hint-tip${pos ? " shown" : ""}${pos && !pos.below ? " above" : ""}`}
      style={pos ? { left: pos.left, top: pos.top, ["--arrow" as string]: `${pos.arrow}px`, ["--hint-gap" as string]: `${GAP}px` } : { left: 0, top: 0 }}
    >
      <b>{title}</b>
      <span>{children}</span>
      {example && <span className="hint-example">Пример: {example}</span>}
      {keys && (
        <span className="hint-keys">
          {keys.split(" ").map((k) => (
            <kbd key={k}>{k}</kbd>
          ))}
        </span>
      )}
    </div>,
    document.body,
  );
}
