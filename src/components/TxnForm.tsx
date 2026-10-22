import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type Template, type TxnExtra, type TxnInput, type TxnType } from "../lib/api";
import { monthTitle, shiftMonth, today } from "../lib/dates";
import { receiptProblem, receiptRemainder, spreadParts } from "../lib/receipt";
import { amountToInput, formatAmount, parseAmount } from "../lib/money";
import { useAccounts, useCategories } from "../lib/queries";
import { useUi, type TxnFormState } from "../lib/store";
import { useAction } from "../lib/useAction";
import { AccountSelect, AmountInput, amountText, CategorySelect, Field } from "./Fields";
import { NotesBlock } from "./Notes";
import { TemplateButtons, useTemplates } from "./Templates";
import { ErrorText, Modal } from "./Modal";
import { Hint } from "./Hint";
import { TagInput } from "./TagInput";

const TABS: [TxnType, string][] = [
  ["expense", "Расход"],
  ["income", "Доход"],
  ["transfer", "Перевод"],
];

/** Диалог «Новая операция» / «Операция» (Ctrl+N открывает расход). */
export function TxnForm() {
  const state = useUi((s) => s.txnForm);
  const close = useUi((s) => s.openTxnForm);
  if (!state) return null;
  const key = state.mode === "edit" ? state.txn.id : `new-${state.type}`;
  return <TxnFormInner key={key} state={state} onClose={() => close(null)} />;
}

function TxnFormInner({ state, onClose }: { state: NonNullable<TxnFormState>; onClose: () => void }) {
  const editing = state.mode === "edit" ? state.txn : null;
  const prefill = state.mode === "new" ? state.prefill : undefined;
  const accounts = useAccounts(true).data ?? [];
  const categories = useCategories().data ?? [];

  const [type, setType] = useState<TxnType>(editing?.type ?? (state.mode === "new" ? state.type : "expense"));
  const [amount, setAmount] = useState(amountText(editing?.amount ?? prefill?.amount, editing?.minorUnits));
  const [toAmount, setToAmount] = useState(amountText(editing?.toAmount, editing?.toMinorUnits ?? 2));
  const [date, setDate] = useState(editing?.date ?? ((state.mode === "new" ? state.date : undefined) || today()));
  const [accountId, setAccountId] = useState(editing?.accountId ?? prefill?.accountId ?? "");
  const [toAccountId, setToAccountId] = useState(editing?.toAccountId ?? prefill?.toAccountId ?? "");
  const [categoryId, setCategoryId] = useState(editing?.categoryId ?? prefill?.categoryId ?? "");
  const [payee, setPayee] = useState(editing?.payee ?? prefill?.payee ?? "");
  const [note, setNote] = useState(editing?.note ?? prefill?.note ?? "");
  const [hints, setHints] = useState<{ payee: string; categoryId: string | null; accountId: string }[]>([]);
  const [eventId, setEventId] = useState(editing?.eventId ?? "");
  // Общая трата: доли друзей; null — трата только своя.
  const [friends, setFriends] = useState<{ name: string; amount: string }[] | null>(null);
  // Г6: теги; Г3: «Учитывать по месяцам» и разбивка чека по категориям.
  const [tags, setTags] = useState<string[]>(editing?.tags ?? prefill?.tags ?? []);
  const [spread, setSpread] = useState<string>(editing?.spreadMonths ? String(editing.spreadMonths) : "");
  const [parts, setParts] = useState<{ categoryId: string; amount: string; note?: string | null }[] | null>(null);
  const splitId = editing?.splitId ?? null;
  const receipt = useQuery({ queryKey: ["receipt", splitId], queryFn: () => api.getReceipt(splitId!), enabled: !!splitId });
  const receiptLoaded = useRef(false);
  useEffect(() => {
    const r = receipt.data;
    if (!r || receiptLoaded.current) return;
    receiptLoaded.current = true;
    const m = editing?.minorUnits ?? 2;
    setAmount(amountText(r.total, m));
    setDate(r.date);
    setAccountId(r.accountId);
    setPayee(r.payee ?? "");
    setTags(r.tags);
    // Комментарий чека: общий у всех частей; свои комментарии частей сохраняются.
    const notes = new Set(r.parts.map((x) => x.note ?? ""));
    const common = notes.size === 1 ? [...notes][0] : "";
    setNote(common);
    setParts(r.parts.map((x) => ({ categoryId: x.categoryId, amount: amountText(x.amount, m), note: x.note && x.note !== common ? x.note : null })));
  }, [receipt.data]);
  const eventsOn = useQuery({ queryKey: ["events", "on", date], queryFn: () => api.eventsOn(date), enabled: !!date }).data ?? [];

  // Быстрый ввод: последние использованные счёт и категория для этого типа.
  useEffect(() => {
    if (editing) return;
    api.transactionDefaults(type).then((d) => {
      setAccountId((cur) => cur || d.accountId || accounts.find((a) => !a.archived)?.id || "");
      if (type === "transfer") setToAccountId((cur) => cur || d.toAccountId || "");
      else setCategoryId((cur) => (prefill?.categoryId && cur ? cur : d.categoryId ?? ""));
    });
    // accounts нужен только как запасной вариант при первом вводе.
  }, [type, editing, accounts.length]);

  useEffect(() => {
    if (type === "transfer" || payee.trim().length < 2) {
      setHints([]);
      return;
    }
    const q = payee;
    const t = setTimeout(
      () =>
        api.payeeHints(type, q).then((list) => {
          setHints(list);
          // Имя набрано целиком быстрее, чем пришли подсказки: подставляем так же, как при выборе из списка.
          const exact = list.find((h) => h.payee.toLowerCase() === q.trim().toLowerCase());
          if (exact && !editing && !prefill) applyHint(exact);
        }),
      150,
    );
    return () => clearTimeout(t);
    // applyHint и editing не меняются за время жизни формы.
  }, [payee, type]);

  const from = accounts.find((a) => a.id === accountId);
  const to = accounts.find((a) => a.id === toAccountId);
  const crossCurrency = type === "transfer" && from && to && from.currencyCode !== to.currencyCode;
  const minor = from?.minorUnits ?? 2;
  const amountValue = parseAmount(amount, minor);
  const toAmountValue = parseAmount(toAmount, to?.minorUnits ?? 2);

  const rate = useMemo(() => {
    if (!crossCurrency || !amountValue || !toAmountValue || amountValue <= 0 || toAmountValue <= 0) return null;
    // Курс показываем в ту сторону, где он больше 1: «1 $ = 92,00 ₽».
    const a = amountValue / 10 ** minor;
    const b = toAmountValue / 10 ** (to?.minorUnits ?? 2);
    return a >= b
      ? `1 ${to!.currencySymbol} = ${(a / b).toFixed(2).replace(".", ",")} ${from!.currencySymbol}`
      : `1 ${from!.currencySymbol} = ${(b / a).toFixed(2).replace(".", ",")} ${to!.currencySymbol}`;
  }, [crossCurrency, amountValue, toAmountValue, minor, from, to]);

  // Подсказка применяется один раз на имя получателя: иначе ответ ядра, пришедший
  // позже, перетёр бы счёт или категорию, которые пользователь уже поменял руками.
  const appliedFor = useRef<string | null>(null);
  // Списки пересоздаются после подсказки: WebKit не шлёт событие выбора, если
  // пользователь возвращает пункт, выбранный до программной смены значения.
  const [hintRev, setHintRev] = useState(0);
  function applyHint(h: { payee: string; categoryId: string | null; accountId: string }) {
    if (appliedFor.current === h.payee) return;
    appliedFor.current = h.payee;
    if (h.categoryId) setCategoryId(h.categoryId);
    setAccountId(h.accountId);
    setHintRev((r) => r + 1);
  }

  const onPayeeChange = (v: string) => {
    setPayee(v);
    const hit = hints.find((h) => h.payee === v);
    if (hit) applyHint(hit);
  };

  const save = useAction(async (input: TxnInput) => {
    const event = type === "transfer" ? null : eventId || null;
    if (receiptParts) {
      const r = {
        date: input.date,
        accountId: input.accountId,
        payee: input.payee,
        note: input.note,
        total: input.amount,
        parts: receiptParts.map((x, i) => ({ categoryId: x.categoryId, amount: x.amount ?? 0, note: parts?.[i]?.note ?? null })),
        tags,
      };
      if (splitId) await api.updateReceipt(splitId, r);
      else {
        const id = await api.createReceipt(r);
        if (event) {
          const got = await api.getReceipt(id);
          await api.assignEvent(event, got.parts.map((x) => x.id));
        }
      }
      return;
    }
    const extra: TxnExtra = { spreadMonths: type === "expense" && spreadMonths ? spreadMonths : null, tags };
    if (editing) {
      await api.updateTransactionFull(editing.id, input, extra);
      if (event !== (editing.eventId ?? null)) await api.assignEvent(event, [editing.id]);
      return;
    }
    if (split) {
      await api.splitExpense({
        date: input.date,
        accountId: input.accountId,
        categoryId: input.categoryId ?? "",
        payee: input.payee,
        note: input.note,
        total: input.amount,
        myShare: split.mine,
        friends: split.shares,
      });
      return;
    }
    const id = await api.createTransactionFull(input, extra, event);
    // Операция из напоминания отмечает его выполненным.
    if (state.mode === "new" && state.onSaved) await state.onSaved(id);
  }, onClose, { celebrate: true });
  const remove = useAction(() => (splitId ? api.deleteReceipt(splitId) : api.deleteTransaction(editing!.id)), onClose);

  // Шаблоны: подставить сохранённую операцию или сохранить текущую.
  const templates = useTemplates().data ?? [];
  const [templateName, setTemplateName] = useState<string | null>(null);
  const [templateSaved, setTemplateSaved] = useState<string | null>(null);
  const pickTemplate = (t: Template) => {
    setType(t.type);
    if (t.amount != null) setAmount(amountText(t.amount, t.minorUnits));
    if (t.accountId) setAccountId(t.accountId);
    setToAccountId(t.toAccountId ?? "");
    setCategoryId(t.categoryId ?? "");
    setPayee(t.payee ?? "");
    setNote(t.note ?? "");
    appliedFor.current = t.payee;
    setHintRev((r) => r + 1);
    api.templateUsed(t.id);
  };
  const saveTemplate = useAction(async (name: string) => {
    await api.createTemplate({
      name,
      type: type === "adjustment" ? "expense" : type,
      amount: amountValue && amountValue > 0 ? amountValue : null,
      accountId: accountId || null,
      toAccountId: type === "transfer" ? toAccountId || null : null,
      categoryId: type === "transfer" ? null : categoryId || null,
      payee: payee || null,
      note: note || null,
    });
    setTemplateName(null);
    setTemplateSaved(name);
  });
  const suggestedName = () => payee.trim() || categories.find((c) => c.id === categoryId)?.name || "";

  // Доли друзей в минимальных единицах; своя доля — остаток.
  const split =
    friends && type === "expense"
      ? (() => {
          const shares = friends.map((f) => ({ name: f.name.trim(), amount: parseAmount(f.amount, minor) ?? 0 }));
          return { shares, mine: (amountValue ?? 0) - shares.reduce((a, f) => a + f.amount, 0) };
        })()
      : null;
  const evenly = (n: number) => {
    if (!amountValue || amountValue <= 0) return;
    const each = Math.floor(amountValue / (n + 1));
    setFriends((list) => (list ?? []).map((f) => ({ ...f, amount: amountToInput(each, minor) })));
  };

  // Разбивка чека: строки в минимальных единицах и остаток.
  const receiptParts = parts && type === "expense" ? parts.map((x) => ({ categoryId: x.categoryId, amount: parseAmount(x.amount, minor) })) : null;
  const receiptLeft = receiptParts ? receiptRemainder(amountValue, receiptParts) : 0;
  const spreadMonths = (() => {
    const n = Number(spread);
    return spread && Number.isInteger(n) ? n : null;
  })();
  const spreadPreview = type === "expense" && spreadMonths && spreadMonths >= 2 && spreadMonths <= 24 && amountValue && amountValue > 0 ? spreadParts(amountValue, spreadMonths) : null;
  const startSplit = () => {
    const filled = amountValue && amountValue > 0;
    setParts([
      { categoryId, amount: filled ? amountToInput(amountValue, minor) : "" },
      { categoryId: "", amount: "" },
    ]);
    setSpread("");
  };
  const fillRemainder = (i: number) => {
    if (!parts || !receiptParts) return;
    const own = receiptParts[i].amount ?? 0;
    const v = own + receiptLeft;
    if (v > 0) setParts(parts.map((x, j) => (j === i ? { ...x, amount: amountToInput(v, minor) } : x)));
  };

  const submit = () => {
    if (amountValue === null || amountValue <= 0) return save.setError("Введите сумму больше нуля");
    if (receiptParts) {
      const problem = receiptProblem(amountValue, receiptParts);
      if (problem) return save.setError(problem);
    }
    if (type === "expense" && spread && (spreadMonths === null || spreadMonths < 2 || spreadMonths > 24))
      return save.setError("Учитывать по месяцам можно от 2 до 24 месяцев");
    if (split) {
      if (split.shares.some((f) => !f.name)) return save.setError("Укажите имя у каждой доли");
      if (split.shares.some((f) => f.amount <= 0)) return save.setError("Доли должны быть больше нуля");
      if (split.mine < 0) return save.setError("Доли друзей больше общей суммы");
    }
    if (crossCurrency && (toAmountValue === null || toAmountValue <= 0)) return save.setError("Введите сумму зачисления");
    save.run({
      type,
      date,
      accountId,
      amount: amountValue,
      categoryId: type === "transfer" || receiptParts ? null : categoryId || null,
      toAccountId: type === "transfer" ? toAccountId || null : null,
      toAmount: type === "transfer" ? (crossCurrency ? toAmountValue : null) : null,
      payee: payee || null,
      note: note || null,
    });
  };

  const isAdjustment = editing?.type === "adjustment";
  const title = splitId ? "Разбитый чек" : editing ? "Операция" : "Новая операция";

  return (
    <Modal title={title} onClose={onClose}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && e.ctrlKey) {
            e.preventDefault();
            submit();
          }
        }}
      >
        {isAdjustment ? (
          <p className="muted">
            Корректировка баланса на {formatAmount(editing.amount, editing.minorUnits)} {editing.currencySymbol}. Её можно
            только удалить и сверить счёт заново.
          </p>
        ) : (
          <>
            {!editing && templates.length > 0 && <TemplateButtons items={templates} onPick={pickTemplate} />}
            {!splitId && (
            <div className="tabs" role="tablist">
              {TABS.map(([t, label]) => (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={type === t}
                  className={type === t ? "tab active" : "tab"}
                  onClick={() => setType(t)}
                >
                  {label}
                </button>
              ))}
            </div>
            )}
            <div className="row">
              <Field label={crossCurrency ? `Списано, ${from?.currencySymbol}` : receiptParts ? "Сумма чека" : "Сумма"}>
                {(id) => <AmountInput id={id} name="amount" value={amount} onChange={setAmount} minorUnits={minor} autoFocus />}
              </Field>
              <Field label="Дата">{(id) => <input id={id} name="date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
            </div>
            <Field label={type === "transfer" ? "Со счёта" : "Счёт"}>
              {(id) => <AccountSelect key={hintRev} id={id} name="account" accounts={accounts} value={accountId} onChange={setAccountId} />}
            </Field>
            {type === "transfer" ? (
              <>
                <Field label="На счёт">
                  {(id) => (
                    <AccountSelect id={id} name="toAccount" accounts={accounts} value={toAccountId} onChange={setToAccountId} exclude={accountId} />
                  )}
                </Field>
                {crossCurrency && (
                  <Field label={`Зачислено, ${to?.currencySymbol}`} hint={rate && <span data-testid="rate">Курс: {rate}</span>}>
                    {(id) => <AmountInput id={id} name="toAmount" value={toAmount} onChange={setToAmount} minorUnits={to?.minorUnits} />}
                  </Field>
                )}
              </>
            ) : (
              <>
                <Field label="Получатель">
                  {(id) => (
                    <>
                      <input id={id} name="payee" list="payee-hints" autoComplete="off" value={payee} onChange={(e) => onPayeeChange(e.target.value)} />
                      <datalist id="payee-hints">
                        {hints.map((h) => (
                          <option key={h.payee} value={h.payee} />
                        ))}
                      </datalist>
                    </>
                  )}
                </Field>
                {receiptParts && parts ? (
                  <div className="receipt-split" data-testid="receipt-split">
                    <div className="label-row">
                      <b>По категориям</b>
                      <Hint of="txn.receipt" />
                    </div>
                    {parts.map((x, i) => (
                      <div className="receipt-row" key={i}>
                        <CategorySelect
                          name={`partCategory${i}`}
                          categories={categories}
                          kind="expense"
                          value={x.categoryId}
                          onChange={(v) => setParts(parts.map((y, j) => (j === i ? { ...y, categoryId: v } : y)))}
                        />
                        <span
                          onDoubleClick={() => fillRemainder(i)}
                          title="Двойной щелчок — добавить сюда остаток"
                        >
                          <AmountInput
                            name={`partAmount${i}`}
                            value={x.amount}
                            minorUnits={minor}
                            onChange={(v) => setParts(parts.map((y, j) => (j === i ? { ...y, amount: v } : y)))}
                          />
                        </span>
                        <button
                          type="button"
                          className="link"
                          aria-label="Убрать строку"
                          onClick={() => {
                            const next = parts.filter((_, j) => j !== i);
                            if (next.length === 0 || (next.length === 1 && !splitId)) {
                              // Одна строка — уже не разбивка: её категория становится категорией расхода.
                              if (next[0]?.categoryId) setCategoryId(next[0].categoryId);
                              setParts(null);
                            } else setParts(next);
                          }}
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                    <div className="receipt-foot">
                      <button type="button" className="link" onClick={() => setParts([...parts, { categoryId: "", amount: receiptLeft > 0 ? amountToInput(receiptLeft, minor) : "" }])}>
                        + строка
                      </button>
                      {receiptLeft > 0 && (
                        <button type="button" className="link" onClick={() => fillRemainder(parts.length - 1)}>
                          Остаток в последнюю строку
                        </button>
                      )}
                      <span className={receiptLeft === 0 ? "receipt-left done" : receiptLeft < 0 ? "receipt-left bad" : "receipt-left"} data-testid="receipt-left">
                        {receiptLeft === 0 ? "Распределено полностью" : receiptLeft > 0 ? `Остаток: ${formatAmount(receiptLeft, minor)} ${from?.currencySymbol ?? ""}` : `Больше чека на ${formatAmount(-receiptLeft, minor)} ${from?.currencySymbol ?? ""}`}
                      </span>
                    </div>
                  </div>
                ) : (
                  <Field label="Категория">
                    {(id) => <CategorySelect key={hintRev} id={id} name="category" categories={categories} kind={type === "income" ? "income" : "expense"} value={categoryId} onChange={setCategoryId} />}
                  </Field>
                )}
                {type === "expense" && !receiptParts && !split && !editing && (
                  <div className="row-links">
                    <button type="button" className="link" onClick={startSplit} data-testid="start-receipt">
                      Разбить по категориям
                    </button>
                    <Hint of="txn.receipt" />
                  </div>
                )}
                {(eventsOn.length > 0 || eventId) && (
                  <Field label="Поездка или событие">
                    {(id) => (
                      <select id={id} name="event" value={eventId} onChange={(e) => setEventId(e.target.value)}>
                        <option value="">Не относится</option>
                        {editing?.eventId && !eventsOn.some(([eid]) => eid === editing.eventId) && <option value={editing.eventId}>{editing.eventName}</option>}
                        {eventsOn.map(([eid, name]) => (
                          <option key={eid} value={eid}>
                            {name}
                          </option>
                        ))}
                      </select>
                    )}
                  </Field>
                )}
                {!editing && type === "expense" && !split && !receiptParts && (
                  <div>
                    <button
                      type="button"
                      className="link"
                      onClick={() => {
                        const each = amountValue && amountValue > 0 ? amountToInput(Math.floor(amountValue / 2), minor) : "";
                        setFriends([{ name: "", amount: each }]);
                      }}
                    >
                      Разделить с друзьями
                    </button>
                  </div>
                )}
                {split && friends && (
                  <div className="split" data-testid="split">
                    <div className="split-head">
                      <b>Общая трата</b>
                      <span className="muted">Доли друзей станут долгами «мне должны»</span>
                    </div>
                    {friends.map((f, i) => (
                      <div className="split-row" key={i}>
                        <input
                          name={`friend${i}`}
                          aria-label="Кто"
                          placeholder="Имя"
                          value={f.name}
                          onChange={(e) => setFriends(friends.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                        />
                        <AmountInput
                          name={`friendAmount${i}`}
                          value={f.amount}
                          minorUnits={minor}
                          onChange={(v) => setFriends(friends.map((x, j) => (j === i ? { ...x, amount: v } : x)))}
                        />
                        <button type="button" className="link" aria-label="Убрать долю" onClick={() => setFriends(friends.length > 1 ? friends.filter((_, j) => j !== i) : null)}>
                          ✕
                        </button>
                      </div>
                    ))}
                    <div className="split-foot">
                      <button type="button" className="link" onClick={() => setFriends([...friends, { name: "", amount: "" }])}>
                        + ещё человек
                      </button>
                      <button type="button" className="link" onClick={() => evenly(friends.length)}>
                        Поровну
                      </button>
                      <span className={split.mine < 0 ? "warn" : "muted"} data-testid="split-mine">
                        Моя доля: {formatAmount(split.mine, minor)} {from?.currencySymbol}
                      </span>
                    </div>
                  </div>
                )}
              </>
            )}
            <Field label="Комментарий">{(id) => <input id={id} name="note" value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
            {!split && (
              <div className="field">
                <div className="label-row">
                  <label htmlFor="txn-tags">Теги</label>
                  <Hint of="txn.tags" />
                </div>
                <TagInput id="txn-tags" value={tags} onChange={setTags} />
              </div>
            )}
            {type === "expense" && !receiptParts && !split && (!editing || !editing.debtId) && (
              <div className="spread" data-testid="spread">
                <label className="check">
                  <input type="checkbox" name="spreadOn" checked={spread !== ""} onChange={(e) => setSpread(e.target.checked ? "12" : "")} />
                  Учитывать по месяцам
                </label>
                {spread !== "" && (
                  <>
                    <input
                      type="number"
                      name="spreadMonths"
                      aria-label="Сколько месяцев"
                      min={2}
                      max={24}
                      value={spread}
                      onChange={(e) => setSpread(e.target.value)}
                    />
                    <span className="muted">мес.</span>
                  </>
                )}
                <Hint of="txn.spread" />
                {spreadPreview && spreadMonths && (
                  <span className="hint" data-testid="spread-preview">
                    по {formatAmount(spreadPreview[spreadPreview.length - 1], minor)} {from?.currencySymbol} в месяц, {monthTitle(date.slice(0, 7)).toLowerCase()} – {monthTitle(shiftMonth(date.slice(0, 7), spreadMonths - 1)).toLowerCase()}
                    {spreadPreview[0] !== spreadPreview[1] && ` (в первом ${formatAmount(spreadPreview[0], minor)})`}
                  </span>
                )}
              </div>
            )}
          </>
        )}
        {editing && <NotesBlock filter={{ transactionId: editing.id }} initial={{ transactionId: editing.id }} />}
        {!editing &&
          (templateName === null ? (
            <div>
              <button type="button" className="link" onClick={() => (setTemplateSaved(null), setTemplateName(suggestedName()))}>
                Сохранить как шаблон
              </button>
              {templateSaved && (
                <span className="ok" data-testid="template-saved">
                  {" "}
                  Шаблон «{templateSaved}» сохранён
                </span>
              )}
            </div>
          ) : (
            <div className="inline-form">
              <input
                name="templateName"
                aria-label="Название шаблона"
                placeholder="Название, например «Кофе»"
                value={templateName}
                autoFocus
                onChange={(e) => setTemplateName(e.target.value)}
                onKeyDown={(e) => {
                  // Enter сохраняет шаблон, а не операцию.
                  if (e.key === "Enter" && !e.ctrlKey) {
                    e.preventDefault();
                    saveTemplate.run(templateName.trim());
                  }
                }}
              />
              <button type="button" className="btn" disabled={!templateName.trim() || saveTemplate.busy} onClick={() => saveTemplate.run(templateName.trim())}>
                Сохранить шаблон
              </button>
              <button type="button" className="link" onClick={() => setTemplateName(null)}>
                Не нужно
              </button>
            </div>
          ))}
        <ErrorText error={saveTemplate.error} />
        <ErrorText error={save.error ?? remove.error} />
        <div className="actions">
          {editing && (
            <button type="button" className="btn danger" onClick={() => remove.run()} disabled={remove.busy}>
              {splitId ? "Удалить чек" : "Удалить"}
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Отмена
          </button>
          {!isAdjustment && (
            <button type="submit" className="btn primary" aria-busy={save.busy} data-done={save.done || undefined} disabled={save.busy} title="Ctrl+Enter">
              Сохранить
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}
