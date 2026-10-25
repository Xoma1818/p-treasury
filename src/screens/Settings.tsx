import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { CbrButton } from "../components/CbrButton";
import { ImportDialog, SummaryDialog, UpdatesCard } from "../components/DataTools";
import { VaultCard } from "../components/Vault";
import { BudgetFilesCard } from "../components/BudgetFiles";
import { Field } from "../components/Fields";
import { ErrorText } from "../components/Modal";
import { applyScale, savedScale, SCALES, type Scale } from "../lib/scale";
import { api, type ScanResult } from "../lib/api";
import { pickFolder } from "../lib/files";
import { Hint } from "../components/Hint";
import { formatDate, today } from "../lib/dates";
import { useAppInfo, useCurrencies, useSettings } from "../lib/queries";
import { rateSource } from "../lib/rates";
import { useAction } from "../lib/useAction";
import { ScreenTitle } from "../components/SectionIcon";

export function Settings() {
  const info = useAppInfo();
  const settings = useSettings().data;
  const currencies = useCurrencies().data ?? [];
  const setHotkey = useAction(api.setQuickHotkey);
  const setSetting = useAction(api.setSetting);
  const base = settings?.base_currency ?? "RUB";
  const [dialog, setDialog] = useState<"summary" | "import" | null>(null);
  const [scale, setScale] = useState<Scale>(savedScale);

  return (
    <section className="screen">
      <ScreenTitle id="settings" />

      <div className="card">
        <h2>Общие</h2>
        <div className="settings-list">
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
          <Field label="Подсказки «?»" hint="Маленькие значки рядом с названиями: под мышкой — что делает функция.">
            {(id) => (
              <select id={id} name="hints" value={settings?.hints ?? "1"} onChange={(e) => setSetting.run("hints", e.target.value)}>
                <option value="1">Показывать</option>
                <option value="0">Скрыть</option>
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
          <Field
            label="Предупреждать о бюджете"
            hint={
              <>
                Уведомление, когда категория дошла до 80 % лимита и когда лимит превышен. <Hint of="budgetAlerts" />
              </>
            }
          >
            {(id) => (
              <button
                id={id}
                type="button"
                className="toggle-row"
                role="switch"
                aria-checked={(settings?.budget_alerts ?? "1") !== "0"}
                data-testid="budget-alerts"
                onClick={() => setSetting.run("budget_alerts", (settings?.budget_alerts ?? "1") !== "0" ? "0" : "1")}
              >
                <span className="switch" aria-hidden="true" />
                {(settings?.budget_alerts ?? "1") !== "0" ? "Включено" : "Выключено"}
              </button>
            )}
          </Field>
          <Field label="Напоминать о регулярных платежах" hint="Накануне списания подписки или связи приходит уведомление с суммой.">
            {(id) => (
              <select id={id} name="subsRemind" value={settings?.subs_remind ?? "1"} onChange={(e) => setSetting.run("subs_remind", e.target.value)}>
                <option value="1">за день</option>
                <option value="0">не напоминать</option>
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
          <Field label="Масштаб интерфейса" hint="«Авто» делает текст и кнопки крупнее, когда окно большое или развёрнуто на весь экран.">
            {(id) => (
              <select
                id={id}
                name="uiScale"
                value={scale}
                onChange={(e) => {
                  const next = e.target.value as Scale;
                  setScale(next);
                  applyScale(next);
                }}
              >
                {SCALES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
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
          <Field label="Быстрый ввод из любой программы" hint="Маленькое окно: «пятёрочка 1250» или текст SMS банка, Enter — записано.">
            {(id) => (
              <select id={id} name="quickHotkey" value={settings?.quick_hotkey ?? "Ctrl+Alt+P"} onChange={(e) => setHotkey.run(e.target.value)}>
                {["Ctrl+Alt+P", "Ctrl+Shift+Space", "Ctrl+Alt+N"].map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
                <option value="">Выключен</option>
              </select>
            )}
          </Field>
        </div>
        <ErrorText error={setSetting.error ?? setHotkey.error} />
      </div>

      <Rates base={base} />

      <div className="card" data-testid="data-card">
        <h2>
          Данные
          <Hint of="data" />
        </h2>
        <p className="muted">Сводка за период в Excel, загрузка операций из CSV. Список операций и отчёты выгружаются кнопкой «Выгрузить» на своих экранах.</p>
        <div className="btn-group">
          <button className="btn primary" onClick={() => setDialog("summary")}>
            Сводка в Excel
          </button>
          <button className="btn" onClick={() => setDialog("import")}>
            Импорт выписки или CSV
          </button>
        </div>
      </div>
      <AutoImportCard />
      {dialog === "summary" && <SummaryDialog onClose={() => setDialog(null)} />}
      {dialog === "import" && <ImportDialog onClose={() => setDialog(null)} />}

      <VaultCard />
      <BudgetFilesCard />
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
  const autoRates = useSettings().data?.rates_auto !== "0";
  const toggleAuto = useAction(api.setSetting);
  const add = useAction(api.setRate, () => setRate(""));
  const remove = useAction(api.deleteRate);
  const symbol = (code: string) => currencies.find((c) => c.code === code)?.symbol ?? code;
  const list = rates.data ?? [];
  const shown = all ? list : list.slice(0, RATES_SHOWN);

  return (
    <div className="card" data-testid="rates-card">
      <h2>
        Курсы валют
        <Hint of="rates" />
      </h2>
      <p className="muted">
        Курс к основной валюте на дату. Для пересчёта берётся последний известный курс на день операции.
      </p>
      <div className="rates-block">
        <h3>Официальный курс ЦБ РФ</h3>
        <div className="inline-form">
          <input type="date" aria-label="Дата курсов ЦБ" name="cbrDate" value={cbrDate} max={today()} onChange={(e) => setCbrDate(e.target.value)} />
          <CbrButton date={cbrDate} />
        </div>
        <p className="hint">Загружаются курсы доллара, евро, юаня, фунта, тенге и всех валют ваших счетов и долгов с сайта cbr.ru. Нужен интернет.</p>
        <label className="check small">
          <input type="checkbox" name="ratesAuto" checked={autoRates} onChange={(e) => toggleAuto.run("rates_auto", e.target.checked ? "1" : "0")} />
          Обновлять курсы сами раз в день (при запуске и пока программа открыта)
        </label>
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
          <button className="btn" type="submit" aria-busy={add.busy} data-done={add.done || undefined} disabled={add.busy || !rate.trim()}>
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

/** Импорт из папки: новые CSV по шаблону забираются сами, раз в 5 минут. */
function AutoImportCard() {
  const settings = useSettings().data;
  const on = settings?.auto_import === "1";
  const dir = useQuery({ queryKey: ["autoImportDir", settings?.auto_import_dir], queryFn: api.autoImportDir, retry: false });
  const set = useAction(api.setSetting);
  const choose = useAction(async () => {
    const p = await pickFolder();
    if (p) await api.setSetting("auto_import_dir", p);
  });
  const [result, setResult] = useState<ScanResult | null>(null);
  const now = useAction(api.autoImportNow, setResult);
  return (
    <div className="card" data-testid="auto-import">
      <h2>
        Импорт из папки
        <Hint title="Импорт из папки" example="скачали выписку Т-Банка в Загрузки — через пару минут операции в приложении">
          Раз в 5 минут приложение смотрит в папку и забирает новые выписки Сбера и Т-Банка и CSV по шаблону. Счёт для выписки банка берётся тот, что выбран при первом импорте через «Импорт выписки или CSV». Каждый файл — один раз, уже записанные операции пропускаются, другие файлы не трогаются.
        </Hint>
      </h2>
      <label className="check">
        <input type="checkbox" name="autoImport" checked={on} onChange={(e) => set.run("auto_import", e.target.checked ? "1" : "0")} />
        Забирать новые файлы сами
      </label>
      <p className="hint" data-testid="auto-import-dir">
        {dir.data ? `Папка: ${dir.data}` : dir.error ? String(dir.error) : "…"}
      </p>
      <div className="btn-group">
        <button className="btn" onClick={() => choose.run()} disabled={choose.busy}>
          Выбрать папку
        </button>
        {settings?.auto_import_dir && (
          <button className="btn" onClick={() => set.run("auto_import_dir", "")}>
            Вернуть «Загрузки»
          </button>
        )}
        <button className="btn primary" onClick={() => now.run()} aria-busy={now.busy} data-done={now.done || undefined} disabled={now.busy || !dir.data}>
          Проверить сейчас
        </button>
      </div>
      {result && (
        <p className={result.files.some((f) => f.error) ? "hint warn" : "ok"} data-testid="auto-import-result">
          {result.files.length === 0
            ? "Новых файлов по шаблону нет."
            : result.files.map((f) => (f.error ? `${f.name}: ${f.error}` : `${f.name}: добавлено ${f.added}, пропущено ${f.skipped}`)).join(" · ")}
        </p>
      )}
      <ErrorText error={set.error ?? choose.error ?? now.error} />
    </div>
  );
}
