// Обновление 0.10, этап 3: имущество, поездки и события, общие траты, дни без трат
// и итог недели, своя Главная, перетаскивание. Сценарии из docs/product/mvp-features.md («Версия 0.10»).
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { start, stop, openSection, fill, choose, chooseLike, click, save, waitText, waitContent, money, openMore } from "./app.mjs";

const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = iso(new Date());

let browser;
before(async () => {
  ({ browser } = await start());
  // Форма общей траты высокая: окно побольше, чтобы кнопка «Сохранить» была видна.
  await browser.setWindowSize(1280, 1000);
  await browser.$("//h1[normalize-space()='Основная валюта']").waitForDisplayed({ timeout: 15000 });
  await click(browser, "Посмотреть на примере");
  await browser.$('//main//h1[normalize-space()="Главная"]').waitForDisplayed({ timeout: 10000 });
});
after(async () => {
  await stop(browser);
});

/** Перетаскивание мышью: WebDriver не умеет HTML5 drag-and-drop, поэтому события те же, что шлёт браузер. */
async function dragTo(source, target) {
  const ok = await browser.execute(
    (s, d) => {
      const src = document.querySelector(s);
      const dst = document.querySelector(d);
      if (!src || !dst) return false;
      const dt = new DataTransfer();
      src.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt }));
      dst.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: dt }));
      dst.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
      dst.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
      src.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt }));
      return true;
    },
    source,
    target,
  );
  assert.ok(ok, `нет элемента для перетаскивания: ${source} → ${target}`);
}

test("имущество: оценка входит в чистые активы на Главной", async () => {
  await waitText(browser, '[data-testid="home-net-worth"]', /Чистые активы с имуществом и долгами/);
  const before = await browser.$('[data-testid="home-net-worth"]').getText();
  await openSection(browser, "Счета");
  await waitText(browser, '[data-testid="assets"]', /Квартира[\s\S]*\+3 % с[\s\S]*9 800 000 ₽/);
  await click(browser, "+ Имущество");
  await fill(browser, "assetName", "Дача");
  await fill(browser, "assetValue", "2000000");
  await save(browser);
  await waitText(browser, '[data-testid="assets"]', /Дача[\s\S]*2 000 000 ₽/);
  await openSection(browser, "Главная");
  await browser.waitUntil(async () => (await browser.$('[data-testid="home-net-worth"]').getText()) !== before, { timeout: 5000 });
  // Пример данных строится от сегодняшнего дня, поэтому сверяем прирост, а не сумму.
  const rub = (t) => Number(t.replace(/[^\d,−-]/g, "").replace(",", ".").replace("−", "-"));
  const after = await browser.$('[data-testid="home-net-worth"]').getText();
  assert.equal(Math.round((rub(after) - rub(before)) * 100), 200000000, `${before} → ${after}`);
});

test("поездка: итог против бюджета, трата этих дней добавляется одной кнопкой", async () => {
  await openSection(browser, "Бюджет");
  const trip = '//*[@data-testid="event-row" and @data-name="Поездка в Казань"]';
  await waitText(browser, `${trip}//*[@data-testid="event-spent"]`, money("23 050 ₽ из 40 000 ₽"));
  await browser.$(`${trip}//*[@data-testid="event-add-all"]`).click();
  await browser.$(`${trip}//*[@data-testid="event-add-all"]`).waitForExist({ timeout: 5000, reverse: true });
  const spent = await waitText(browser, `${trip}//*[@data-testid="event-spent"]`, /из 40 000/);
  assert.doesNotMatch(spent, money("23 050 ₽"), "трата этих дней вошла в итог");
  const ops = await browser.$(`${trip}//button[starts-with(normalize-space(), "Операции:")]`);
  const n = Number((await ops.getText()).match(/\d+/)[0]);
  assert.ok(n > 4);
  await ops.click();
  await browser.$('//main//h1[normalize-space()="Операции"]').waitForDisplayed({ timeout: 5000 });
  await waitText(browser, '[data-testid="filter-event"]', /Поездка в Казань/);
  await waitText(browser, '[data-testid="txn-count"]', new RegExp(`Показано ${n} из ${n}`));
  await waitText(browser, "main", /Гостиница/);
});

test("событие на сегодня: расход отмечается в форме операции", async () => {
  await openSection(browser, "Бюджет");
  await click(browser, "+ Событие");
  await fill(browser, "eventName", "Ремонт кухни");
  await fill(browser, "eventBudget", "150000");
  await save(browser);
  await waitText(browser, '//*[@data-testid="event-row" and @data-name="Ремонт кухни"]', /идёт сейчас[\s\S]*0 ₽ из 150 000 ₽/);
  await openSection(browser, "Главная");
  await click(browser, "+ Расход");
  await fill(browser, "amount", "12500");
  await chooseLike(browser, "category", "Ремонт");
  await choose(browser, "event", "Ремонт кухни");
  await save(browser);
  await openSection(browser, "Бюджет");
  await waitText(browser, '//*[@data-testid="event-row" and @data-name="Ремонт кухни"]//*[@data-testid="event-spent"]', money("12 500 ₽ из 150 000 ₽"));
  // Трата события не входит в факт месячного бюджета, её итог показан отдельно.
  await waitText(browser, '[data-testid="budget-events"]', money("поездки и события отдельно: 12 500 ₽"));
});

test("общая трата за троих: своя доля — расход, доли друзей — долги «мне должны»", async () => {
  await openSection(browser, "Главная");
  const expense = await browser.$('[data-testid="month-expense"]').getText();
  await click(browser, "+ Расход");
  await fill(browser, "amount", "3000");
  await chooseLike(browser, "category", "Общепит");
  await fill(browser, "payee", "Пиццерия");
  await openMore(browser);
  await click(browser, "Разделить с друзьями");
  await fill(browser, "friend0", "Аня");
  await click(browser, "+ ещё человек");
  await fill(browser, "friend1", "Петя");
  await click(browser, "Поровну");
  await waitText(browser, '[data-testid="split-mine"]', money("Моя доля: 1 000 ₽"));
  await save(browser);
  await browser.waitUntil(async () => (await browser.$('[data-testid="month-expense"]').getText()) !== expense, { timeout: 5000 });
  await openSection(browser, "Займы и долги");
  await waitText(browser, "main", /Аня[\s\S]*1 000 ₽/);
  await waitText(browser, "main", /Петя[\s\S]*1 000 ₽/);
});

test("календарь: дни без трат отмечены, итог недели, операция перетаскивается на другой день", async () => {
  await openSection(browser, "Календарь");
  // В начале месяца дней без трат может ещё не быть (в примере траты 1–4-го, а сегодня
  // траты добавили прошлые тесты), тогда отметки проверяем в прошлом месяце и возвращаемся.
  await browser.$(`[data-testid="cal-day"][data-date="${today}"]`).waitForExist({ timeout: 5000 });
  if (!(await browser.$('[data-testid="no-spend"]').isExisting())) {
    await (await browser.$('button[aria-label="Предыдущий месяц"]')).click();
    await browser.$('[data-testid="no-spend"]').waitForExist({ timeout: 5000 });
    await (await browser.$('button[aria-label="Следующий месяц"]')).click();
    await browser.$(`[data-testid="cal-day"][data-date="${today}"]`).waitForExist({ timeout: 5000 });
  } else {
    await browser.$('[data-testid="no-spend"]').waitForExist({ timeout: 5000 });
  }
  await waitText(browser, '[data-testid="no-spend-card"]', /\d+ (день|дня|дней) в этом месяце/);
  await waitText(browser, '[data-testid="week-summary"]', /Итог прошлой недели[\s\S]*Расходы/);
  // Сегодняшнюю операцию переносим на вчера (если сегодня 1-е, вчера в другом месяце — пропускаем).
  const target = today.endsWith("-01") ? today : iso(new Date(Date.now() - 86400000));
  await browser.$(`[data-testid="cal-day"][data-date="${today}"]`).click();
  await browser.$('[data-testid="day-panel"] [data-testid="txn-row"]').waitForExist({ timeout: 5000 });
  const rows = async () => (await browser.$$('[data-testid="day-panel"] [data-testid="txn-row"]')).length;
  const n = await rows();
  if (target !== today) {
    await dragTo('[data-testid="day-panel"] tr.draggable', `[data-testid="cal-day"][data-date="${target}"]`);
    await browser.waitUntil(async () => (await rows()) === n - 1, { timeout: 5000, timeoutMsg: "операция не ушла с этого дня" });
    await browser.$(`[data-testid="cal-day"][data-date="${target}"]`).click();
    await waitText(browser, '[data-testid="day-panel"]', /Пиццерия|Ремонт|Общепит/);
  }
  await browser.$('[name="weeklySummary"]').click();
  await browser.waitUntil(async () => !(await browser.$('[name="weeklySummary"]').isSelected()), { timeout: 5000 });
});

/** Щелчок с повтором: список перерисовывается (поиск, обновление данных), и найденный узел устаревает. */
async function tap(sel) {
  for (let i = 0; ; i++) {
    try {
      const el = await browser.$(sel);
      await el.waitForClickable({ timeout: 5000 });
      return await el.click();
    } catch (e) {
      if (i >= 4 || !/stale|not found/i.test(String(e.message))) throw e;
      await browser.pause(200);
    }
  }
}

test("Главная: «+ Расход ▾» и операция панелью справа (0.30)", async () => {
  await openSection(browser, "Главная");
  // Доход и перевод — в меню у «+ Расход».
  assert.equal(await browser.$('//main//button[normalize-space()="+ Доход"]').isExisting(), false, "доход спрятан в меню");
  await tap('[data-testid="add-menu-toggle"]');
  await tap('//*[@role="menu"]//button[normalize-space()="+ Доход"]');
  await browser.$('[role="dialog"]').waitForDisplayed({ timeout: 5000 });
  await browser.keys("Escape");
  await browser.$('[role="dialog"]').waitForExist({ reverse: true, timeout: 5000 });
  // Существующая операция — панелью справа, с похожими операциями.
  await openSection(browser, "Операции");
  // Пример заполняет месяц по дням: за весь срок у «Пятёрочки» точно несколько покупок.
  await tap('//*[@data-testid="period"]//button[normalize-space()="Всё время"]');
  await fill(browser, "search", "Пятёрочка");
  await browser.waitUntil(
    async () => browser.execute(() => {
      const rows = [...document.querySelectorAll('[data-testid="txn-row"]')];
      return rows.length > 1 && rows.every((r) => r.textContent.includes("Пятёрочка"));
    }),
    { timeout: 5000 },
  );
  await tap('[data-testid="txn-row"] td.date');
  await browser.$('[role="dialog"][data-side="true"]').waitForDisplayed({ timeout: 5000 });
  await browser.$('[data-testid="similar-txns"] li button').waitForDisplayed({ timeout: 5000 });
  // Несохранённая правка: переход к похожей сначала спрашивает, «Остаться» оставляет форму.
  await fill(browser, "amount", "77");
  await tap('[data-testid="similar-txns"] li button');
  await browser.$('[data-testid="similar-confirm"]').waitForDisplayed({ timeout: 5000 });
  await tap('//*[@data-testid="similar-confirm"]//button[normalize-space()="Остаться"]');
  assert.equal(await (await browser.$('[role="dialog"] [name="amount"]')).getValue(), "77", "правка на месте");
  await browser.keys("Escape");
  await tap('//*[@data-testid="unsaved-ask"]//button[normalize-space()="Закрыть"]');
  await browser.$('[role="dialog"]').waitForExist({ reverse: true, timeout: 5000 });
  // В Настройках можно вернуть окно.
  await openSection(browser, "Настройки");
  await choose(browser, "txnOpen", "окном");
  await openSection(browser, "Операции");
  await tap('[data-testid="txn-row"] td.date');
  await browser.$('[role="dialog"]').waitForDisplayed({ timeout: 5000 });
  assert.equal(await browser.$('[role="dialog"]').getAttribute("data-side"), null, "окно посередине");
  await browser.keys("Escape");
  await browser.$('[role="dialog"]').waitForExist({ reverse: true, timeout: 5000 });
  await openSection(browser, "Настройки");
  await choose(browser, "txnOpen", "панелью справа");
});

test("Отчёты «Ещё ▾», «⋯» у счёта и разделы Настроек (0.30)", async () => {
  await openSection(browser, "Отчёты");
  // Четыре главных отчёта видны, остальные — в «Ещё ▾»; выбранный встаёт на место кнопки.
  assert.equal(await browser.$('//*[@role="tablist"]//button[normalize-space()="Итоги года"]').isExisting(), false);
  await tap('[data-testid="more-tabs-toggle"]');
  await tap('//*[@role="menu"]//button[normalize-space()="Итоги года"]');
  await waitText(browser, '[data-testid="more-tabs-toggle"]', /Итоги года/);
  await click(browser, "Структура", '//*[@role="tablist"]');
  await waitText(browser, '[data-testid="more-tabs-toggle"]', /Ещё/);
  // Счета: «Изменить» и «Закрыть счёт» — в меню «⋯».
  await openSection(browser, "Счета");
  await tap('[data-testid="account-row"] [data-testid="row-menu"]');
  await tap('//*[@role="menu"]//button[normalize-space()="Изменить"]');
  await browser.$('[role="dialog"]').waitForDisplayed({ timeout: 5000 });
  await browser.keys("Escape");
  await browser.$('[role="dialog"]').waitForExist({ reverse: true, timeout: 5000 });
  // Настройки: раздел слева прокручивает к своей карточке.
  await openSection(browser, "Настройки");
  await tap('//aside[@aria-label="Разделы настроек"]//button[normalize-space()="О программе"]');
  await browser.waitUntil(
    async () => browser.execute(() => {
      const r = document.getElementById("set-about").getBoundingClientRect();
      return r.top < innerHeight && r.bottom > 0;
    }),
    { timeout: 5000, timeoutMsg: "«О программе» не видно" },
  );
});

test("Ctrl+K находит настройку и действие, правая кнопка, «Возможности» (0.30)", async () => {
  // Ctrl+K: «формат даты» ведёт в Настройки к полю; «тема» переключает тему.
  await openSection(browser, "Главная");
  await browser.keys(["Control", "k"]);
  await browser.$('[data-testid="palette"]').waitForDisplayed({ timeout: 3000 });
  await fill(browser, "paletteQuery", "формат даты");
  await waitContent(browser, '[data-testid="palette"]', /Настройки[\s\S]*Формат даты/i);
  await browser.keys("Enter");
  await browser.$('//main//h1[normalize-space()="Настройки"]').waitForDisplayed({ timeout: 5000 });
  await browser.waitUntil(async () => (await browser.execute(() => document.activeElement?.getAttribute("name"))) === "dateFormat", { timeout: 5000, timeoutMsg: "курсор не в поле формата даты" });
  const before = await browser.execute(() => document.documentElement.dataset.theme);
  await browser.keys(["Control", "k"]);
  await browser.$('[data-testid="palette"]').waitForDisplayed({ timeout: 3000 });
  await fill(browser, "paletteQuery", "тема");
  await waitContent(browser, '[data-testid="palette"]', /Действия[\s\S]*тема/i);
  await browser.keys("Enter");
  await browser.waitUntil(async () => (await browser.execute(() => document.documentElement.dataset.theme)) !== before, { timeout: 3000, timeoutMsg: "тема не сменилась" });
  await tap(before === "dark" ? '[data-testid="theme-dark"]' : '[data-testid="theme-light"]');
  // Правая кнопка по операции: меню с действиями, «Открыть» открывает её.
  await openSection(browser, "Операции");
  await browser.$('[data-testid="txn-row"]').waitForExist({ timeout: 5000 });
  await browser.execute(() => {
    const r = document.querySelector('[data-testid="txn-row"] td.date');
    const b = r.getBoundingClientRect();
    r.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: b.x + 5, clientY: b.y + 5 }));
  });
  await browser.$('[data-testid="context-menu"]').waitForDisplayed({ timeout: 3000 });
  await waitText(browser, '[data-testid="context-menu"]', /Открыть[\s\S]*(Удалить|Открыть долг)/);
  await tap('//*[@data-testid="context-menu"]//button[normalize-space()="Открыть"]');
  await browser.$('[role="dialog"]').waitForDisplayed({ timeout: 5000 });
  await browser.keys("Escape");
  await browser.$('[role="dialog"]').waitForExist({ reverse: true, timeout: 5000 });
  // «Возможности»: выключенные «Заметки» пропадают из меню и возвращаются.
  await openSection(browser, "Настройки");
  await tap('[name="module-notes"]');
  await browser.$('//nav//button[normalize-space()="Заметки"]').waitForExist({ reverse: true, timeout: 5000 });
  await tap('[data-testid="modules-all"]');
  await browser.$('//nav//button[normalize-space()="Заметки"]').waitForExist({ timeout: 5000 });
});

test("своё меню и главная кнопка «+»: скрыть, переставить, вернуть как было (0.31)", async () => {
  await openSection(browser, "Настройки");
  await browser.$('[data-testid="nav-card"]').waitForExist({ timeout: 5000 });
  try {
    // Скрыть «Календарь»: пропадает из меню.
    await tap('[name="nav-calendar"]');
    await browser.$('//nav//button[normalize-space()="Календарь"]').waitForExist({ reverse: true, timeout: 5000 });
    // «Счета» выше «Бюджета»: порядок меню меняется.
    await tap('[data-testid="nav-order-accounts"] button[aria-label="Счета: выше"]');
    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const t = [...document.querySelectorAll('[data-testid="nav-list"] .nav-item')].map((b) => b.textContent.trim());
          return t.indexOf("Счета") >= 0 && t.indexOf("Счета") < t.indexOf("Взгляд вперёд");
        }),
      { timeout: 5000, timeoutMsg: "Счета не поднялись в меню" },
    );
    // Главная кнопка — перевод; расход уходит в меню ▾.
    await choose(browser, "addMain", "Перевод");
    await openSection(browser, "Главная");
    await waitContent(browser, '[data-testid="add-main"]', /Перевод/);
    await tap('[data-testid="add-menu-toggle"]');
    await waitContent(browser, '[data-testid="add-menu"] [role="menu"]', /Расход[\s\S]*Доход/);
    await browser.keys("Escape");
  } finally {
    // «Как было» возвращает всё, даже если проверка выше упала: остальные тесты ждут «+ Расход».
    await openSection(browser, "Настройки");
    await tap('[data-testid="nav-reset"]');
    await browser.$('//nav//button[normalize-space()="Календарь"]').waitForExist({ timeout: 5000 });
    await openSection(browser, "Главная");
  }
  await waitContent(browser, '[data-testid="add-main"]', /Расход/);
  // Следующий тест начинает с перехода на Главную, как и раньше — из Настроек.
  await openSection(browser, "Настройки");
});

test("форма операции: комментарий без «Ещё», свой счёт по умолчанию (0.31)", async () => {
  await openSection(browser, "Настройки");
  await browser.$('[data-testid="txn-form-card"]').waitForExist({ timeout: 5000 });
  try {
    await tap('[name="pinNote"]');
    // Счёт по умолчанию — последний в списке (не тот, что подставился бы сам).
    const want = await browser.execute(() => {
      const sel = document.querySelector('[name="formAccount"]');
      const opt = sel.options[sel.options.length - 1];
      return opt.value;
    });
    const sel = await browser.$('[name="formAccount"]');
    await sel.selectByAttribute("value", want);
    await openSection(browser, "Главная");
    await click(browser, "+ Расход");
    await browser.$('[role="dialog"] [name="note"]').waitForDisplayed({ timeout: 5000 });
    assert.equal(await (await browser.$('[role="dialog"] [name="account"]')).getValue(), want, "счёт из настройки");
    await browser.keys("Escape");
    await browser.$('[role="dialog"]').waitForExist({ reverse: true, timeout: 5000 });
  } finally {
    if (await browser.$('[role="dialog"]').isExisting()) await browser.keys("Escape");
    await openSection(browser, "Настройки");
    const reset = await browser.$('[data-testid="txn-form-reset"]');
    if (await reset.isExisting()) await tap('[data-testid="txn-form-reset"]');
  }
  await browser.$('[data-testid="txn-form-reset"]').waitForExist({ reverse: true, timeout: 5000 });
});

test("своя шапка «Операций»: выписку в «⋯», шаблон в шапку, как было (0.32)", async () => {
  await openSection(browser, "Операции");
  await browser.$('[data-testid="txn-import"]').waitForExist({ timeout: 5000 });
  try {
    await tap('[data-testid="head-more"]');
    await tap('[data-head="import"]');
    await browser.$('[data-testid="txn-import"]').waitForExist({ reverse: true, timeout: 5000 });
    // Скрытая кнопка не пропала: она в «⋯» и открывает то же окно.
    await tap('//*[@data-testid="head-menu"]//button[@role="menuitem" and normalize-space()="Загрузить выписку"]');
    await browser.$('[role="dialog"]').waitForDisplayed({ timeout: 5000 });
    await browser.keys("Escape");
    await browser.$('[role="dialog"]').waitForExist({ reverse: true, timeout: 5000 });
    // Шаблон из примера — кнопкой в шапке.
    await tap('[data-testid="head-more"]');
    const tpl = await browser.$('[data-testid="head-menu"] [data-head^="tpl:"]');
    if (await tpl.isExisting()) {
      await tpl.click();
      await browser.$('[data-testid="head-template"]').waitForExist({ timeout: 5000 });
    }
  } finally {
    if (await browser.$('[role="dialog"]').isExisting()) await browser.keys("Escape");
    if (!(await browser.$('[data-testid="head-menu"]').isExisting())) await tap('[data-testid="head-more"]');
    const reset = await browser.$('[data-testid="head-reset"]');
    if (await reset.isExisting()) await reset.click();
  }
  await browser.$('[data-testid="txn-import"]').waitForExist({ timeout: 5000 });
  assert.equal(await browser.$('[data-testid="head-template"]').isExisting(), false);
  await browser.keys("Escape");
  await openSection(browser, "Настройки");
});

test("вид: компактно и синий акцент сразу видны, возвращаются обратно (0.32)", async () => {
  await openSection(browser, "Настройки");
  await browser.$('[data-testid="accent-pick"]').waitForExist({ timeout: 5000 });
  const attr = (name) => browser.execute((n) => document.documentElement.dataset[n] ?? "", name);
  try {
    await tap('[data-testid="accent-pick"] [data-accent="blue"]');
    await browser.waitUntil(async () => (await attr("accent")) === "blue", { timeout: 5000, timeoutMsg: "акцент не сменился" });
    await (await browser.$('[name="uiDensity"]')).selectByAttribute("value", "compact");
    await browser.waitUntil(async () => (await attr("density")) === "compact", { timeout: 5000, timeoutMsg: "плотность не сменилась" });
  } finally {
    await tap('[data-testid="accent-pick"] [data-accent="mint"]');
    await (await browser.$('[name="uiDensity"]')).selectByAttribute("value", "normal");
  }
  await browser.waitUntil(async () => (await attr("accent")) === "" && (await attr("density")) === "", { timeout: 5000, timeoutMsg: "вид не вернулся" });
});

test("Главная: карточка в половину ширины и обратно (0.32)", async () => {
  await openSection(browser, "Главная");
  const tiles = '[data-block="tiles"]';
  await browser.$(tiles).waitForExist({ timeout: 5000 });
  const isHalf = () => browser.execute((sel) => document.querySelector(sel)?.classList.contains("half") ?? false, tiles);
  await click(browser, "Настроить Главную");
  try {
    await tap(`${tiles} [data-testid="home-half"]`);
    await browser.waitUntil(isHalf, { timeout: 5000, timeoutMsg: "карточка не стала половинной" });
    await tap('[data-testid="home-customize"]');
    await browser.waitUntil(isHalf, { timeout: 5000, timeoutMsg: "после «Готово» карточка во всю ширину" });
    await click(browser, "Настроить Главную");
  } finally {
    if (await isHalf()) await tap(`${tiles} [data-testid="home-half"]`);
    await browser.waitUntil(async () => !(await isHalf()), { timeout: 5000, timeoutMsg: "половина не снялась" });
    await tap('[data-testid="home-customize"]');
  }
});

test("своя Главная: скрыть карточку, переставить, вернуть как было", async () => {
  await openSection(browser, "Главная");
  await browser.$('[data-testid="home-spend"]').waitForDisplayed({ timeout: 5000 });
  await click(browser, "Настроить Главную");
  await browser.$('//*[@data-block="templates"]//button[normalize-space()="Скрыть"]').click();
  await browser.$('button[aria-label="Ниже: Быстрый ввод"]').click();
  await browser.waitUntil(async () => (await browser.$('[data-testid="home-block"]').getAttribute("data-block")) === "summary", { timeout: 5000 });
  // Перетаскивание карточки: «Напоминания» — в самый верх.
  await dragTo('[data-testid="home-block"][data-block="reminders"]', '[data-testid="home-block"][data-block="summary"]');
  await browser.waitUntil(async () => (await browser.$('[data-testid="home-block"]').getAttribute("data-block")) === "reminders", { timeout: 5000 });
  await click(browser, "Готово");
  assert.equal(await browser.$('//main//h2[normalize-space()="Шаблоны"]').isExisting(), false, "шаблоны скрыты");
  // Настройка сохраняется: после перезагрузки порядок тот же.
  await browser.refresh();
  await browser.$('//main//h1[normalize-space()="Главная"]').waitForDisplayed({ timeout: 10000 });
  assert.equal(await browser.$("main .home-block").getAttribute("data-block"), "reminders");
  await click(browser, "Настроить Главную");
  await click(browser, "Вернуть по умолчанию");
  await browser.waitUntil(async () => (await browser.$('[data-testid="home-block"]').getAttribute("data-block")) === "quick", { timeout: 5000 });
  await click(browser, "Готово");
  // По умолчанию (0.21) — пять основных карточек; шаблонов среди них нет.
  await browser.waitUntil(async () => (await browser.$$("main .home-block")).length === 5, { timeout: 5000, timeoutMsg: "по умолчанию не пять карточек" });
  assert.equal(await browser.$('//main//h2[normalize-space()="Шаблоны"]').isExisting(), false);
  // Остальные включаются в Настройках.
  await openSection(browser, "Настройки");
  await browser.$('[name="homeCard-templates"]').click();
  await openSection(browser, "Главная");
  await browser.$('//main//h2[normalize-space()="Шаблоны"]').waitForDisplayed({ timeout: 5000 });
  await openSection(browser, "Настройки");
  await browser.$('[data-testid="home-cards-all"]').click();
  await openSection(browser, "Главная");
  await browser.$('[data-testid="home-spend"]').waitForDisplayed({ timeout: 5000 });
});

test("счёт, перетащенный на категорию «Куда тратите», открывает расход с этим счётом", async () => {
  await browser.$('//*[@data-testid="spend-chip" and @data-category="Такси"]').click();
  await browser.$('[role="dialog"]').waitForDisplayed({ timeout: 5000 });
  const picked = (n) =>
    browser.execute((name) => {
      const s = document.querySelector(`[role="dialog"] select[name="${name}"]`);
      return s.options[s.selectedIndex].text.trim();
    }, n);
  assert.equal(await picked("category"), "Такси");
  await browser.keys("Escape");
  await browser.$('[role="dialog"]').waitForExist({ timeout: 5000, reverse: true });
  await dragTo('[data-testid="home-account"]:first-child', '[data-testid="spend-chip"][data-category="Общепит"]');
  await browser.$('[role="dialog"]').waitForDisplayed({ timeout: 5000 });
  assert.equal(await picked("category"), "Общепит");
  assert.match(await picked("account"), /^Наличные/);
  await browser.keys("Escape");
});
