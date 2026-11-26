import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

/** Сбоку от вертикальной панели, под кнопкой — у горизонтального меню узкого окна. */
function positionOverlay(anchor: HTMLElement, overlay: HTMLElement) {
  const button = anchor.getBoundingClientRect();
  const rail = anchor.closest("nav")!.getBoundingClientRect();
  const side = rail.right < window.innerWidth / 2;
  const left = side ? rail.right + 8 : button.left + (button.width - overlay.offsetWidth) / 2;
  const top = side ? button.top + (button.height - overlay.offsetHeight) / 2 : button.bottom + 8;
  overlay.style.left = `${Math.max(6, Math.min(left, window.innerWidth - overlay.offsetWidth - 6))}px`;
  overlay.style.top = `${Math.max(6, Math.min(top, window.innerHeight - overlay.offsetHeight - 6))}px`;
}

function visibleInList(button: HTMLElement) {
  const list = button.closest("ul");
  if (!list) return true;
  const clip = list.getBoundingClientRect();
  const box = button.getBoundingClientRect();
  return box.bottom > clip.top && box.top < clip.bottom && box.right > clip.left && box.left < clip.right;
}

/** Один ярлык на всю панель. Названия кнопок доступны также при выключенных подсказках «?». */
export function RailTooltip({ rail }: { rail: RefObject<HTMLElement | null> }) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const mouseLabel = useRef(false);
  const tip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const nav = rail.current;
    if (!nav) return;
    let delay = 0;
    let leaveDelay = 0;
    const clear = () => {
      window.clearTimeout(delay);
      window.clearTimeout(leaveDelay);
      setAnchor(null);
    };
    const buttonAt = (target: EventTarget | null) =>
      target instanceof Element ? target.closest<HTMLButtonElement>("button[data-rail-tip]") : null;
    const show = (button: HTMLButtonElement | null, immediate = false) => {
      clear();
      if (!button || button.getAttribute("aria-expanded") === "true") return;
      mouseLabel.current = !immediate;
      if (immediate) setAnchor(button);
      else delay = window.setTimeout(() => {
        if (button.isConnected && visibleInList(button)) setAnchor(button);
      }, 400);
    };
    const hover = (event: PointerEvent) => {
      if (event.target instanceof Node && tip.current?.contains(event.target)) {
        window.clearTimeout(leaveDelay);
        return;
      }
      const button = buttonAt(event.target);
      if (button && event.pointerType !== "touch" && button !== buttonAt(event.relatedTarget)) {
        show(button, button === document.activeElement && button.matches(":focus-visible"));
      }
    };
    const focusedButton = () => {
      const button = buttonAt(document.activeElement);
      return button?.matches(":focus-visible") && visibleInList(button) ? button : null;
    };
    const leave = (event: PointerEvent) => {
      const previous = buttonAt(event.target);
      const focused = focusedButton();
      const fromTip = event.target instanceof Node && tip.current?.contains(event.target);
      if (event.relatedTarget instanceof Node && tip.current?.contains(event.relatedTarget)) return;
      if (fromTip || (previous && previous !== focused && previous !== buttonAt(event.relatedTarget))) {
        window.clearTimeout(delay);
        window.clearTimeout(leaveDelay);
        leaveDelay = window.setTimeout(() => show(focusedButton(), true), 120);
      }
    };
    const focus = (event: FocusEvent) => {
      const button = buttonAt(event.target);
      if (button?.matches(":focus-visible")) show(button, true);
    };
    const onScroll = () => {
      const button = focusedButton();
      show(button, true);
      if (button && tip.current) positionOverlay(button, tip.current);
    };
    const key = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") clear(); };
    const events = new AbortController();
    const options = { signal: events.signal };
    document.addEventListener("pointerover", hover, options);
    document.addEventListener("pointerout", leave, options);
    nav.addEventListener("focusin", focus, options);
    nav.addEventListener("focusout", clear, options);
    nav.addEventListener("click", clear, options);
    document.addEventListener("keydown", key, options);
    document.addEventListener("scroll", onScroll, { ...options, capture: true });
    window.addEventListener("blur", clear, options);
    window.addEventListener("resize", clear, options);
    return () => {
      window.clearTimeout(delay);
      window.clearTimeout(leaveDelay);
      events.abort();
    };
  }, [rail]);
  useLayoutEffect(() => {
    if (anchor && tip.current) positionOverlay(anchor, tip.current);
  }, [anchor]);
  return anchor && createPortal(
    <div className="rail-tip" data-hover={mouseLabel.current || undefined} ref={tip} role="tooltip">
      {anchor.dataset.railTip}
    </div>, document.body,
  );
}

type MenuChoice = {
  id: string;
  name: string;
  icon?: ReactNode;
  checked?: boolean;
  testId?: string;
  pick: () => void;
};

export function RailMenu({ label, className, testId, icon, choices }: {
  label: string; className: string; testId: string; icon: ReactNode; choices: MenuChoice[];
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    if (!open) return;
    const panel = menu.current!;
    const place = () => positionOverlay(trigger.current!, panel);
    place();
    (panel.querySelector<HTMLButtonElement>('[aria-checked="true"]') ?? panel.querySelector("button"))?.focus();
    const follow = (event: Event) => {
      if (!(event.target instanceof Element) || !event.target.contains(trigger.current)) return;
      if (visibleInList(trigger.current!)) place();
      else panel.hidePopover();
    };
    document.addEventListener("scroll", follow, true);
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("scroll", follow, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    const shortcut = !["Control", "Alt", "Meta", "Shift"].includes(event.key) &&
      (event.ctrlKey || event.altKey || event.metaKey || /^F\d+$/u.test(event.key));
    if (shortcut || event.key === "Tab" || event.key === "Escape") {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); }
      menu.current?.hidePopover();
      trigger.current?.focus();
      return;
    }
    const items = [...event.currentTarget.querySelectorAll("button")];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = { ArrowDown: (at + 1) % items.length, ArrowUp: (at - 1 + items.length) % items.length,
      Home: 0, End: items.length - 1 }[event.key];
    if (next !== undefined) { event.preventDefault(); items[next]?.focus(); }
  };
  return <>
    <button ref={trigger} type="button" className={className} aria-label={label} aria-haspopup="menu"
      aria-expanded={open} aria-controls={id} popoverTarget={id} data-rail-tip={label} data-testid={testId}
      onKeyDown={event => {
        if (event.key === "ArrowDown") { event.preventDefault(); menu.current?.showPopover(); }
      }}>
      {icon}
    </button>
    <div ref={menu} id={id} popover="auto" className="rail-popover" role="menu" aria-label={label}
      onToggle={event => setOpen(event.newState === "open")} onKeyDown={keys}
      onBlur={event => {
        if (event.relatedTarget && event.relatedTarget !== trigger.current && !event.currentTarget.contains(event.relatedTarget)) {
          event.currentTarget.hidePopover();
        }
      }}>
      {choices.map(choice => (
        <button type="button" key={choice.id} className="rail-popover-item" tabIndex={-1}
          role={choice.checked === undefined ? "menuitem" : "menuitemradio"} aria-checked={choice.checked}
          data-testid={choice.testId}
          onClick={() => { menu.current?.hidePopover(); trigger.current?.focus(); choice.pick(); }}>
          {choice.icon}<span>{choice.name}</span>
          {choice.checked && <span className="rail-choice-check" aria-hidden="true">✓</span>}
        </button>
      ))}
    </div>
  </>;
}
