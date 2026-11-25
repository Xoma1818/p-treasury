import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { api } from "../lib/api";
import { hotkeyList, isTyping } from "../lib/hotkeys";
import { currentBudgetGeneration, watchBudgetGeneration } from "../lib/uiPrefs";
import { useKeyMap } from "../lib/keymap";
import { useAmountPrivacyToggle, useSettings } from "../lib/queries";
import { Modal } from "./Modal";

type Direction = "undo" | "redo";
type Action = { kind: Direction; id: number };
type Msg = { text: string; action?: Action; error?: boolean };

/** После открытия другого бюджета предыдущие сообщения и ответы теряют смысл. */
export function UndoBar() {
  const budget = useSyncExternalStore(watchBudgetGeneration, currentBudgetGeneration);
  return budget === null ? null : <BudgetHistory key={budget} budget={budget} />;
}

function BudgetHistory({ budget }: { budget: number }) {
  const qc = useQueryClient();
  const history = useQuery({ queryKey: ["undoState", budget], queryFn: api.undoState });
  const [msg, setMsg] = useState<Msg | null>(null);
  const [pending, setPending] = useState<Direction | null>(null);
  const locked = useRef(false);
  const seen = useRef<number | null>(null);

  useEffect(() => {
    if (!history.data) return;
    const { undo, redo } = history.data;
    if (undo && seen.current !== null && undo.id > seen.current) {
      setMsg(current => current?.error ? current : { text: undo.label, action: { kind: "undo", id: undo.id } });
    }
    seen.current = Math.max(seen.current ?? 0, undo?.id ?? 0, redo?.id ?? 0);
  }, [history.data]);

  const run = async (kind: Direction, expectedId?: number) => {
    if (locked.current || currentBudgetGeneration() !== budget || document.querySelector("form[data-write-pending]")) return;
    locked.current = true;
    setPending(kind);
    let id = expectedId;
    try {
      // Для кнопки важен именно показанный шаг, для клавиши — вершина журнала.
      if (id === undefined) id = (await api.undoState())[kind]?.id;
      if (currentBudgetGeneration() !== budget) return;
      const label = id === undefined ? null : await api[kind](id);
      if (currentBudgetGeneration() !== budget) return;
      if (label === null || id === undefined) {
        setMsg({ text: kind === "undo" ? "Отменять нечего" : "Повторять нечего" });
      } else {
        setMsg({
          text: `${kind === "undo" ? "Отменено" : "Повторено"}: ${label}`,
          action: { kind: kind === "undo" ? "redo" : "undo", id },
        });
      }
    } catch (error) {
      if (currentBudgetGeneration() === budget) {
        setMsg({ text: String(error), error: true, action: id === undefined ? undefined : { kind, id } });
      }
    } finally {
      try {
        if (currentBudgetGeneration() === budget) await qc.invalidateQueries();
      } finally {
        locked.current = false;
        setPending(null);
      }
    }
  };
  const runRef = useRef(run);
  runRef.current = run;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || isTyping(e.target) || isTyping(document.activeElement)) return;
      const kind = e.code === "KeyZ" && !e.shiftKey ? "undo"
        : e.code === "KeyY" || (e.code === "KeyZ" && e.shiftKey) ? "redo" : null;
      if (!kind) return;
      e.preventDefault();
      if (!e.repeat) void runRef.current(kind);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const dismiss = useCallback(() => setMsg(null), []);
  if (!msg && !pending) return null;
  // При конфликте ядро может снять недоступный шаг. Повтор допустим лишь для того же ID.
  const action = msg?.action;
  const currentAction = action && (pending || (!history.isError && history.data?.[action.kind]?.id === action.id)) ? action : undefined;
  return <UndoNotice msg={msg} action={currentAction} pending={pending} run={run} dismiss={dismiss} />;
}

function UndoNotice({ msg, action, pending, run, dismiss }: {
  msg: Msg | null; action?: Action; pending: Direction | null;
  run: (kind: Direction, id: number) => void; dismiss: () => void;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const remaining = useRef(8000);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(() => !document.hidden && document.hasFocus());

  useEffect(() => {
    const activate = () => setActive(!document.hidden && document.hasFocus());
    const pause = () => setActive(false);
    window.addEventListener("focus", activate);
    window.addEventListener("blur", pause);
    document.addEventListener("visibilitychange", activate);
    return () => {
      window.removeEventListener("focus", activate);
      window.removeEventListener("blur", pause);
      document.removeEventListener("visibilitychange", activate);
    };
  }, []);
  useEffect(() => { remaining.current = 8000; }, [msg]);
  useEffect(() => {
    if (!msg || msg.error || pending || hovered || focused || !active) return;
    const started = performance.now();
    const timer = window.setTimeout(dismiss, remaining.current);
    return () => {
      window.clearTimeout(timer);
      remaining.current = Math.max(0, remaining.current - (performance.now() - started));
    };
  }, [msg, pending, hovered, focused, active, dismiss]);

  // Конфликт может убрать кнопку повтора, пока на ней стоял фокус.
  useLayoutEffect(() => {
    if (!action && focused && document.activeElement === document.body) closeButton.current?.focus({ preventScroll: true });
  }, [action, focused]);

  const close = () => {
    if (pending) return;
    if (bar.current?.contains(document.activeElement)) {
      const source = opener.current;
      if (source?.isConnected && !source.matches(":disabled") && source.getClientRects().length) {
        source.focus({ preventScroll: true });
      }
      if (document.activeElement !== source || !source) {
        const heading = document.querySelector<HTMLElement>("main h1");
        if (heading && !heading.hasAttribute("tabindex")) heading.tabIndex = -1;
        heading?.focus({ preventScroll: true });
      }
    }
    dismiss();
  };
  return (
    <div className={msg?.error ? "undo-bar error" : "undo-bar"} data-testid="undo-bar" ref={bar}
      onPointerEnter={event => { if (event.pointerType !== "touch") setHovered(true); }}
      onPointerLeave={() => setHovered(false)}
      onFocus={event => {
        if (event.relatedTarget instanceof HTMLElement && event.relatedTarget !== document.body &&
            !event.currentTarget.contains(event.relatedTarget)) opener.current = event.relatedTarget;
        setFocused(true);
      }}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
      <span role="status" aria-atomic="true">{pending ? pending === "undo" ? "Отменяем…" : "Повторяем…" : msg?.text}</span>
      {action && (
        <button className="link" aria-disabled={!!pending}
          aria-keyshortcuts={action.kind === "undo" ? "Control+Z" : "Control+Y Control+Shift+Z"}
          onKeyDown={event => {
            if (event.key === "Enter" && event.repeat) event.preventDefault();
          }}
          onClick={event => {
            if (event.detail <= 1) run(action.kind, action.id);
          }}>
          {msg?.error ? "Попробовать снова" : action.kind === "undo" ? "Отменить" : "Повторить"}
        </button>
      )}
      <button ref={closeButton} className="icon-btn" aria-label="Закрыть" aria-disabled={!!pending} onClick={close}>
        <X size={16} strokeWidth={1.75} aria-hidden="true" />
      </button>
    </div>
  );
}

/** Значок «Скрыть суммы» в нижнем ряду меню (Ctrl+H): глаз открыт — суммы видны, перечёркнут — скрыты. */
export function HideAmountsSwitch() {
  const settings = useSettings().data;
  const hidden = !settings || settings.hide_amounts === "1";
  const toggle = useAmountPrivacyToggle();
  const label = hidden ? "Показать суммы" : "Скрыть суммы";
  return (
    <button className="foot-btn" role="switch" disabled={!settings} aria-checked={hidden} aria-label="Скрыть суммы" data-rail-tip={label} data-testid="hide-amounts" onClick={toggle}>
      {hidden ? <EyeOff className="foot-icon" strokeWidth={1.75} aria-hidden="true" /> : <Eye className="foot-icon" strokeWidth={1.75} aria-hidden="true" />}
    </button>
  );
}

/** Справка по горячим клавишам (F1). */
export function HotkeysHelp({ onClose }: { onClose: () => void }) {
  const keyMap = useKeyMap();
  return (
    <Modal title="Горячие клавиши" onClose={onClose}>
      <table className="table compact hotkeys" data-testid="hotkeys">
        <tbody>
          {hotkeyList(keyMap).map(([keys, action]) => (
            <tr key={keys}>
              <td>
                <kbd>{keys}</kbd>
              </td>
              <td>{action}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}
