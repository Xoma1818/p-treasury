import { useQuery, useQueryClient } from "@tanstack/react-query";
import { EyeOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { api } from "../lib/api";
import { HOTKEYS, isTyping } from "../lib/hotkeys";
import { useSettings } from "../lib/queries";
import { useAction } from "../lib/useAction";
import { Modal } from "./Modal";

type Msg = { text: string; next?: "undo" | "redo"; error?: boolean };

/**
 * Плашка отмены: после каждого действия с данными — «Удаление операции · Отменить».
 * Ctrl+Z отменяет, Ctrl+Y (или Ctrl+Shift+Z) повторяет.
 */
export function UndoBar() {
  const qc = useQueryClient();
  const state = useQuery({ queryKey: ["undoState"], queryFn: api.undoState }).data;
  const [msg, setMsg] = useState<Msg | null>(null);
  const seen = useRef<number | null>(null);

  // Новый шаг журнала (его номер больше всех виденных) — показать плашку.
  const top = state?.undo;
  useEffect(() => {
    if (!state) return;
    const id = top?.id ?? 0;
    if (seen.current !== null && top && id > seen.current) setMsg({ text: top.label, next: "undo" });
    seen.current = Math.max(seen.current ?? 0, id);
  }, [state, top]);

  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 8000);
    return () => clearTimeout(t);
  }, [msg]);

  const run = async (kind: "undo" | "redo") => {
    try {
      const label = await (kind === "undo" ? api.undo() : api.redo());
      if (!label) setMsg({ text: kind === "undo" ? "Отменять нечего" : "Повторять нечего" });
      else setMsg({ text: `${kind === "undo" ? "Отменено" : "Повторено"}: ${label}`, next: kind === "undo" ? "redo" : "undo" });
    } catch (e) {
      setMsg({ text: String(e), error: true });
    }
    await qc.invalidateQueries();
  };
  const runRef = useRef(run);
  runRef.current = run;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || isTyping(e.target) || isTyping(document.activeElement)) return;
      if (e.code === "KeyZ" && !e.shiftKey) {
        e.preventDefault();
        runRef.current("undo");
      } else if (e.code === "KeyY" || (e.code === "KeyZ" && e.shiftKey)) {
        e.preventDefault();
        runRef.current("redo");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!msg) return null;
  return (
    <div className={msg.error ? "undo-bar error" : "undo-bar"} role="status" data-testid="undo-bar">
      <span>{msg.text}</span>
      {msg.next === "undo" && (
        <button className="link" onClick={() => run("undo")} title="Ctrl+Z">
          Отменить
        </button>
      )}
      {msg.next === "redo" && (
        <button className="link" onClick={() => run("redo")} title="Ctrl+Y">
          Повторить
        </button>
      )}
      <button className="icon-btn" aria-label="Закрыть" onClick={() => setMsg(null)}>
        <X size={16} strokeWidth={1.75} aria-hidden="true" />
      </button>
    </div>
  );
}

/** Кнопка «Скрыть суммы» / «Показать суммы» (Ctrl+H). */
export function HideAmountsButton({ className = "link" }: { className?: string }) {
  const hidden = useSettings().data?.hide_amounts === "1";
  const toggle = useAction(api.setSetting);
  return (
    <button className={className} data-testid="hide-amounts" aria-pressed={hidden} onClick={() => toggle.run("hide_amounts", hidden ? "0" : "1")} title="Ctrl+H">
      {hidden ? "Показать суммы" : "Скрыть суммы"}
    </button>
  );
}

/** Переключатель «Скрыть суммы» внизу меню (Ctrl+H). */
export function HideAmountsSwitch() {
  const hidden = useSettings().data?.hide_amounts === "1";
  const toggle = useAction(api.setSetting);
  return (
    <button className="foot-row" role="switch" aria-checked={hidden} data-testid="hide-amounts" onClick={() => toggle.run("hide_amounts", hidden ? "0" : "1")} title="Ctrl+H">
      <EyeOff className="foot-icon" strokeWidth={1.75} aria-hidden="true" />
      <span className="foot-label">Скрыть суммы</span>
      <span className="switch" aria-hidden="true" />
    </button>
  );
}

/** Справка по горячим клавишам (F1). */
export function HotkeysHelp({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Горячие клавиши" onClose={onClose}>
      <table className="table compact hotkeys" data-testid="hotkeys">
        <tbody>
          {HOTKEYS.map(([keys, action]) => (
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
