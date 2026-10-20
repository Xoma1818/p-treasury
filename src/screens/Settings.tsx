import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { CbrButton } from "../components/CbrButton";
import { BackupCard, ImportDialog, SummaryDialog, UpdatesCard } from "../components/DataTools";
import { Field } from "../components/Fields";
import { ErrorText } from "../components/Modal";
import { Money } from "../components/Money";
import { api } from "../lib/api";
import { formatDate, today } from "../lib/dates";
import { useAppInfo, useCurrencies, useSettings } from "../lib/queries";
import { rateSource } from "../lib/rates";
import { useAction } from "../lib/useAction";

export function Settings() {
  const info = useAppInfo();
  const settings = useSettings().data;
  const currencies = useCurrencies().data ?? [];
  const setSetting = useAction(api.setSetting);
  const base = settings?.base_currency ?? "RUB";
  const [dialog, setDialog] = useState<"summary" | "import" | null>(null);

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
          <Field label="Формат даты">
            {(id) => (
              <select id={id} name="dateFormat" value={settings?.date_format ?? "DD.MM.YYYY"} onChange={(e) => setSetting.run("date_format", e.target.value)}>
                <option value="DD.MM.YYYY">ДД.ММ.ГГГГ</option>
                <option value="YYYY-MM-DD">ГГГГ-ММ-ДД</option>
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

      <div className="card" data-testid="data-card">
        <h2>Данные</h2>
        <p className="muted">Сводка за период в Excel, загрузка операций из CSV. Список операций и отчёты выгружаются кнопкой «Выгрузить» на своих экранах.</p>
        <div className="btn-group">
          <button className="btn primary" onClick={() => setDialog("summary")}>
            Сводка в Excel
          </button>
          <button className="btn" onClick={() => setDialog("import")}>
            Импорт из CSV
          </button>
        </div>
      </div>
      {dialog === "summary" && <SummaryDialog onClose={() => setDialog(null)} />}
      {dialog === "import" && <ImportDialog onClose={() => setDialog(null)} />}

      <BackupCard />
      <UpdatesCard />

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

const RATES_SHOWN = 12;

function Rates({ base }: { base: string }) {
  const currencies = useCurrencies().data ?? [];
  const rates = useQuery({ queryKey: ["rates"], queryFn: api.listRates });
  const [cbrDate, setCbrDate] = useState(today());
  const [date, setDate] = useState(today());
  const [from, setFrom] = useState("USD");
  const [rate, setRate] = useState("");
  const [all, setAll] = useState(false);
  const add = useAction(api.setRate, () => setRate(""));
  const remove = useAction(api.deleteRate);
  const symbol = (code: string) => currencies.find((c) => c.code === code)?.symbol ?? code;
  const list = rates.data ?? [];
  const shown = all ? list : list.slice(0, RATES_SHOWN);

  return (
    <div className="card" data-testid="rates-card">
      <h2>Курсы валют</h2>
      <p className="muted">
        Курс к основной валюте на дату. Для пересчёта берётся последний известный курс на день операции.
      </p>
      <div className="rates-block">
        <h3>Официальный курс ЦБ РФ</h3>
        <div className="inline-form">
          <input type="date" aria-label="Дата курсов ЦБ" name="cbrDate" value={cbrDate} max={today()} onChange={(e) => setCbrDate(e.target.value)} />
          <CbrButton date={cbrDate} />
        </div>
        <p className="hint">Загружаются курсы всех валют ваших счетов и долгов с сайта cbr.ru. Нужен интернет.</p>
      </div>
      <div className="rates-block">
        <h3>Ввести вручную</h3>
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
          <button className="btn" type="submit" aria-busy={add.busy} disabled={add.busy || !rate.trim()}>
            Добавить
          </button>
        </form>
        <ErrorText error={add.error ?? remove.error} />
      </div>
      {list.length > 0 && (
        <table className="table compact rates-table" data-testid="rates">
          <tbody>
            {shown.map((r) => (
              <tr key={`${r.date}-${r.fromCode}-${r.toCode}`} data-source={r.source}>
                <td className="date">{formatDate(r.date)}</td>
                <td>
                  1 {r.fromCode} = {r.rate.replace(".", ",")} {symbol(r.toCode)}
                </td>
                <td>
                  <span className={r.source === "cbr" ? "badge good" : "badge"}>{rateSource(r.source)}</span>
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
      {list.length > RATES_SHOWN && (
        <button className="link table-foot" onClick={() => setAll(!all)}>
          {all ? "Свернуть" : `Показать все (${list.length})`}
        </button>
      )}
    </div>
  );
}
