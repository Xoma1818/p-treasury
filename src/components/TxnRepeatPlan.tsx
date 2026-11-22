import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, TXN_TYPES, type Reminder, type Txn } from "../lib/api";
import { nextRepeatDate } from "../lib/dates";
import { ErrorText, Modal } from "./Modal";
import { ReminderForm } from "./Reminders";

export function canPlanRepeat(txn: Txn): boolean {
  return (txn.type === "income" || txn.type === "expense")
    && !txn.refund && !txn.splitId && !txn.debtId && !txn.spreadMonths && !txn.eventId;
}

export function useRepeatPlan(sourceId?: string) {
  return useQuery({
    queryKey: ["repeatPlan", sourceId],
    queryFn: () => api.getRepeatPlan(sourceId!),
    enabled: !!sourceId,
    retry: false,
    refetchOnMount: "always",
  });
}

export function RepeatPlanDialog({ source, onClose }: { source: Txn; onClose: () => void }) {
  // После сохранения список обновится. Выбранный режим формы держим до её закрытия.
  const [existing, setExisting] = useState<Reminder | null>();
  const plan = useRepeatPlan(existing === undefined ? source.id : undefined);
  useEffect(() => {
    if (!plan.isFetching && !plan.error && plan.data !== undefined) setExisting(plan.data);
  }, [plan.isFetching, plan.error, plan.data]);

  if (existing === undefined) {
    return <Modal title="Запланировать повтор" onClose={onClose}>
      {plan.error ? <ErrorText error={String(plan.error)} /> : <p role="status">Проверяем операцию…</p>}
      <div className="actions"><button type="button" className="btn" autoFocus onClick={onClose}>Закрыть</button></div>
    </Modal>;
  }
  if (existing) return <ReminderForm reminder={existing} onClose={onClose} />;
  return <ReminderForm source={source} onClose={onClose} preset={{
    title: source.payee?.trim() || source.categoryName || TXN_TYPES[source.type],
    repeat: "monthly",
    startAt: nextRepeatDate(source.date, "monthly") + "T09:00",
    amount: source.amount,
    accountId: source.accountId,
    categoryId: source.categoryId,
    txnType: source.type === "income" ? "income" : "expense",
  }} />;
}
