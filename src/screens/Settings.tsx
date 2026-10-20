import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Field } from "../components/Fields";
import { ErrorText } from "../components/Modal";
import { Money } from "../components/Money";
import { api } from "../lib/api";
import { formatDate, today } from "../lib/dates";
import { useAppInfo, useCurrencies, useSettings } from "../lib/queries";
import { useAction } from "../lib/useAction";

export function Settings() {
  const info = useAppInfo();
  const settings = useSettings().data;
  const currencies = useCurrencies().data ?? [];
  const setSetting = useAction(api.setSetting);
  const base = settings?.base_currency ?? "RUB";

  return (
    <section className="screen">
      <h1>Настройки</h1>

      <div className="card">
        <h2>Общие</h2>
        <div className="row">
          <Field label="Основная валюта" hint="В ней считаются общий баланс, бюджеты и отчёты.">
            {(id) => (
              <select id={id} name="baseCurrency" value={base} onChange={(e) => setSetting.run("base_currency", e.target.value)}>
                {currencies.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.name} ({c.symbol})
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Месяц начинается" hint="Для бюджета и итогов месяца, например с дня зарплаты.">
            {(id) => (
              <select id={id} name="monthStartDay" value={settings?.month_start_day ?? "1"} onChange={(e) => setSetting.run("month_start_day", e.target.value)}>
                {Array.from({ length: 28 }, (_, i) => String(i + 1)).map((d) => (
                  <option key={d} value={d}>
                    {d === "1" ? "1-го числа" : `${d}-го числа`}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Скрыть суммы" hint="Все суммы заменяются на «•••».">
            {(id) => (
              <select id={id} name="hideAmounts" value={settings?.hide_amounts ?? "0"} onChange={(e) => setSetting.run("hide_amounts", e.target.value)}>
                <option value="0">Нет</option>
                <option value="1">Да</option>
              </select>
            )}
          </Field>
          <Field label="Напоминать о платежах по долгам" hint="Уведомление приходит в 9:00.">
            {(id) => (
              <select
                id={id}
                name="debtReminderDays"
                value={settings?.debt_reminder_days_before ?? "3"}
                onChange={(e) => setSetting.run("debt_reminder_days_before", e.target.value)}
              >
                {[0, 1, 2, 3, 5, 7, 10].map((d) => (
                  <option key={d} value={String(d)}>
                    {d === 0 ? "в день платежа" : `за ${d} ${d === 1 ? "день" : d < 5 ? "дня" : "дней"}`}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="При закрытии окна" hint="В трее приложение продолжает присылать напоминания.">
            {(id) => (
              <select id={id} name="closeToTray" value={settings?.close_to_tray ?? "1"} onChange={(e) => setSetting.run("close_to_tray", e.target.value)}>
                <option value="1">Сворачивать в трей</option>
                <option value="0">Закрывать приложение</option>
              </select>
            )}
          </Field>
        </div>
        <ErrorText error={setSetting.error} />
      </div>

      <Rates base={base} />

      <div className="card">
        <h2>О программе</h2>
        {info.error && <p className="error">{String(info.error)}</p>}
        {info.data && (
          <dl className="facts">
            <dt>Версия</dt>
            <dd>{info.data.version}</dd>
            <dt>Версия данных</dt>
            <dd>
              {info.data.schemaVersion} из {info.data.supportedSchemaVersion}
            </dd>
            <dt>Файл данных</dt>
            <dd className="mono">{info.data.dbPath}</dd>
            {info.data.preMigrationBackup && (
              <>
                <dt>Копия перед обновлением</dt>
                <dd className="mono">{info.data.preMigrationBackup}</dd>
              </>
            )}
            <dt>Пример суммы</dt>
            <dd>
              <Money amount={1_497_723} />
            </dd>
          </dl>
        )}
      </div>
    </section>
  );
}

function Rates({ base }: { base: string }) {
  const currencies = useCurrencies().data ?? [];
  const rates = useQuery({ queryKey: ["rates"], queryFn: api.listRates });
  const [date, setDate] = useState(today());
  const [from, setFrom] = useState("USD");
  const [rate, setRate] = useState("");
  const add = useAction(api.setRate, () => setRate(""));
  const remove = useAction(api.deleteRate);
  const symbol = (code: string) => currencies.find((c) => c.code === code)?.symbol ?? code;

  return (
    <div className="card">
      <h2>Курсы валют</h2>
      <p className="muted">
        Курс к основной валюте на дату. Для пересчёта берётся последний известный курс на день операции.
      </p>
      <form className="inline-form" onSubmit={(e) => (e.preventDefault(), add.run(date, from, base, rate))}>
        <input type="date" aria-label="Дата курса" name="rateDate" value={date} onChange={(e) => setDate(e.target.value)} />
        <span>1</span>
        <select aria-label="Валюта" name="rateFrom" value={from} onChange={(e) => setFrom(e.target.value)}>
          {currencies
            .filter((c) => c.code !== base)
            .map((c) => (
              <option key={c.code} value={c.code}>
                {c.code}
              </option>
            ))}
        </select>
        <span>=</span>
        <input aria-label="Курс" name="rate" className="amount" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="92,15" />
        <span>{symbol(base)}</span>
        <button className="btn" type="submit" disabled={add.busy || !rate.trim()}>
          Добавить
        </button>
      </form>
      <ErrorText error={add.error ?? remove.error} />
      {rates.data && rates.data.length > 0 && (
        <table className="table compact" data-testid="rates">
          <tbody>
            {rates.data.map((r) => (
              <tr key={`${r.date}-${r.fromCode}-${r.toCode}`}>
                <td>{formatDate(r.date)}</td>
                <td>
                  1 {r.fromCode} = {r.rate.replace(".", ",")} {symbol(r.toCode)}
                </td>
                <td className="row-actions">
                  <button className="link danger" onClick={() => remove.run(r.date, r.fromCode, r.toCode)}>
                    Удалить
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
