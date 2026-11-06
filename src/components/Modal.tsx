import { X } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";

/** Окно уходит так же мягко, как появилось (0.25): Esc, «×» и щелчок мимо окна
 *  сначала играют исчезновение, потом закрывают. Под автотестом — сразу.
 *  guardUnsaved: если в окне что-то вводили, Esc, «×» и щелчок мимо сначала
 *  спрашивают «Закрыть без сохранения?». Кнопка «Отмена» формы закрывает сразу. */
const CLOSE_MS = 160;
const FOCUSABLE = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [tabindex]';

/** `side` — панель справа во всю высоту окна (Р4), а не окно посередине. */
export function Modal({
  title,
  onClose,
  children,
  wide,
  side,
  guardUnsaved,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  side?: boolean;
  guardUnsaved?: boolean;
}) {
  const [closing, setClosing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [asking, setAsking] = useState(false);
  const timer = useRef(0);
  const box = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  // Блоки со своим сохранением (заметки) форму «грязной» не делают.
  const markDirty = (e: { target: EventTarget }) => {
    if (!(e.target instanceof Element && e.target.closest("[data-own-save]")))
      setDirty(true);
  };
  const dismiss = (force = false) => {
    if (guardUnsaved && dirty && !force) return setAsking(true);
    if (
      navigator.webdriver ||
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    )
      return close.current();
    if (timer.current) return;
    setClosing(true);
    timer.current = window.setTimeout(() => {
      // Если окно не закрылось (например, спросило подтверждение), возвращаем его как было.
      timer.current = 0;
      setClosing(false);
      close.current();
    }, CLOSE_MS);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEffect(() => {
    // Esc при вопросе возвращает к вводу: так случайное второе нажатие ничего не теряет.
    const onKey = (e: KeyboardEvent) =>
      e.key === "Escape" && (asking ? setAsking(false) : dismiss());
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  // Ловушка фокуса: Tab и Shift+Tab ходят по кругу внутри окна, а не уходят на страницу
  // под ним. WebView2 сам этого не делает (прогон Windows, window.test.mjs).
  const trapTab = (e: ReactKeyboardEvent) => {
    if (e.key !== "Tab" || !box.current) return;
    const items = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (el) => !el.hasAttribute("disabled") && el.tabIndex >= 0 && el.getClientRects().length > 0,
    );
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const at = document.activeElement;
    const inside = at instanceof Node && box.current.contains(at);
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
      className={["overlay", side && "side", closing && "closing"].filter(Boolean).join(" ")}
      onMouseDown={(e) => e.target === e.currentTarget && dismiss()}
    >
      <div
        className={["modal", wide && "wide", side && "side"].filter(Boolean).join(" ")}
        role="dialog"
        aria-modal="true"
        aria-label={title}
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
          >
            <X size={16} strokeWidth={1.75} aria-hidden="true" />
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
              onClick={() => setAsking(false)}
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
