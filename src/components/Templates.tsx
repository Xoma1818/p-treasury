import { useMutation, useMutationState, useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { api, type Template } from "../lib/api";
import { today } from "../lib/dates";
import { useUi } from "../lib/store";
import { useAction } from "../lib/useAction";
import { ErrorText } from "./Modal";
import { Money } from "./Money";
import { Hint } from "./Hint";
import { PendingStatus } from "./PendingStatus";

export const useTemplates = () => useQuery({ queryKey: ["templates"], queryFn: api.listTemplates });

// Обе точки записи (Главная и Операции) видят один выполняющийся запрос по шаблону.
const applyKey = ["applyTemplate"] as const;
export function useTemplatePick(items: Template[]) {
  const client = useQueryClient();
  const openTxnForm = useUi((s) => s.openTxnForm);
  const attempts = useMutationState({
    filters: { mutationKey: applyKey },
    select: ({ state }) => ({ id: state.variables, status: state.status, error: state.error }),
  });
  const latest = new Map(attempts.map(a => [a.id, a]));
  const pending = items.filter(t => latest.get(t.id)?.status === "pending");
  const errors = items.flatMap(t => {
    const attempt = latest.get(t.id);
    return attempt?.status === "error" ? [`Шаблон «${t.name}»: ${String(attempt.error)}`] : [];
  });
  const apply = useMutation({
    mutationKey: applyKey,
    mutationFn: (id: string) => api.applyTemplate(id, today()),
    onSuccess: () => client.invalidateQueries(),
  });
  const noteUse = useMutation({ mutationFn: api.templateUsed });
  const pick = (t: Template) => {
    if (t.complete) {
      // Состояние запроса уже обновилось даже между двумя кликами до отрисовки кнопки.
      if (!client.isMutating({ mutationKey: applyKey, predicate: (m) => m.state.variables === t.id })) {
        apply.mutate(t.id);
      }
      return;
    }
    noteUse.mutate(t.id);
    openTxnForm({ mode: "new", type: t.type, prefill: { amount: t.amount, accountId: t.accountId, toAccountId: t.toAccountId, categoryId: t.categoryId, payee: t.payee, note: t.note } });
  };
  if (noteUse.error) errors.push(String(noteUse.error));
  return { pick, busy: pending.length > 0, isApplying: (id: string) => latest.get(id)?.status === "pending",
    error: errors.length ? errors.join(" · ") : null };
}

/** Кнопки шаблонов: «Кофе 250 ₽». `onDelete` добавляет крестик удаления. */
export function TemplateButtons({ items, onPick, onDelete, isApplying }: { items: Template[]; onPick: (t: Template) => void; onDelete?: (t: Template) => void; isApplying?: (id: string) => boolean }) {
  return (
    <div className="template-list">
      {items.map((t) => (
        <span key={t.id} className="template" data-testid="template" data-name={t.name}>
          <button type="button" className="template-main" disabled={isApplying?.(t.id)} aria-busy={isApplying?.(t.id) || undefined}
            onClick={() => onPick(t)} title={isApplying && t.complete ? "Записать операцию сейчас" : "Заполнить форму этими данными"}>
            {t.name}
            {t.amount != null && <Money amount={t.amount} symbol={t.currencySymbol ?? "₽"} minorUnits={t.minorUnits} />}
          </button>
          {onDelete && (
            <button type="button" className="template-del" disabled={isApplying?.(t.id)} aria-label={`Удалить шаблон «${t.name}»`} onClick={() => onDelete(t)}>
              <X size={16} strokeWidth={1.75} aria-hidden="true" />
            </button>
          )}
        </span>
      ))}
    </div>
  );
}

/** Карточка «Шаблоны» на Главной: полный шаблон записывает операцию одним нажатием. */
export function TemplatesCard() {
  const items = useTemplates().data ?? [];
  const apply = useTemplatePick(items);
  const remove = useAction(api.deleteTemplate);
  return (
    <div className="card" data-testid="templates-card">
      <h2>
        Шаблоны
        <Hint of="templates" />
      </h2>
      {items.length === 0 ? (
        <p className="muted">Частые операции, например «Кофе 250 ₽», можно сохранить шаблоном в форме операции и записывать одним нажатием.</p>
      ) : (
        <TemplateButtons items={items} onPick={apply.pick} isApplying={apply.isApplying} onDelete={(t) => remove.run(t.id)} />
      )}
      <PendingStatus busy={apply.busy}>Записываем операцию по шаблону…</PendingStatus>
      <ErrorText error={apply.error ?? remove.error} />
    </div>
  );
}
