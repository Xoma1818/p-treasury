import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useUi } from "../lib/store";
import { Modal } from "./Modal";
import { OccurrenceItem } from "./Reminders";

/**
 * Окно «Пропущенные напоминания» при запуске и связь с фоном: планировщик
 * сообщает о наступивших напоминаниях, меню трея — о новой операции.
 */
export function MissedReminders() {
  const qc = useQueryClient();
  const openTxnForm = useUi((s) => s.openTxnForm);
  const [open, setOpen] = useState(true);
  // Список берётся один раз при запуске; дальше окно показывает его актуальное состояние.
  const missed = useQuery({ queryKey: ["reminders", "missed"], queryFn: api.missedReminders, staleTime: Infinity });
  const overview = useQuery({ queryKey: ["reminders"], queryFn: api.remindersOverview, enabled: open });

  useEffect(() => {
    const un = [
      listen("reminders-due", () => qc.invalidateQueries({ queryKey: ["reminders"] })),
      listen("tray-add-transaction", () => openTxnForm({ mode: "new", type: "expense" })),
      // Операция записана в окне быстрого ввода.
      listen("data-changed", () => qc.invalidateQueries()),
      // Импорт из папки добавил операции.
      listen("auto-import", () => qc.invalidateQueries()),
      // Фон прислал предупреждение о бюджете: полосы и карточки обновятся.
      listen("budget-alerts", () => qc.invalidateQueries({ queryKey: ["budget"] })),
    ];
    return () => un.forEach((p) => p.then((f) => f()));
  }, [qc, openTxnForm]);

  // Пропущенных при запуске нет — окно больше не показываем (новые придут уведомлением).
  useEffect(() => {
    if (missed.data && missed.data.length === 0) setOpen(false);
  }, [missed.data]);

  const keys = new Set((missed.data ?? []).map((o) => o.key.refId + o.key.scheduledAt));
  const items = (overview.data ? [...overview.data.overdue, ...overview.data.upcoming, ...overview.data.done] : missed.data ?? []).filter((o) =>
    keys.has(o.key.refId + o.key.scheduledAt),
  );
  if (!open || !missed.data || missed.data.length === 0) return null;
  return (
    <Modal title="Пропущенные напоминания" onClose={() => setOpen(false)} wide>
      <p className="muted">Пока приложение было закрыто, наступили эти напоминания.</p>
      <ul className="occ-list" data-testid="missed">
        {items.map((o) => (
          <OccurrenceItem key={o.key.refId + o.key.scheduledAt} o={o} />
        ))}
      </ul>
      <div className="actions">
        <span className="spacer" />
        <button className="btn primary" onClick={() => setOpen(false)}>
          Закрыть
        </button>
      </div>
    </Modal>
  );
}
