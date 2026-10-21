import { useEffect, useRef, useState } from "react";
import { api, TXN_TYPES, type QuickDraft } from "../lib/api";
import { formatDate } from "../lib/dates";
import { amountToInput, parseAmount } from "../lib/money";
import { useAccounts, useCategories } from "../lib/queries";
import { useUi } from "../lib/store";
import { useAction } from "../lib/useAction";
import { AccountSelect, AmountInput, CategorySelect } from "./Fields";
import { ErrorText } from "./Modal";

/**
 * Ввод одной строкой: «пятёрочка 1250 карта» или вставленный текст SMS банка.
 * Черновик разбирается на лету и показывается рядом; Enter записывает операцию.
 * Используется на Главной и в маленьком окне быстрого ввода (Ctrl+Alt+P).
 */
export function QuickEntry({ autoFocus, inWindow, onSaved }: { autoFocus?: boolean; inWindow?: boolean; onSaved?: () => void }) {
  const accounts = useAccounts().data ?? [];
  const categories = useCategories().data ?? [];
  const openTxnForm = useUi((s) => s.openTxnForm);
  const [text, setText] = useState("");
  const [draft, setDraft] = useState<QuickDraft | null>(null);
  const [amount, setAmount] = useState("");
  const [remember, setRemember] = useState(true);
  const [saved, setSaved] = useState<string | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  const account = accounts.find((a) => a.id === draft?.accountId);
  const minor = account?.minorUnits ?? 2;

  // Разбор на лету: черновик обновляется, пока пользователь печатает.
  useEffect(() => {
    if (!text.trim()) {
      setDraft(null);
      return;
    }
    const t = setTimeout(
      () =>
        api
          .quickParse(text)
          .then((d) => {
            setParseError(null);
            setDraft(d);
            setAmount(d.amount != null ? amountToInput(d.amount, accounts.find((a) => a.id === d.accountId)?.minorUnits ?? 2) : "");
          })
          .catch((e) => setParseError(String(e))),
      180,
    );
    return () => clearTimeout(t);
    // accounts нужен только для знаков после запятой.
  }, [text]);

  const amountValue = parseAmount(amount, minor);
  const transfer = draft?.type === "transfer";
  const ready = !!draft && amountValue != null && amountValue > 0 && !!draft.accountId && (transfer ? !!draft.toAccountId : !!draft.categoryId);
  const canRemember = !!draft && !transfer && !!draft.merchant && !draft.ruleId && !!draft.categoryId;
  const patch = (p: Partial<QuickDraft>) => draft && setDraft({ ...draft, ...p });

  const save = useAction(
    async () => {
      if (!draft || !ready) return null;
      const id = await api.createTransaction({
        type: draft.type,
        date: draft.date,
        accountId: draft.accountId!,
        amount: amountValue!,
        categoryId: transfer ? null : draft.categoryId,
        toAccountId: transfer ? draft.toAccountId : null,
        toAmount: null,
        payee: draft.payee,
        note: null,
      });
      if (canRemember && remember) await api.rememberRule(draft.merchant!, draft.categoryId!, draft.payee);
      return id;
    },
    (id) => {
      if (!id) return;
      const what = draft?.payee || categories.find((c) => c.id === draft?.categoryId)?.name || TXN_TYPES[draft!.type];
      setSaved(`Записано: ${what}, ${amount}`);
      setText("");
      setDraft(null);
      setAmount("");
      input.current?.focus();
      onSaved?.();
    },
  );

  const more = () => {
    if (!draft) return;
    openTxnForm({
      mode: "new",
      type: draft.type,
      date: draft.date,
      prefill: {
        amount: amountValue,
        accountId: draft.accountId,
        toAccountId: draft.toAccountId,
        categoryId: draft.categoryId,
        payee: draft.payee,
      },
    });
    setText("");
  };

  return (
    <div className="quick-entry" data-testid="quick-entry">
      <textarea
        ref={input}
        name="quickText"
        rows={1}
        autoFocus={autoFocus}
        placeholder="Быстрый ввод: «пятёрочка 1250 карта», «+85000 зарплата» или вставьте SMS банка"
        value={text}
        onChange={(e) => {
          setSaved(null);
          setText(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (ready) save.run();
            else if (draft && !inWindow) more();
          }
        }}
      />
      {saved && !draft && (
        <p className="ok" data-testid="quick-saved">
          {saved}.{!inWindow && " Ctrl+Z отменит."}
        </p>
      )}
      {draft && (
        <div className="quick-draft" data-testid="quick-draft">
          <span className={`quick-kind ${draft.type}`}>{TXN_TYPES[draft.type]}</span>
          {draft.source === "sms" && <span className="quick-kind transfer" data-testid="quick-sms">из SMS</span>}
          <AmountInput name="quickAmount" value={amount} onChange={setAmount} minorUnits={minor} />
          <AccountSelect name="quickAccount" accounts={accounts} value={draft.accountId ?? ""} onChange={(v) => patch({ accountId: v || null })} />
          {transfer ? (
            <AccountSelect
              name="quickToAccount"
              accounts={accounts}
              value={draft.toAccountId ?? ""}
              exclude={draft.accountId ?? undefined}
              placeholder="Куда"
              onChange={(v) => patch({ toAccountId: v || null })}
            />
          ) : (
            <CategorySelect
              name="quickCategory"
              categories={categories}
              kind={draft.type === "income" ? "income" : "expense"}
              value={draft.categoryId ?? ""}
              onChange={(v) => patch({ categoryId: v || null })}
            />
          )}
          {!transfer && (
            <input name="quickPayee" placeholder="Получатель" value={draft.payee ?? ""} onChange={(e) => patch({ payee: e.target.value || null })} />
          )}
          <span className="muted" data-testid="quick-date">
            {formatDate(draft.date)}
          </span>
          <button className="btn primary small" onClick={() => save.run()} disabled={!ready || save.busy} aria-busy={save.busy} data-done={save.done || undefined} title="Enter">
            Записать
          </button>
          {!inWindow && (
            <button className="link" onClick={more}>
              Подробнее…
            </button>
          )}
          {canRemember && (
            <label className="check quick-remember">
              <input type="checkbox" name="quickRemember" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              запомнить: «{draft.merchant}» → эта категория
            </label>
          )}
          {draft.ruleId && <span className="hint">категория по правилу</span>}
        </div>
      )}
      <ErrorText error={parseError ?? save.error} />
    </div>
  );
}
