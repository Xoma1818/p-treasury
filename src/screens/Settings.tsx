import { KeysCard } from "../components/KeysCard";
import { FineCard } from "../components/FineCard";
import { LeadDaysPicker, parseLead } from "../components/Reminders";
import { TxnFormCard } from "../components/TxnFormCard";
import { NavCard } from "../components/NavCard";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import { CbrButton } from "../components/CbrButton";
import { ImportDialog, SummaryDialog, UpdatesCard } from "../components/DataTools";
import { ImportHistoryDialog } from "../components/ImportHistory";
import { VaultCard } from "../components/Vault";
import { HomeCardsCard } from "../components/HomeCards";
import { BudgetFilesCard } from "../components/BudgetFiles";
import { Field } from "../components/Fields";
import { ErrorText } from "../components/Modal";
import { applyScale, savedScale, SCALES, type Scale } from "../lib/scale";
import { ACCENTS, applyLook, DENSITIES, PALETTES, useLook, type Density, type UiPalette } from "../lib/look";
import { savedTxnOpen, saveTxnOpen, type TxnOpen } from "../lib/txnOpen";
import { useUi } from "../lib/store";
import { ModulesCard } from "../components/ModulesCard";
import { api, type ScanResult } from "../lib/api";
import { pickFolder } from "../lib/files";
import { Hint } from "../components/Hint";
import { formatDate, formatDateTime, today } from "../lib/dates";
import { useCurrencies, useSettings } from "../lib/queries";
import { formatRate, rateSource } from "../lib/rates";
import { useAction } from "../lib/useAction";
import "./secondaryScreens.css";
import "./settings-navigation.css";

export function Settings() {
  const settings = useSettings().data;
  const currencies = useCurrencies().data ?? [];
  const setHotkey = useAction(api.setQuickHotkey);
  const setSetting = useAction(api.setSetting);
  const base = settings?.base_currency ?? "RUB";
  const [dialog, setDialog] = useState<"summary" | "import" | "history" | null>(null);
  const [scale, setScale] = useState<Scale>(savedScale);
  const look = useLook();
  const [txnOpen, setTxnOpen] = useState<TxnOpen>(savedTxnOpen);
  const [topic, setTopic] = useState<TopicId>("general");
  const jump = useUi((s) => s.settingsJump);
  const selectTopic = (next: TopicId) => {
    if (next === topic) return;
    setTopic(next);
    const heading = document.getElementById("settings-heading");
    if (heading && heading.getBoundingClientRect().top < 0) heading.scrollIntoView({ block: "start" });
  };

  // Старые ссылки из поиска могут указывать на «general» даже для перенесённого поля.
  // Определяем тему по самому контролу, чтобы адреса не зависели от компоновки.
  useLayoutEffect(() => {
    if (!jump) return;
    const section = document.getElementById(`set-${jump.section}`);
    const field = jump.field ? document.querySelector<HTMLElement>(`.settings-screen [name="${CSS.escape(jump.field)}"]`) : null;
    const target = field ?? section;
    const panelId = target?.closest('[role="tabpanel"]')?.id;
    const destination = TOPICS.find(([id]) => panelId === `settings-panel-${id}`)?.[0];
    if (destination && topic !== destination) {
      setTopic(destination);
      return;
    }
    useUi.setState({ settingsJump: null });
    if (jump.dialog) {
      setDialog(jump.dialog);
    } else if (target) {
      if (target instanceof HTMLDetailsElement) target.open = true;
      const focusTarget = target instanceof HTMLDetailsElement ? target.querySelector("summary") ?? target : target;
      focusTarget.scrollIntoView({ block: "nearest" });
      focusTarget.focus({ preventScroll: true });
    }
  }, [jump, topic]);

  // Импорт и сводку можно открыть и из Ctrl+K. При закрытии у обоих путей
  // есть видимая кнопка, с которой пользователь может продолжить работу.
  const closeDialog = () => {
    setDialog(null);
    document.querySelector<HTMLElement>(`[data-settings-dialog="${dialog}"]`)?.focus();
  };
  useEffect(() => {
    if (!dialog) return;
    const modal = document.querySelector<HTMLElement>('.settings-screen [role="dialog"]');
    if (modal && !modal.contains(document.activeElement)) modal.querySelector<HTMLElement>("button")?.focus();
  }, [dialog]);

  return (
    <section className="screen secondary-screen settings-screen">
      <h1 id="settings-heading" className="settings-heading">Настройки <Hint of="section.settings" /></h1>
      <SettingsNav current={topic} onSelect={selectTopic} />
      <ErrorText error={setSetting.error ?? setHotkey.error} />
      <SettingsPanel topic="general" selected={topic}>
        <div id="set-general" className="settings-section card" tabIndex={-1}>
          <h2>Параметры бюджета</h2>
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
            <Field label="Начало бюджетного месяца" hint="Можно считать месяц со дня зарплаты.">
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
            <Field label="Формат даты">
              {(id) => (
                <select id={id} name="dateFormat" value={settings?.date_format ?? "DD.MM.YYYY"} onChange={(e) => setSetting.run("date_format", e.target.value)}>
                  <option value="DD.MM.YYYY">ДД.ММ.ГГГГ</option>
                  <option value="YYYY-MM-DD">ГГГГ-ММ-ДД</option>
                </select>
              )}
            </Field>
          </div>
        </div>
        <div id="set-rates" className="settings-section" tabIndex={-1}>
          <Rates base={base} />
        </div>
      </SettingsPanel>

      <SettingsPanel topic="notifications" selected={topic}>
        <div id="set-notifications" className="settings-section card" tabIndex={-1}>
          <h2>Платежи и лимиты</h2>
          <div className="settings-list">
            <Field label="Платежи по долгам" hint="Уведомление приходит в 9:00.">
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
            <Field label="Сроки напоминаний" hint="Если у платежа нет своих сроков. В день платежа напоминание придёт всегда.">
              {(id) => (
                <LeadDaysPicker
                  inputId={id}
                  name="defaultLeadDays"
                  value={parseLead(settings?.reminder_lead_days ?? "3,1")}
                  onChange={(v) => setSetting.run("reminder_lead_days", v.join(","))}
                />
              )}
            </Field>
            <Field label="Проверка остатка до платежа" hint="Предупредить, если на счёте не хватит денег с учётом других платежей.">
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
            <Field label="Регулярные платежи" hint="Напоминание о подписках и других регулярных списаниях.">
              {(id) => (
                <select id={id} name="subsRemind" value={settings?.subs_remind ?? "1"} onChange={(e) => setSetting.run("subs_remind", e.target.value)}>
                  <option value="1">за день</option>
                  <option value="0">не напоминать</option>
                </select>
              )}
            </Field>
          </div>
        </div>
      </SettingsPanel>

      <SettingsPanel topic="appearance" selected={topic}>
        <div id="set-appearance" className="settings-section card" tabIndex={-1}>
          <h2>Вид интерфейса</h2>
          <div className="settings-list">
            <Field label="Палитра" hint="Цвета фона и карточек в светлой и тёмной теме.">
              {(id) => (
                <select id={id} name="uiPalette" value={look.palette} onChange={(e) => applyLook({ ...look, palette: e.target.value as UiPalette })}>
                  {PALETTES.map((p) => (
                    <option key={p.value} value={p.value}>{p.label}</option>
                  ))}
                </select>
              )}
            </Field>
            <Field label="Масштаб интерфейса" hint="«Авто» подбирает размер текста и кнопок по ширине окна.">
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
            <Field label="Плотность">
              {(id) => (
                <select id={id} name="uiDensity" value={look.density} onChange={(e) => applyLook({ ...look, density: e.target.value as Density })}>
                  {DENSITIES.map((d) => (
                    <option key={d.value} value={d.value}>
                      {d.label}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <div className="field">
              <span id="accent-label" className="label">Цвет акцента</span>
              <div className="accent-pick" role="group" aria-labelledby="accent-label" aria-describedby="accent-hint" data-testid="accent-pick">
                <button
                  type="button"
                  className="btn small palette-accent-button"
                  data-accent="palette"
                  aria-pressed={look.accent === "palette"}
                  onClick={() => applyLook({ ...look, accent: "palette" })}
                >
                  Цвет палитры
                </button>
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
                    onClick={() => applyLook({ ...look, accent: a.value })}
                  />
                ))}
              </div>
              <div id="accent-hint" className="hint">Цвет выделения, ссылок и основных кнопок.</div>
            </div>
            <Field label="Подсказки «?»" hint="Пояснения рядом с названиями и полями.">
              {(id) => (
                <select id={id} name="hints" value={settings?.hints ?? "1"} onChange={(e) => setSetting.run("hints", e.target.value)}>
                  <option value="1">Показывать</option>
                  <option value="0">Скрыть</option>
                </select>
              )}
            </Field>
          </div>
        </div>
        <div id="set-fine" className="settings-section" tabIndex={-1}>
          <FineCard />
        </div>
        <div id="set-home" className="settings-section" tabIndex={-1}>
          <HomeCardsCard />
        </div>
      </SettingsPanel>

      <SettingsPanel topic="controls" selected={topic}>
        <div id="set-controls" className="settings-section card" tabIndex={-1}>
          <h2>Окно и ввод операций</h2>
          <div className="settings-list">
            <Field label="Открывать операцию" hint="В боковой панели видны список и похожие операции.">
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
            <Field label="При закрытии окна" hint="В трее приложение продолжает присылать напоминания.">
              {(id) => (
                <select id={id} name="closeToTray" value={settings?.close_to_tray ?? "1"} onChange={(e) => setSetting.run("close_to_tray", e.target.value)}>
                  <option value="1">Сворачивать в трей</option>
                  <option value="0">Закрывать приложение</option>
                </select>
              )}
            </Field>
            <Field label="Быстрый ввод из любой программы" hint="Открывает ввод операции поверх других программ.">
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
        </div>
        <div id="set-menu" className="settings-section" tabIndex={-1}>
          <NavCard />
          <TxnFormCard />
        </div>
        <div id="set-modules" className="settings-section" tabIndex={-1}>
          <ModulesCard />
        </div>
        <div id="set-keys" className="settings-section" tabIndex={-1}>
          {topic === "controls" && <KeysCard />}
        </div>
      </SettingsPanel>

      <SettingsPanel topic="data" selected={topic}>
        <div id="set-data" className="settings-section" tabIndex={-1}>
          <div className="card" data-testid="data-card">
            <h2>
              Импорт и экспорт
              <Hint of="data" />
            </h2>
            <p className="muted">Загрузите выписку или сохраните сводку за период.</p>
            <div className="btn-group">
              <button className="btn primary" data-settings-dialog="summary" onClick={() => setDialog("summary")}>
                Сводка в Excel
              </button>
              <button className="btn" data-settings-dialog="import" onClick={() => setDialog("import")}>
                Импорт выписки или CSV
              </button>
              <button className="btn" data-testid="settings-import-history" data-settings-dialog="history" onClick={() => setDialog("history")}>
                История импорта
              </button>
            </div>
          </div>
          <AutoImportCard />
        </div>
        <div id="set-vault" className="settings-section" tabIndex={-1}>
          <VaultCard active={topic === "data"} />
          <BudgetFilesCard />
        </div>
      </SettingsPanel>

      <SettingsPanel topic="about" selected={topic}>
        <div id="set-about" className="settings-section" tabIndex={-1}>
          <UpdatesCard active={topic === "about"} />
        </div>
      </SettingsPanel>

      {dialog === "summary" && <SummaryDialog onClose={closeDialog} />}
      {dialog === "import" && <ImportDialog onClose={closeDialog} />}
      {dialog === "history" && <ImportHistoryDialog onClose={closeDialog} />}
    </section>
  );
}

const TOPICS = [
  ["general", "Бюджет и валюта"],
  ["notifications", "Уведомления"],
  ["appearance", "Оформление"],
  ["controls", "Меню и ввод"],
  ["data", "Данные и копии"],
  ["about", "О программе"],
] as const;

type TopicId = (typeof TOPICS)[number][0];

function SettingsNav({ current, onSelect }: { current: TopicId; onSelect: (id: TopicId) => void }) {
  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const last = TOPICS.length - 1;
    let next: number;
    switch (event.key) {
      case "ArrowLeft": next = index === 0 ? last : index - 1; break;
      case "ArrowRight": next = index === last ? 0 : index + 1; break;
      case "Home": next = 0; break;
      case "End": next = last; break;
      default: return;
    }
    event.preventDefault();
    const [id] = TOPICS[next];
    onSelect(id);
    document.getElementById(`settings-tab-${id}`)?.focus();
  };
  return (
    <div className="settings-topics" role="tablist" aria-label="Разделы настроек">
      {TOPICS.map(([id, title], index) => (
        <button
          key={id}
          id={`settings-tab-${id}`}
          data-testid={`settings-tab-${id}`}
          type="button"
          role="tab"
          aria-controls={`settings-panel-${id}`}
          aria-selected={current === id}
          tabIndex={current === id ? 0 : -1}
          onClick={() => onSelect(id)}
          onKeyDown={(event) => move(event, index)}
        >
          {title}
        </button>
      ))}
    </div>
  );
}

function SettingsPanel({ topic, selected, children }: { topic: TopicId; selected: TopicId; children: ReactNode }) {
  return (
    <div id={`settings-panel-${topic}`} className="settings-panel" role="tabpanel" aria-labelledby={`settings-tab-${topic}`} hidden={selected !== topic}>
      {children}
    </div>
  );
}

const RATES_SHOWN = 12;

/** Сегодняшняя дата, которая сама меняется после полуночи, пока экран открыт. */
function useToday(): string {
  const [day, setDay] = useState(today);
  useEffect(() => {
    const timer = setInterval(() => setDay(today()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return day;
}

function Rates({ base }: { base: string }) {
  const currencies = useCurrencies().data ?? [];
  const now = useToday();
  const rates = useQuery({ queryKey: ["rates"], queryFn: api.listRates });
  const overview = useQuery({ queryKey: ["ratesOverview", now, base], queryFn: () => api.ratesOverview(now) });
  // null — «сегодня»: дата берётся в момент нажатия, а не при открытии экрана.
  const [cbrDate, setCbrDate] = useState<string | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [from, setFrom] = useState("USD");
  const [rate, setRate] = useState("");
  const [history, setHistory] = useState(false);
  const [all, setAll] = useState(false);
  const autoRates = useSettings().data?.rates_auto !== "0";
  const toggleAuto = useAction(api.setSetting);
  const add = useAction(api.setRate, () => setRate(""));
  const remove = useAction(api.deleteRate);
  const symbol = (code: string) => currencies.find((c) => c.code === code)?.symbol ?? code;
  const choices = currencies.filter((c) => c.code !== base);
  // Основная валюта убрана из списка: если она была выбрана, берём первую из оставшихся.
  const fromCode = choices.some((c) => c.code === from) ? from : (choices[0]?.code ?? "");
  const list = rates.data ?? [];
  const shown = all ? list : list.slice(0, RATES_SHOWN);
  // Курс и его единица — из одного ответа: пока после смены основной валюты
  // идёт новый запрос, старые числа не подписываются новым символом.
  const fresh = overview.data?.base === base ? overview.data : undefined;
  const current = fresh?.rates ?? [];
  const checkedAt = overview.data?.checkedAt;

  return (
    <div className="card" data-testid="rates-card">
      <h2>
        Курсы валют
        <Hint of="rates" />
      </h2>
      <p className="muted">
        Курсы к основной валюте. Для операции берётся последний известный курс на её дату.
      </p>
      {current.length > 0 && (
        <div className="rates-table-scroll" role="region" aria-label="Действующие курсы валют" tabIndex={0}>
          <table className="table compact rates-table rates-now" data-testid="rates-now">
            <thead>
              <tr>
                <th scope="col">Валюта</th>
                <th scope="col" className="num">Действующий курс</th>
                <th scope="col">Действует с</th>
                <th scope="col">Источник</th>
              </tr>
            </thead>
            <tbody>
              {current.map((r) => (
                <tr key={r.code} data-code={r.code} data-source={r.source ?? undefined}>
                  <td>{r.code}</td>
                  <td className="num">{r.rate ? `1 ${r.code} = ${formatRate(r.rate)} ${symbol(fresh?.base ?? base)}` : <span className="muted">нет курса</span>}</td>
                  <td className="date">{r.date ? formatDate(r.date) : "—"}</td>
                  <td>{r.source ? <span className={r.source === "cbr" ? "badge good" : "badge"}>{rateSource(r.source)}</span> : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="hint" data-testid="rates-checked">
        {checkedAt ? `Последняя проверка ЦБ РФ: ${formatDateTime(checkedAt)}` : "Курсы ЦБ РФ ещё не загружались."}
      </p>
      <div className="rates-block">
        <h3>Официальный курс ЦБ РФ</h3>
        <div className="inline-form">
          <input type="date" aria-label="Дата курсов ЦБ" name="cbrDate" value={cbrDate ?? now} max={now} onChange={(e) => setCbrDate(e.target.value && e.target.value !== now ? e.target.value : null)} />
          <CbrButton date={cbrDate ?? undefined} />
        </div>
        <p className="hint">Загружаются курсы доллара, евро, юаня, фунта, тенге и всех валют ваших счетов и долгов с сайта cbr.ru. Нужен интернет.</p>
        <label className="check small">
          <input type="checkbox" name="ratesAuto" checked={autoRates} onChange={(e) => toggleAuto.run("rates_auto", e.target.checked ? "1" : "0")} />
          Обновлять курсы сами раз в день (при запуске и пока программа открыта)
        </label>
      </div>
      <div className="rates-block">
        <h3>Ввести вручную</h3>
        <form className="inline-form" onSubmit={(e) => (e.preventDefault(), add.run(date ?? today(), fromCode, base, rate))}>
          <input type="date" aria-label="Дата курса" name="rateDate" value={date ?? now} onChange={(e) => setDate(e.target.value && e.target.value !== now ? e.target.value : null)} />
          <span>1</span>
          <select aria-label="Валюта" name="rateFrom" value={fromCode} onChange={(e) => setFrom(e.target.value)}>
            {choices.map((c) => (
              <option key={c.code} value={c.code}>
                {c.code}
              </option>
            ))}
          </select>
          <span>=</span>
          <input aria-label="Курс" name="rate" className="amount" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="92,15" />
          <span>{symbol(base)}</span>
          <button className="btn" type="submit" aria-busy={add.busy} data-done={add.done || undefined} disabled={add.busy || !rate.trim() || !fromCode}>
            Добавить
          </button>
        </form>
        <p className="hint">Ручной курс на дату главнее курса ЦБ на ту же дату, в обе стороны пересчёта.</p>
        <ErrorText error={add.error ?? remove.error} />
      </div>
      {list.length > 0 && (
        <div className="rates-block">
          <button type="button" className="link" data-testid="rates-history-toggle" aria-expanded={history} onClick={() => setHistory(!history)}>
            {history ? "▾" : "▸"} История курсов ({list.length})
          </button>
          {history && (
            <>
              <div className="rates-table-scroll" role="region" aria-label="История курсов" tabIndex={0}>
                <table className="table compact rates-table" data-testid="rates">
                  <tbody>
                    {shown.map((r) => (
                      <tr key={`${r.date}-${r.fromCode}-${r.toCode}`} data-source={r.source}>
                        <td className="date">{formatDate(r.date)}</td>
                        <td>
                          1 {r.fromCode} = {formatRate(r.rate)} {symbol(r.toCode)}
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
              </div>
              {list.length > RATES_SHOWN && (
                <button className="link table-foot" onClick={() => setAll(!all)}>
                  {all ? "Свернуть" : `Показать все (${list.length})`}
                </button>
              )}
            </>
          )}
        </div>
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
