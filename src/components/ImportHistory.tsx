import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, type ImportBatch, type ImportSuggestion, type MatchSide } from "../lib/api";
import { formatDate } from "../lib/dates";
import { useAccounts } from "../lib/queries";
import { useUi } from "../lib/store";
import { useAction } from "../lib/useAction";
import { ErrorText, Modal } from "./Modal";
import { Money } from "./Money";

/** «19.10.2026, 14:05» из времени UTC в записи истории. */
function when(utc: string): string {
  const d = new Date(utc.endsWith("Z") ? utc : `${utc}Z`);
  if (Number.isNaN(d.getTime())) return utc;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}, ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Совпадения, ждущие подтверждения: их число для кнопок и карточки «Проверьте». */
export function useSuggestions() {
  return useQuery({ queryKey: ["importSuggestions"], queryFn: api.importSuggestions });
}

/** История импорта: что и когда загружено, отмена импорта целиком. */
export function ImportHistoryDialog({ onClose }: { onClose: () => void }) {
  const history = useQuery({ queryKey: ["importHistory"], queryFn: api.importHistory }).data;
  const pending = useSuggestions().data?.length ?? 0;
  const [matches, setMatches] = useState(false);
  const [confirm, setConfirm] = useState<ImportBatch | null>(null);
  const undo = useAction(api.importUndo, () => setConfirm(null));
  const showTransactions = useUi((s) => s.showTransactions);

  if (matches) return <MatchesDialog onClose={() => setMatches(false)} />;
  return (
    <Modal title="История импорта" onClose={onClose} wide>
      <p className="muted">Каждая загрузка выписки или CSV — вручную или из папки. Отмена импорта удаляет добавленные им операции; ваши записи, с которыми связались строки выписки, остаются как есть.</p>
      {pending > 0 && (
        <p className="warn" data-testid="history-pending">
          Ждут подтверждения совпадений: {pending}.{" "}
          <button className="link" onClick={() => setMatches(true)}>
            Разобрать
          </button>
        </p>
      )}
      {history && history.length === 0 && <p className="muted" data-testid="history-empty">Импортов пока не было.</p>}
      {history && history.length > 0 && (
        <div className="import-table">
          <table className="table" data-testid="import-history">
            <thead>
              <tr>
                <th>Когда</th>
                <th>Файл</th>
                <th className="num">Добавлено</th>
                <th className="num">Связано</th>
                <th className="num">Повторы</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {history.map((b) => (
                <tr key={b.id} data-testid="history-row" className={b.undoneAt ? "dup" : undefined}>
                  <td>
                    {when(b.createdAt)}
                    <div className="hint">{b.origin === "folder" ? "из папки" : "вручную"}</div>
                  </td>
                  <td>
                    {b.fileName}
                    {b.bank && <div className="hint">выписка {b.bank}</div>}
                  </td>
                  <td className="num">{b.added}</td>
                  <td className="num">{b.linked}</td>
                  <td className="num">{b.skipped}</td>
                  <td className="history-actions">
                    {b.undoneAt ? (
                      <span className="muted">отменён {when(b.undoneAt)}</span>
                    ) : (
                      <>
                        {b.present > 0 && (
                          <button className="link" onClick={() => (showTransactions({ importId: b.id }), onClose())}>
                            Операции
                          </button>
                        )}
                        <button className="link danger" data-testid="history-undo" onClick={() => setConfirm(b)}>
                          Отменить импорт
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {confirm && (
        <div className="confirm-box" data-testid="history-confirm">
          <p>
            Удалить операции этого импорта ({confirm.present})?
            {confirm.edited > 0 && ` Из них вы меняли после загрузки: ${confirm.edited} — они тоже удалятся.`} Вернуть можно сразу кнопкой «Отменить» (Ctrl+Z).
          </p>
          <ErrorText error={undo.error} />
          <div className="actions">
            <span className="spacer" />
            <button className="btn" onClick={() => setConfirm(null)}>
              Не отменять
            </button>
            <button className="btn danger" aria-busy={undo.busy} data-testid="history-undo-yes" onClick={() => undo.run(confirm.id)}>
              Отменить импорт
            </button>
          </div>
        </div>
      )}
      <div className="actions">
        <span className="spacer" />
        <button className="btn" onClick={onClose}>
          Закрыть
        </button>
      </div>
    </Modal>
  );
}

function SideView({ s, label }: { s: MatchSide; label: string }) {
  const symbol = useAccounts().data?.find((a) => a.id === s.accountId)?.currencySymbol;
  const what = s.type === "transfer" ? `Перевод → ${s.toAccount ?? ""}` : s.parts > 0 ? `Чек из ${s.parts} частей` : (s.category ?? "");
  return (
    <div className="match-side">
      <div className="hint">{label}</div>
      <div>
        <b>
          <Money amount={s.type === "income" ? s.amount : -s.amount} symbol={symbol} signed />
        </b>{" "}
        · {formatDate(s.date)} · {s.account}
      </div>
      <div>
        {what}
        {s.payee && <span className="muted"> · {s.payee}</span>}
      </div>
      {(s.note || s.tags > 0) && (
        <div className="hint">
          {s.note}
          {s.tags > 0 && ` · тегов: ${s.tags}`}
        </div>
      )}
    </div>
  );
}

/** Сомнительные совпадения: связать с записью, объединить в перевод или оставить отдельно. */
export function MatchesDialog({ onClose }: { onClose: () => void }) {
  const list = useSuggestions().data;
  const accept = useAction(api.importAccept);
  const reject = useAction(api.importReject);
  return (
    <Modal title="Совпадения с выпиской" onClose={onClose} wide>
      <p className="muted">Сами связываются только однозначные совпадения. Здесь — строки, где вариантов несколько или это, возможно, две стороны перевода между вашими счетами.</p>
      {list && list.length === 0 && (
        <p className="ok" data-testid="matches-empty">
          Всё разобрано.
        </p>
      )}
      <div className="match-list">
        {list?.map((m: ImportSuggestion) => (
          <div className="card match" key={m.id} data-testid="match" data-kind={m.kind}>
            <div className="match-pair">
              <SideView s={m.new} label="Строка выписки" />
              <SideView s={m.old} label={m.kind === "same" ? "Ваша запись" : m.old.imported ? "Другая выписка" : "Ваша запись"} />
            </div>
            <div className="actions">
              <span className="muted">{m.kind === "same" ? "Это одна и та же покупка?" : "Это перевод между своими счетами?"}</span>
              <span className="spacer" />
              <button className="btn" data-testid="match-reject" disabled={reject.busy} onClick={() => reject.run(m.id)}>
                Разные операции
              </button>
              <button className="btn primary" data-testid="match-accept" disabled={accept.busy} onClick={() => accept.run(m.id)}>
                {m.kind === "same" ? "Связать, оставить мою запись" : "Объединить в перевод"}
              </button>
            </div>
          </div>
        ))}
      </div>
      <ErrorText error={accept.error ?? reject.error} />
      <div className="actions">
        <span className="spacer" />
        <button className="btn" onClick={onClose}>
          Закрыть
        </button>
      </div>
    </Modal>
  );
}
