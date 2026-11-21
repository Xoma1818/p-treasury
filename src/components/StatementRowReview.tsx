import { useEffect, useRef, useState } from "react";
import type { BankImportDecision, ImportRow, MatchSide } from "../lib/api";
import { formatDate } from "../lib/dates";
import { HIDDEN_AMOUNT } from "../lib/money";
import { useCurrencies } from "../lib/queries";
import { Modal } from "./Modal";
import { Money } from "./Money";

interface Props {
  row: ImportRow;
  currencySymbol?: string;
  matches: MatchSide[];
  bank: boolean;
  showAmounts: boolean;
  used: Set<string>;
  initial?: BankImportDecision;
  hasNext: boolean;
  onBack: () => void;
  onAccept: (decision: BankImportDecision) => void;
}

export function StatementRowReview({ row, currencySymbol, matches, bank, showAmounts, used, initial, hasNext, onBack, onAccept }: Props) {
  const [decision, setDecision] = useState(initial);
  const currencies = useCurrencies().data;
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  const sign = row.type === "Расход" ? "−" : row.type === "Доход" ? "+" : "";
  const amount = sign ? sign + row.amount.replace(/^[+−-]/, "") : row.amount;
  const balanceChange = sign && currencySymbol && !row.toTransfer
    ? ` Изменение остатка: ${showAmounts ? `${amount} ${currencySymbol}` : HIDDEN_AMOUNT}.`
    : "";

  return (
    <Modal title="Разбор строки выписки" wide onClose={onBack}>
      <div className="statement-review">
        <header className="statement-review-entry">
          <div>
            <span className="muted small">Строка {row.line} · {row.type}</span>
            <h3 ref={heading} tabIndex={-1}>{row.payee || row.category || row.type}</h3>
            <div>{formatDate(row.date)} · {row.account}</div>
            {showAmounts && row.sourceNote && <div className="hint">{row.sourceNote}</div>}
          </div>
          <strong className="statement-review-amount">{showAmounts ? `${amount} ${currencySymbol ?? ""}`.trim() : HIDDEN_AMOUNT}</strong>
        </header>
        <fieldset>
          <legend>Как учесть строку?</legend>
          <p className="hint">{bank ? "Совпали счёт и сумма операции или её стороны. Сравните даты и получателей." : "Совпали счёт, дата и сумма."}</p>
          {matches.map((s, index) => {
            const currency = currencies?.find((c) => c.code === s.currency);
            const taken = used.has(s.id);
            return (
              <label className="statement-review-option" key={s.id}>
                {bank && <input type="radio" name="statement-choice" value={`link:${s.id}`}
                  checked={decision?.action === "link" && decision.transactionId === s.id} disabled={taken}
                  onChange={() => setDecision({ action: "link", transactionId: s.id })} />}
                <span className="statement-review-description">
                  <strong>{bank ? `Связать с записью ${index + 1}` : `Запись ${index + 1}`} · {s.payee || s.category || s.account}</strong>
                  <span>{formatDate(s.date)} · {s.account}{s.toAccount && ` → ${s.toAccount}`}</span>
                  {s.category && <span className="hint">{s.category}</span>}
                  {showAmounts && s.note && <span className="hint">{s.note}</span>}
                  {s.parts > 0 && <span className="hint">Частей чека: {s.parts}</span>}
                  {taken && <span className="hint">Уже выбрано для другой строки</span>}
                </span>
                <span className="statement-review-amount">{s.type === "transfer" && <span className="hint">Списание · {s.account} </span>}{showAmounts
                  ? <Money amount={s.type === "income" ? s.amount : -s.amount} symbol={currency?.symbol ?? s.currency} minorUnits={currency?.minorUnits} signed />
                  : HIDDEN_AMOUNT}</span>
              </label>
            );
          })}
          {row.maybe > matches.length && <p className="hint">Показаны ближайшие варианты. Если нужной записи здесь нет, строку можно пропустить.</p>}
          <label className="statement-review-option">
            <input type="radio" name="statement-choice" value="add" checked={decision?.action === "add"} onChange={() => setDecision({ action: "add" })} />
            <span>Добавить отдельную операцию</span>
          </label>
          <label className="statement-review-option">
            <input type="radio" name="statement-choice" value="skip" checked={decision?.action === "skip"} onChange={() => setDecision({ action: "skip" })} />
            <span>Пропустить в этой загрузке</span>
          </label>
        </fieldset>
        {decision && <p className="hint" role="status">{decision.action === "add"
          ? `По этой строке будет добавлена одна операция.${balanceChange}`
          : decision.action === "link" ? "Строка подтвердит проведённую операцию. Остаток сохранится." : "Эта строка не изменит учёт."}</p>}
        <div className="actions">
          <button type="button" className="btn" onClick={onBack}>Назад</button>
          <button type="button" className="btn primary" disabled={!decision} onClick={() => decision && onAccept(decision)}>
            {hasNext ? "К следующей строке" : "К итогу"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
