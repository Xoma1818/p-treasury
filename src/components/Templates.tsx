import { useQuery } from "@tanstack/react-query";
import { api, type Template } from "../lib/api";
import { today } from "../lib/dates";
import { useUi } from "../lib/store";
import { useAction } from "../lib/useAction";
import { ErrorText } from "./Modal";
import { Money } from "./Money";
import { Hint } from "./Hint";

export const useTemplates = () => useQuery({ queryKey: ["templates"], queryFn: api.listTemplates });

/** Кнопки шаблонов: «Кофе 250 ₽». `onDelete` добавляет крестик удаления. */
export function TemplateButtons({ items, onPick, onDelete }: { items: Template[]; onPick: (t: Template) => void; onDelete?: (t: Template) => void }) {
  return (
    <div className="template-list">
      {items.map((t) => (
        <span key={t.id} className="template" data-testid="template" data-name={t.name}>
          <button type="button" className="template-main" onClick={() => onPick(t)} title={t.complete ? "Записать операцию сейчас" : "Открыть форму с этими данными"}>
            {t.name}
            {t.amount != null && <Money amount={t.amount} symbol={t.currencySymbol ?? "₽"} minorUnits={t.minorUnits} />}
          </button>
          {onDelete && (
            <button type="button" className="template-del" aria-label={`Удалить шаблон «${t.name}»`} onClick={() => onDelete(t)}>
              ×
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
  const openTxnForm = useUi((s) => s.openTxnForm);
  const apply = useAction((id: string) => api.applyTemplate(id, today()));
  const remove = useAction(api.deleteTemplate);
  const pick = (t: Template) => {
    if (t.complete) return apply.run(t.id);
    api.templateUsed(t.id);
    openTxnForm({ mode: "new", type: t.type, prefill: { amount: t.amount, accountId: t.accountId, toAccountId: t.toAccountId, categoryId: t.categoryId, payee: t.payee, note: t.note } });
  };
  return (
    <div className="card" data-testid="templates-card">
      <h2>
        Шаблоны
        <Hint of="templates" />
      </h2>
      {items.length === 0 ? (
        <p className="muted">Частые операции, например «Кофе 250 ₽», можно сохранить шаблоном в форме операции и записывать одним нажатием.</p>
      ) : (
        <TemplateButtons items={items} onPick={pick} onDelete={(t) => remove.run(t.id)} />
      )}
      <ErrorText error={apply.error ?? remove.error} />
    </div>
  );
}
