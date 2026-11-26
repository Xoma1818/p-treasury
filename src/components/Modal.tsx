import { X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { DecorativeIcon } from "./DecorativeIcon";

const FOCUSABLE = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [tabindex]';
const DIALOG = '[role="dialog"][aria-modal="true"]';

function tabStops(dialog: HTMLElement) {
  return [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => !el.matches(":disabled") && el.tabIndex >= 0 && el.getClientRects().length > 0,
  );
}

// Уходить может только пустая подложка: данные и фокус покидают диалог сразу.
function fadeBackdrop(side: boolean) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const veil = document.createElement("div");
  veil.className = side ? "modal-veil leaving side" : "modal-veil leaving";
  veil.setAttribute("aria-hidden", "true");
  document.body.appendChild(veil);
  const animation = veil.getAnimations()[0];
  if (animation) void animation.finished.then(() => veil.remove(), () => veil.remove());
  else veil.remove();
}

/** `side` — панель справа во всю высоту окна (Р4), а не окно посередине. */
export function Modal({
  title,
  onClose,
  children,
  wide,
  side,
  guardUnsaved,
  dismissDisabled = false,
  focusClose = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  side?: boolean;
  guardUnsaved?: boolean;
  dismissDisabled?: boolean;
  focusClose?: boolean;
}) {
  const [dirty, setDirty] = useState(false);
  const [asking, setAsking] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const [opener] = useState(() => document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const askedFrom = useRef<HTMLElement | null>(null);
  const resumeEditing = () => {
    setAsking(false);
    if (askedFrom.current?.isConnected) askedFrom.current.focus({ preventScroll: true });
  };
  // Блоки со своим сохранением (заметки) форму «грязной» не делают.
  const markDirty = (e: { target: EventTarget }) => {
    if (!(e.target instanceof Element && e.target.closest("[data-own-save]")))
      setDirty(true);
  };
  const dismiss = (force = false) => {
    if (dismissDisabled) return;
    if (guardUnsaved && dirty && !force) {
      if (!asking) askedFrom.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setAsking(true);
      return;
    }
    onClose();
  };
  useLayoutEffect(() => {
    const dialog = box.current;
    if (!dialog) return;
    if (!dialog.contains(document.activeElement)) (tabStops(dialog)[0] ?? dialog).focus({ preventScroll: true });
    return () => queueMicrotask(() => {
      // React StrictMode повторяет эффект без удаления окна.
      if (dialog.isConnected) return;
      const remaining = document.querySelectorAll<HTMLElement>(DIALOG);
      const top = remaining[remaining.length - 1];
      if (document.activeElement === document.body) {
        const target = opener?.isConnected && opener !== document.body && !opener.matches(":disabled") &&
          opener.getClientRects().length && (!top || top.contains(opener)) ? opener : null;
        (target ?? top ?? document.querySelector<HTMLElement>('.app-nav [aria-current="page"]'))?.focus({ preventScroll: true });
      }
      if (!top) fadeBackdrop(!!side);
    });
  }, [opener, side]);
  // Если последняя кнопка отключилась во время записи, браузер может вернуть
  // фокус на body. До следующего Tab переносим его на само верхнее окно.
  useLayoutEffect(() => {
    const dialog = box.current;
    if (!dismissDisabled || !dialog || tabStops(dialog).length > 0) return;
    const dialogs = document.querySelectorAll(DIALOG);
    if (dialogs[dialogs.length - 1] === dialog) dialog.focus({ preventScroll: true });
  }, [dismissDisabled]);
  useEffect(() => {
    // Esc при вопросе возвращает к вводу: так случайное второе нажатие ничего не теряет.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const dialogs = document.querySelectorAll(DIALOG);
      if (dialogs[dialogs.length - 1] !== box.current) return;
      e.preventDefault();
      if (e.repeat || e.isComposing) return;
      if (asking) resumeEditing();
      else dismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  // Ловушка фокуса: Tab и Shift+Tab ходят по кругу внутри окна, а не уходят на страницу
  // под ним. WebView2 сам этого не делает (прогон Windows, window.test.mjs).
  const trapTab = (e: ReactKeyboardEvent) => {
    if (e.key !== "Tab" || !box.current) return;
    if (e.target instanceof Element && e.target.closest('[role="dialog"]') !== box.current) return;
    const scope = asking ? box.current.querySelector<HTMLElement>('[role="alertdialog"]') : box.current;
    const items = tabStops(scope ?? box.current);
    if (items.length === 0) {
      e.preventDefault();
      box.current.focus({ preventScroll: true });
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const at = document.activeElement;
    const inside = at !== scope && at instanceof Node && scope?.contains(at);
    if (e.shiftKey && (at === first || !inside)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (at === last || !inside)) {
      e.preventDefault();
      first.focus();
    }
  };
  return (
    <div
      className={side ? "overlay side" : "overlay"}
      onMouseDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (dismissDisabled) e.preventDefault();
        else dismiss();
      }}
    >
      <div
        className={["modal", wide && "wide", side && "side"].filter(Boolean).join(" ")}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={box}
        onKeyDown={trapTab}
        data-side={side || undefined}
        onInputCapture={guardUnsaved ? markDirty : undefined}
        onChangeCapture={guardUnsaved ? markDirty : undefined}
      >
        <div className="modal-head">
          <h2>{title}</h2>
          <button
            className="icon-btn"
            onClick={() => dismiss()}
            aria-label="Закрыть"
            autoFocus={focusClose}
            disabled={dismissDisabled}
          >
            <DecorativeIcon icon={X} size="control" />
          </button>
        </div>
        {asking && (
          <div
            className="modal-ask"
            role="alertdialog"
            aria-label="Закрыть без сохранения?"
            data-testid="unsaved-ask"
          >
            <span>Закрыть без сохранения? Введённое пропадёт.</span>
            <button
              type="button"
              className="btn small"
              autoFocus
              onClick={resumeEditing}
            >
              Продолжить ввод
            </button>
            <button
              type="button"
              className="btn small danger"
              onClick={() => {
                setAsking(false);
                dismiss(true);
              }}
            >
              Закрыть
            </button>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

export function ErrorText({ error }: { error: string | null }) {
  return error ? (
    <p className="error" role="alert">
      {error}
    </p>
  ) : null;
}
