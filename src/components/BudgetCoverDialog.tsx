import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, type Budget, type BudgetLine } from "../lib/api";
import { useAction } from "../lib/useAction";
import { ErrorText, Modal } from "./Modal";
import { Money } from "./Money";
import { coverSources } from "../lib/budgetCover";
import { useBudget } from "../lib/queries";

export function BudgetCoverDialog({ budget, target, minor, onClose }: {
  budget: Budget; target: BudgetLine; minor: number; onClose: (outcome: "saved" | "cancelled") => void;
}) {
  const amount = -target.remaining;
  const latest = useBudget(budget.period.month).data ?? budget;
  const currentTarget = latest.lines.find((line) => line.categoryId === target.categoryId);
  const available = latest.id === budget.id && latest.currencyCode === budget.currencyCode &&
    latest.period.start === budget.period.start && latest.period.end === budget.period.end &&
    currentTarget?.canRebalance && currentTarget.baseLimit === target.baseLimit &&
    currentTarget.limit === target.limit && currentTarget.remaining === target.remaining;
  const sources = available ? coverSources(latest, currentTarget) : [];
  const [selected, select] = useState(() => sources[0]?.categoryId ?? "");
  const from = sources.find((l) => l.categoryId === selected);
  const queries = useQueryClient();
  const save = useAction(api.coverBudgetOverspend, () => onClose("saved"), { singleSubmit: true });
  const money = (value: number) => <Money amount={value} symbol={budget.currencySymbol} currencyCode={budget.currencyCode} minorUnits={minor} />;
  const close = () => {
    if (save.error) void queries.invalidateQueries({ queryKey: ["budget"] });
    onClose("cancelled");
  };
  return (
    <Modal title="Покрыть перерасход" onClose={close} dismissDisabled={save.busy}>
      {available ? <p>В категории «{target.categoryName}» потрачено сверх лимита {money(amount)}.</p> :
        <p role="status">План или расходы категории изменились. Откройте актуальный план ещё раз.</p>}
      {sources.length > 0 && <>
        <label className="field">Из категории
          <select autoFocus aria-label="Из категории" data-testid="cover-source" value={from ? selected : ""} onChange={(e) => select(e.target.value)} disabled={save.busy}>
            {!from && <option value="" disabled>Выберите другую категорию</option>}
            {sources.map((l) => <option key={l.categoryId} value={l.categoryId}>{l.categoryName}</option>)}
          </select>
        </label>
      </>}
      {from ? <>
        <table className="table"><caption className="sr-only">Изменение лимитов на месяц</caption>
          <thead><tr><th>Лимит</th><th className="num">Сейчас</th><th className="num">После</th></tr></thead>
          <tbody>
            <tr><td>{from.categoryName}</td><td className="num">{money(from.limit)}</td><td className="num">{money(from.limit - amount)}</td></tr>
            <tr><td>{target.categoryName}</td><td className="num">{money(target.limit)}</td><td className="num">{money(target.limit + amount)}</td></tr>
          </tbody>
        </table>
        <p className="hint">В категории «{from.categoryName}» останется {money(from.remaining - amount)} свободного лимита. Общий план месяца сохранится. Деньги на счетах останутся на месте.</p>
      </> : available && <p className="hint" role="status">{sources.length > 0 ? "Свободный лимит изменился. Выберите категорию для переноса." :
        <>Для покрытия нужна другая категория со свободным месячным лимитом не меньше {money(amount)}.</>}</p>}
      <ErrorText error={save.error} />
      <div className="actions">
        <button className="btn" autoFocus={!sources.length} onClick={close} disabled={save.busy}>{sources.length ? "Отмена" : "Закрыть"}</button>
        {from && <button type="button" className="btn primary" data-testid="cover-confirm" disabled={save.busy || !!save.error} aria-busy={save.busy}
          onClick={() => save.run({ month: budget.period.month, budgetId: budget.id!, from: from.categoryId, to: target.categoryId,
            amount, fromLimit: from.baseLimit, toLimit: target.baseLimit, fromRemaining: from.remaining })}>
          Перенести {money(amount)}
        </button>}
      </div>
    </Modal>
  );
}
