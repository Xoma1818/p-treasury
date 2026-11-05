import { LeadDaysPicker, parseLead } from "../components/Reminders";
import { TxnFormCard } from "../components/TxnFormCard";
import { NavCard } from "../components/NavCard";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { CbrButton } from "../components/CbrButton";
import { ImportDialog, SummaryDialog, UpdatesCard } from "../components/DataTools";
import { ImportHistoryDialog } from "../components/ImportHistory";
import { VaultCard } from "../components/Vault";
import { HomeCardsCard } from "../components/HomeCards";
import { BudgetFilesCard } from "../components/BudgetFiles";
import { Field } from "../components/Fields";
import { ErrorText } from "../components/Modal";
import { applyScale, savedScale, SCALES, type Scale } from "../lib/scale";
import { ACCENTS, applyLook, DENSITIES, savedLook, type Density, type Look } from "../lib/look";
import { savedTxnOpen, saveTxnOpen, type TxnOpen } from "../lib/txnOpen";
import { useUi } from "../lib/store";
import { ModulesCard } from "../components/ModulesCard";
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
  const [dialog, setDialog] = useState<"summary" | "import" | "history" | null>(null);
  const [scale, setScale] = useState<Scale>(savedScale);
  const [look, setLook] = useState<Look>(savedLook);
  const setLookNow = (l: Look) => (setLook(l), applyLook(l));
  const [txnOpen, setTxnOpen] = useState<TxnOpen>(savedTxnOpen);
  // Г1: из Ctrl+K — прокрутить к разделу, поставить курсор в поле, открыть окно «Данных».
  const jump = useUi((s) => s.settingsJump);
  useEffect(() => {
    if (!jump) return;
    useUi.setState({ settingsJump: null });
    if (jump.dialog) setDialog(jump.dialog);
    requestAnimationFrame(() => {
      document.getElementById(`set-${jump.section}`)?.scrollIntoView({ block: "start" });
      const f = jump.field ? document.querySelector<HTMLElement>(`[name="${jump.field}"]`) : null;
      f?.focus({ preventScroll: true });
    });
  }, [jump]);

  return (
    <section className="screen">
      <ScreenTitle id="settings" />

      <div className="settings-layout">
      <SettingsNav />
      <div className="settings-body">
      <div className="settings-section" id="set-general">
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
          <Field label="Своё напоминание о платеже — заранее" hint="Для новых и старых напоминаний без своих сроков; в сам день оно приходит всегда.">
            {() => (
              <LeadDaysPicker
                name="defaultLeadDays"
                value={parseLead(settings?.reminder_lead_days ?? "3,1")}
                onChange={(v) => setSetting.run("reminder_lead_days", v.join(","))}
              />
            )}
          </Field>
          <Field label="Проверять деньги на счёте перед платежом" hint="Если к расходу с выбранного счёта денег не хватит с учётом других платежей, придёт предупреждение.">
            {(id) => (
              <select
                id={id}
                name="fundsDays"
                value={settings?.reminder_funds_days ?? "3"}
                onChange={(e) => setSetting.run("reminder_funds_days", e.target.value)}
              >
                {[0, 1, 2, 3, 5, 7].map((d) => (
                  <option key={d} value={String(d)}>
                    {d === 0 ? "не проверять" : `за ${d} ${d === 1 ? "день" : d < 5 ? "дня" : "дней"}`}
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
          <Field label="Открывать операцию" hint="Панель справа показывает операцию рядом со списком и похожие операции; окно — как раньше, посередине.">
            {(id) => (
              <select
                id={id}
                name="txnOpen"
                value={txnOpen}
                onChange={(e) => {
                  const next = e.target.value as TxnOpen;
                  setTxnOpen(next);
                  saveTxnOpen(next);
                }}
              >
                <option value="panel">панелью справа</option>
                <option value="dialog">окном</option>
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
          <Field label="Плотность" hint="Компактно — больше строк на экране, просторно — крупнее отступы.">
            {(id) => (
              <select id={id} name="uiDensity" value={look.density} onChange={(e) => setLookNow({ ...look, density: e.target.value as Density })}>
                {DENSITIES.map((d) => (
                  <option key={d.value} value={d.value}>
                    {d.label}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Цвет акцента" hint="Цвет главных кнопок, ссылок и выделения. Мятный — фирменный.">
            {() => (
              <div className="accent-pick" role="group" aria-label="Цвет акцента" data-testid="accent-pick">
                {ACCENTS.map((a) => (
                  <button
                    key={a.value}
                    type="button"
                    className="accent-dot"
                    style={{ background: a.color }}
                    aria-label={a.label}
                    title={a.label}
                    aria-pressed={look.accent === a.value}
                    data-accent={a.value}
                    onClick={() => setLookNow({ ...look, accent: a.value })}
                  />
                ))}
              </div>
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
      </div>

      <div className="settings-section" id="set-home">
      <HomeCardsCard />
      </div>

      <div className="settings-section" id="set-modules">
      <ModulesCard />
      </div>

      <div className="settings-section" id="set-menu">
      <NavCard />
      <TxnFormCard />
      </div>

      <div className="settings-section" id="set-rates">
      <Rates base={base} />
      </div>

      <div className="settings-section" id="set-data">
      <div className="card" data-testid="data-card">
        <h2>
          Данные
          <Hint of="data" />
        </h2>
        <p className="muted">Сводка за период в Excel или CSV, загрузка операций из выписки, CSV или Excel. Список операций и отчёты выгружаются кнопкой «Выгрузить» на своих экранах.</p>
        <div className="btn-group">
          <button className="btn primary" onClick={() => setDialog("summary")}>
            Сводка в Excel
          </button>
          <button className="btn" onClick={() => setDialog("import")}>
            Импорт выписки или CSV
          </button>
          <button className="btn" data-testid="settings-import-history" onClick={() => setDialog("history")}>
            История импорта
          </button>
        </div>
      </div>
      <AutoImportCard />
      </div>
      {dialog === "summary" && <SummaryDialog onClose={() => setDialog(null)} />}
      {dialog === "import" && <ImportDialog onClose={() => setDialog(null)} />}
      {dialog === "history" && <ImportHistoryDialog onClose={() => setDialog(null)} />}

      <div className="settings-section" id="set-vault">
      <VaultCard />
      <BudgetFilesCard />
      </div>
      <div className="settings-section" id="set-updates">
      <UpdatesCard />
      </div>

      <div className="settings-section" id="set-about">
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
      </div>
      </div>
      </div>
    </section>
  );
}

/** П. 14: разделы Настроек слева. Все карточки остаются на одной странице,
 *  нажатие прокручивает к разделу, при прокрутке подсвечивается текущий. */
const SETTINGS_SECTIONS: [string, string][] = [
  ["general", "Общие"],
  ["home", "Главная"],
  ["modules", "Возможности"],
  ["menu", "Меню и форма"],
  ["rates", "Курсы"],
  ["data", "Данные"],
  ["vault", "Сохранность"],
  ["updates", "Обновления"],
  ["about", "О программе"],
];

function SettingsNav() {
  const [current, setCurrent] = useState("general");
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const seen = new Map<string, boolean>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) seen.set(e.target.id.slice(4), e.isIntersecting);
        const first = SETTINGS_SECTIONS.find(([id]) => seen.get(id));
        if (first) setCurrent(first[0]);
      },
      { rootMargin: "-10% 0px -60% 0px" },
    );
    for (const [id] of SETTINGS_SECTIONS) {
      const el = document.getElementById(`set-${id}`);
      if (el) io.observe(el);
    }
    return () => io.disconnect();
  }, []);
  return (
    <aside className="settings-nav" aria-label="Разделы настроек">
      {SETTINGS_SECTIONS.map(([id, label]) => (
        <button
          key={id}
          type="button"
          className={current === id ? "settings-nav-item active" : "settings-nav-item"}
          aria-current={current === id ? "true" : undefined}
          onClick={() => {
            setCurrent(id);
            document.getElementById(`set-${id}`)?.scrollIntoView({ behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
          }}
        >
          {label}
        </button>
      ))}
    </aside>
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

/** Импорт из папки: новые выписки и таблицы по шаблону забираются сами, раз в 5 минут. */
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
          Раз в 5 минут приложение смотрит в папку и забирает новые выписки Сбера и Т-Банка и таблицы по шаблону (CSV или Excel, в том числе выгрузку «Операций»). Счёт для выписки банка берётся тот, что выбран при первом импорте через «Импорт выписки или CSV». Каждый файл — один раз, уже записанные операции пропускаются, другие файлы не трогаются.
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
