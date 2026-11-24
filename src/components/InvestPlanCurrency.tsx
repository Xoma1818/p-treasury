import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, type Currency } from "../lib/api";
import { monthTitle } from "../lib/dates";
import { useAction } from "../lib/useAction";
import { useFormWrite } from "../lib/useFormWrite";
import { Field } from "./Fields";
import { FormAmountsToggle, useFormAmounts, useFormMoney } from "./FormAmounts";
import { ErrorText, Modal } from "./Modal";

export function PlanCurrencySelect({ currency, onChange, legacy = false }: {
  currency: Currency | null;
  onChange: (next: Currency | null) => void;
  legacy?: boolean;
}) {
  const list = useQuery({
    queryKey: legacy ? ["currencies", "all"] : ["currencies"],
    queryFn: legacy ? api.listAllCurrencies : api.listCurrencies,
    staleTime: Infinity,
  });
  const choices = list.data ?? [];
  const options = currency && !choices.some(c => c.code === currency.code) ? [currency, ...choices] : choices;
  return (
    <>
      <Field label="Валюта плана">
        {(id) => (
          <select id={id} name="investPlanCurrency" value={currency?.code ?? ""} required
            onChange={e => onChange(options.find(c => c.code === e.target.value) ?? null)}>
            {!currency && <option value="">{list.isPending ? "Загрузка валют…" : "Выберите валюту"}</option>}
            {options.map(c => <option key={c.code} value={c.code}>{c.code} · {c.name}</option>)}
          </select>
        )}
      </Field>
      {list.isError && <p role="alert" className="hint">Не удалось загрузить валюты. <button type="button" className="link" onClick={() => void list.refetch()}>Повторить</button></p>}
    </>
  );
}

export function ConfirmPlanCurrency({ month, rawValue, onClose }: {
  month: string | null;
  rawValue: number;
  onClose: () => void;
}) {
  const [currency, setCurrency] = useState<Currency | null>(null);
  const privacy = useFormAmounts(month ?? "global");
  const money = useFormMoney(privacy, currency?.code ?? "", currency?.symbol ?? "", currency?.minorUnits ?? 0);
  const write = useFormWrite();
  const confirm = useAction(api.confirmInvestPlanCurrency, onClose);
  const cancel = () => { if (!write.locked.current) onClose(); };
  return (
    <Modal title="Указать валюту плана" onClose={cancel} dismissDisabled={write.busy}>
      <form className="form" ref={write.form} onClickCapture={write.blockClick} onSubmit={e => {
        e.preventDefault();
        if (currency) write.run("save", () => confirm.runAsync(month, rawValue, currency.code));
      }}>
        <fieldset disabled={write.busy} style={{ display: "contents" }}>
          <p className="muted">{month ? `План на ${monthTitle(month).toLowerCase()}` : "Общий план на каждый месяц"} сохранён без валюты. Выберите валюту, в которой вводили сумму, и проверьте результат.</p>
          <PlanCurrencySelect currency={currency} legacy onChange={next => { privacy.conceal(); setCurrency(next); }} />
          {currency && <p aria-live="polite" data-testid="invest-plan-currency-preview">Сумма плана <b className="money">{money(rawValue)}</b></p>}
          <FormAmountsToggle privacy={privacy} />
          <ErrorText error={confirm.error} />
          <div className="actions">
            <span className="spacer" />
            <button type="button" className="btn" onClick={cancel}>Отмена</button>
            <button type="submit" className="btn primary" data-testid="invest-plan-currency-confirm" aria-busy={write.busy} disabled={!currency || write.busy}>Подтвердить валюту</button>
          </div>
        </fieldset>
      </form>
    </Modal>
  );
}
