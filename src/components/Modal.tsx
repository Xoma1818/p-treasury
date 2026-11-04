import { X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

/** Окно уходит так же мягко, как появилось (0.25): Esc, «×» и щелчок мимо окна
 *  сначала играют исчезновение, потом закрывают. Под автотестом — сразу.
 *  guardUnsaved: если в окне что-то вводили, Esc, «×» и щелчок мимо сначала
 *  спрашивают «Закрыть без сохранения?». Кнопка «Отмена» формы закрывает сразу. */
const CLOSE_MS = 160;

export function Modal({
  title,
  onClose,
  children,
  wide,
  guardUnsaved,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  guardUnsaved?: boolean;
}) {
  const [closing, setClosing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [asking, setAsking] = useState(false);
  const timer = useRef(0);
  const close = useRef(onClose);
  close.current = onClose;
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
  return (
    <div
      className={closing ? "overlay closing" : "overlay"}
      onMouseDown={(e) => e.target === e.currentTarget && dismiss()}
    >
      <div
        className={wide ? "modal wide" : "modal"}
        role="dialog"
        aria-label={title}
        onInputCapture={guardUnsaved ? () => setDirty(true) : undefined}
        onChangeCapture={guardUnsaved ? () => setDirty(true) : undefined}
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
