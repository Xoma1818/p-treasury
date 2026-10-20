import { useState } from "react";
import { AccountSelectType } from "./accountParts";
import { AmountInput, Field } from "../components/Fields";
import { ErrorText } from "../components/Modal";
import { api, type AccountType } from "../lib/api";
import { today } from "../lib/dates";
import { parseAmount } from "../lib/money";
import { useCurrencies } from "../lib/queries";
import { useAction } from "../lib/useAction";

interface Row {
  name: string;
  type: AccountType;
  currencyCode: string;
  balance: string;
}

/** Мастер первого запуска: основная валюта → счета с остатками → категории. */
export function Onboarding() {
  const currencies = useCurrencies().data ?? [];
  const [step, setStep] = useState(1);
  const [base, setBase] = useState("RUB");
  const [rows, setRows] = useState<Row[]>([
    { name: "Наличные", type: "cash", currencyCode: "RUB", balance: "" },
    { name: "Карта", type: "debit", currencyCode: "RUB", balance: "" },
  ]);
  const [defaults, setDefaults] = useState(true);
  const finish = useAction(api.finishOnboarding);

  const update = (i: number, patch: Partial<Row>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const minorOf = (code: string) => currencies.find((c) => c.code === code)?.minorUnits ?? 2;

  const submit = () => {
    const accounts = [];
    for (const r of rows.filter((r) => r.name.trim())) {
      const v = r.balance.trim() === "" ? 0 : parseAmount(r.balance, minorOf(r.currencyCode));
      if (v === null) return finish.setError(`Проверьте остаток счёта «${r.name}»`);
      accounts.push({
        name: r.name,
        type: r.type,
        currencyCode: r.currencyCode,
        openingBalance: v,
        openingDate: today(),
        creditLimit: null,
        includeInTotal: true,
      });
    }
    finish.run({ baseCurrency: base, accounts, defaultCategories: defaults });
  };

  return (
    <div className="wizard">
      <div className="card wizard-card">
        <div className="brand big">P-Treasury</div>
        <div className="steps">Шаг {step} из 3</div>

        {step === 1 && (
          <>
            <h1>Основная валюта</h1>
            <p className="muted">В ней считаются общий баланс, бюджеты и отчёты. Счета могут быть в любых валютах.</p>
            <Field label="Основная валюта">
              {(id) => (
                <select id={id} name="baseCurrency" value={base} onChange={(e) => setBase(e.target.value)}>
                  {currencies.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.name} ({c.symbol})
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </>
        )}

        {step === 2 && (
          <>
            <h1>Счета и текущие остатки</h1>
            <p className="muted">Заведите счета, которыми пользуетесь, и введите, сколько на них сейчас. Счета можно добавить и позже.</p>
            <table className="grid-form">
              <thead>
                <tr>
                  <th>Название</th>
                  <th>Тип</th>
                  <th>Валюта</th>
                  <th>Остаток</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td>
                      <input aria-label="Название счёта" name={`account-name-${i}`} value={r.name} onChange={(e) => update(i, { name: e.target.value })} />
                    </td>
                    <td>
                      <AccountSelectType name={`account-type-${i}`} value={r.type} onChange={(type) => update(i, { type })} />
                    </td>
                    <td>
                      <select aria-label="Валюта счёта" name={`account-currency-${i}`} value={r.currencyCode} onChange={(e) => update(i, { currencyCode: e.target.value })}>
                        {currencies.map((c) => (
                          <option key={c.code} value={c.code}>
                            {c.code}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <AmountInput
                        name={`account-balance-${i}`}
                        value={r.balance}
                        onChange={(balance) => update(i, { balance })}
                        minorUnits={minorOf(r.currencyCode)}
                        allowNegative={r.type === "credit"}
                      />
                    </td>
                    <td>
                      <button className="icon-btn" aria-label="Убрать счёт" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                        ×
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button className="btn" onClick={() => setRows([...rows, { name: "", type: "debit", currencyCode: base, balance: "" }])}>
              + Добавить счёт
            </button>
          </>
        )}

        {step === 3 && (
          <>
            <h1>Категории</h1>
            <p className="muted">
              Готовый набор: Продукты, Транспорт, Жильё, Кафе, Здоровье, Дети и другие, а для доходов Зарплата, Кешбэк и бонусы и
              проценты. Всё можно переименовать, удалить или дополнить.
            </p>
            <label className="check">
              <input type="checkbox" name="defaultCategories" checked={defaults} onChange={(e) => setDefaults(e.target.checked)} />
              Создать категории по умолчанию
            </label>
          </>
        )}

        <ErrorText error={finish.error} />
        <div className="actions">
          {step > 1 && (
            <button className="btn" onClick={() => setStep(step - 1)}>
              Назад
            </button>
          )}
          <span className="spacer" />
          {step < 3 ? (
            <button className="btn primary" onClick={() => setStep(step + 1)}>
              Далее
            </button>
          ) : (
            <button className="btn primary" onClick={submit} disabled={finish.busy}>
              Начать
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
