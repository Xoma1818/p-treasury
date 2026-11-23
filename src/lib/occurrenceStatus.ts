import type { Occurrence } from "./api";

/** Статус конкретного срабатывания. Срок платежа и время уведомления могут различаться. */
export function occurrenceStatus(o: Occurrence, now: string) {
  if (o.status === "dismissed") return { state: "dismissed", label: "напоминание скрыто" } as const;
  if (o.status === "done") {
    if (o.transactionId) return { state: "linked", label: "связано с операцией" } as const;
    const label = o.key.source === "reminder" && o.amount != null
      ? "отмечено выполненным"
      : "напоминание выполнено";
    return { state: "done", label } as const;
  }
  const late = o.dueDate ? o.dueDate < now.slice(0, 10) : o.payAt < now;
  if (o.status === "snoozed") {
    const label = late && o.amount != null ? "платёж просрочен · напоминание отложено" : "напоминание отложено";
    return { state: "snoozed", label } as const;
  }
  if (late) return { state: "overdue", label: o.amount != null ? "платёж просрочен" : "пора выполнить" } as const;
  return { state: "planned", label: o.amount != null ? "платёж запланирован" : "запланировано" } as const;
}
