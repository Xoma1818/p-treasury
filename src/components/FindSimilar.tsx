import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, type Txn, type TxnFilter } from "../lib/api";
import { formatMoney } from "../lib/money";
import { useUi } from "../lib/store";
import { useAction } from "../lib/useAction";
import { ErrorText } from "./Modal";
import { Modal } from "./Modal";
import { TxnTable } from "./TxnTable";

type By = "payee" | "amount";

/** Р5 «Найти похожие» из меню операции: тот же получатель или та же сумма.
 *  Отсюда — весь список в «Операциях», правило категории для получателя или шаблон. */
export function FindSimilar({ txn, onClose }: { txn: Txn; onClose: () => void }) {
  const showTransactions = useUi((s) => s.showTransactions);
  const [by, setBy] = useState<By>(txn.payee ? "payee" : "amount");
  const filter: TxnFilter =
    by === "payee" ? { payee: txn.payee ?? "" } : { amount: Math.abs(txn.amount), currency: txn.currencyCode };
  const q = useQuery({
    queryKey: ["transactions", "find-similar", filter],
    queryFn: () => api.listTransactions({ ...filter, limit: 8 }),
  });
  const canRule = !!txn.payee && !!txn.categoryId && (txn.type === "expense" || txn.type === "income");
  const canTemplate = txn.type === "expense" || txn.type === "income" || txn.type === "transfer";
  const [ruleDone, setRuleDone] = useState(false);
  const [templateDone, setTemplateDone] = useState<string | null>(null);
  const rule = useAction(
    () => api.createRule({ pattern: txn.payee!.trim(), categoryId: txn.categoryId!, payee: null }),
    () => setRuleDone(true),
  );
  const name = (txn.payee ?? txn.categoryName ?? "Операция").trim().slice(0, 60);
  const template = useAction(
    () =>
      api.createTemplate({
        name,
        type: txn.type as "expense" | "income" | "transfer",
        amount: Math.abs(txn.amount),
        accountId: txn.accountId,
        toAccountId: txn.toAccountId,
        categoryId: txn.categoryId,
        payee: txn.payee,
        note: null,
      }),
    () => setTemplateDone(name),
  );
  const total = q.data?.total ?? 0;
  const amountText = formatMoney(Math.abs(txn.amount), txn.currencySymbol, txn.minorUnits);
  return (
    <Modal title="Похожие операции" onClose={onClose} wide>
      <div className="tabs small" role="group" aria-label="Похожие по" data-testid="similar-by">
        <button type="button" className={by === "payee" ? "tab active" : "tab"} aria-pressed={by === "payee"} disabled={!txn.payee} onClick={() => setBy("payee")} data-testid="similar-by-payee">
          {txn.payee ? `Получатель «${txn.payee}»` : "Получатель не указан"}
        </button>
        <button type="button" className={by === "amount" ? "tab active" : "tab"} aria-pressed={by === "amount"} onClick={() => setBy("amount")} data-testid="similar-by-amount">
          Сумма {amountText}
        </button>
      </div>
      {q.error && <p className="error">{String(q.error)}</p>}
      {q.data && (
        <>
          <p className="muted" data-testid="similar-count">
            Найдено: {total}
            {total > q.data.items.length ? `, показаны последние ${q.data.items.length}` : ""}
          </p>
          <TxnTable items={q.data.items} compact />
        </>
      )}
      <div className="actions">
        <button
          type="button"
          className="btn"
          data-testid="similar-show-all"
          onClick={() => {
            onClose();
            showTransactions(filter);
          }}
        >
          Все в «Операциях»
        </button>
        {canRule && (
          <button type="button" className="btn" data-testid="similar-make-rule" disabled={rule.busy || ruleDone} onClick={() => rule.run()} title="Новые операции с этим получателем сразу попадут в эту категорию">
            {ruleDone ? "Правило сохранено" : `Правило: «${txn.payee}» → ${txn.categoryName ?? "категория"}`}
          </button>
        )}
        {canTemplate && (
          <button type="button" className="btn" data-testid="similar-make-template" disabled={template.busy || !!templateDone} onClick={() => template.run()} title="Шаблон с этим получателем, суммой и счётом">
            {templateDone ? `Шаблон «${templateDone}» сохранён` : "Сделать шаблон"}
          </button>
        )}
      </div>
      <ErrorText error={rule.error ?? template.error} />
    </Modal>
  );
}
