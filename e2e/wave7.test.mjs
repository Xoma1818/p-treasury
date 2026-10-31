// 0.16 «Быстрые победы» на примере данных: карточки «Проверьте» и «Необычно в этом месяце»,
// цвет полос и «к обычному» в Бюджете, выделение и полоса сумм в Операциях, пачка с отменой Ctrl+Z,
// разбитый чек одной строкой, теги и фильтр по тегу, отчёты «По тегу» и «Чистые активы»,
// выключатель «Предупреждать о бюджете». Постановка: docs/product/0.16-quick-wins.md.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { start, stop, openSection, click, fill, choose, save, setDate, waitText, waitContent, waitCount, money } from "./app.mjs";

const pad = (n) => String(n).padStart(2, "0");
const now = new Date();
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const daysAgo = (n) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - n);
const dialog = '//*[@role="dialog"]';
const checkRow = (kind, text = "") => `//li[@data-testid="check-row" and @data-kind="${kind}"${text ? ` and contains(., "${text}")` : ""}]`;
const yandex = checkRow("price", "Яндекс Плюс");
const keys = (...k) => browser.keys(k);
/** Убрать фокус из полей: Ctrl+Z в поле ввода — отмена набора текста, а не действия. */
const blur = () => browser.execute(() => document.activeElement?.blur());
/** Выбрать пункт списка, в тексте которого есть `text` (подкатегории идут как «Родитель → Имя»). */
async function pickLike(name, text) {
  const value = await browser.execute(
    (n, t) => {
      const sel = document.querySelector(`[role="dialog"] select[name="${n}"]`) ?? document.querySelector(`select[name="${n}"]`);
      return [...sel.options].find((o) => o.value && o.text.includes(t))?.value ?? null;
    },
    name,
    text,
  );
  if (value === null) throw new Error(`В списке ${name} нет пункта с «${text}»`);
  await (await browser.$(`select[name="${name}"]`)).selectByAttribute("value", value);
}
const count = (sel) => browser.execute((s) => document.querySelectorAll(s).length, sel);

let browser;
before(async () => {
  ({ browser } = await start());
  await browser.$("//h1[normalize-space()='Основная валюта']").waitForDisplayed({ timeout: 15000 });
  await click(browser, "Посмотреть на примере");
  await browser.$('//main//h1[normalize-space()="Главная"]').waitForDisplayed({ timeout: 15000 });
});
after(async () => {
  await stop(browser);
});

test("Главная, «Проверьте»: подорожание и дубль из примера; «Всё в порядке» убирает строку насовсем", async () => {
  await waitText(browser, '[data-testid="home-checks"]', /Проверьте/);
  await waitText(browser, yandex, /Яндекс Плюс: было 399 ₽, стало 449 ₽ \(\+50 ₽ в месяц, \+600 ₽ в год\)/);
  await waitText(browser, checkRow("duplicate"), /Похоже на дубль: Самокат[\s\S]*2 раза по 1[\s ]540 ₽/);
  // У каждой строки «Открыть» и «Всё в порядке», у дубля ещё «Удалить второй».
  // Строки ниже края окна WebKit не отдаёт через getText: берём textContent.
  const textOf = (xp) => browser.execute((x) => document.evaluate(x, document, null, 9, null).singleNodeValue?.textContent ?? "", xp);
  for (const xp of [yandex, checkRow("duplicate")]) {
    const text = await textOf(xp);
    assert.match(text, /Открыть/);
    assert.match(text, /Всё в порядке/);
  }
  assert.match(await textOf(checkRow("duplicate")), /Удалить второй/);
  // «?» у карточки.
  assert.ok(await browser.$('[data-testid="home-checks"] [data-testid="hint"]').isExisting(), "подсказка «?» у «Проверьте»");

  await click(browser, "Всё в порядке", yandex);
  await browser.$(yandex).waitForExist({ timeout: 5000, reverse: true });
  // После ухода с Главной и возврата строка не появляется.
  await openSection(browser, "Операции");
  await openSection(browser, "Главная");
  await waitText(browser, checkRow("duplicate"), /Самокат/);
  assert.equal(await browser.$(yandex).isExisting(), false, "подорожание «Яндекс Плюс» больше не показывается");
});

test("«Открыть» у дубля открывает операцию", async () => {
  await openSection(browser, "Главная");
  await click(browser, "Открыть", checkRow("duplicate"));
  try {
    await browser.$(dialog).waitForDisplayed({ timeout: 5000 });
  } catch {
    const card = await (await browser.$('[data-testid="home-checks"]')).getText();
    assert.fail(`форма операции не открылась: «${/Операция не найдена[^\n]*/.exec(card)?.[0] ?? "нет сообщения"}»`);
  }
  assert.equal(await (await browser.$('[role="dialog"] [name="payee"]')).getValue(), "Самокат");
  await browser.keys("Escape");
  await browser.$(dialog).waitForExist({ timeout: 5000, reverse: true });
});

test("«Удалить второй» у дубля отменяется через Ctrl+Z", async () => {
  await openSection(browser, "Операции");
  await fill(browser, "search", "Самокат");
  await waitText(browser, '[data-testid="txn-count"]', /Показано 2 из 2/);
  await openSection(browser, "Главная");
  await click(browser, "Удалить второй", checkRow("duplicate"));
  await browser.$(checkRow("duplicate")).waitForExist({ timeout: 5000, reverse: true });
  await blur();
  await keys("Control", "z");
  await waitText(browser, checkRow("duplicate"), /Самокат/);
  await openSection(browser, "Операции");
  await fill(browser, "search", "Самокат");
  await waitText(browser, '[data-testid="txn-count"]', /Показано 2 из 2/);
});

test("Главная, «Необычно в этом месяце»: карточка есть, строка ведёт к операциям категории за месяц", async () => {
  await openSection(browser, "Главная");
  const text = await waitText(browser, '[data-testid="home-unusual"]', /Необычно в этом месяце[\s\S]*(обычного|как обычно|не с чем)/);
  assert.ok(await browser.$('[data-testid="home-unusual"] [data-testid="hint"]').isExisting(), "подсказка «?»");
  const rows = await count('[data-testid="unusual-row"]');
  assert.ok(rows <= 3, `не больше трёх строк, а их ${rows}`);
  if (rows > 0) {
    assert.match(text, /на \d+ % (больше|меньше) обычного|раньше не было/);
    await (await browser.$('[data-testid="unusual-row"]')).click();
    await browser.$('//main//h1[normalize-space()="Операции"]').waitForDisplayed({ timeout: 5000 });
    // Фильтр «категория за месяц»: даты с 1-го числа этого месяца.
    const from = await (await browser.$('[name="dateFrom"]')).getValue().catch(() => "");
    if (from) assert.match(from, new RegExp(`^${now.getFullYear()}-${pad(now.getMonth() + 1)}-`));
    await waitText(browser, '[data-testid="sel-sum"]', /Найдено \d+: расходы/);
  }
});

test("Главная: полосы бюджета жёлтые от 80 %, красные от 100 %", async () => {
  await openSection(browser, "Главная");
  const bars = await browser.execute(() =>
    [...document.querySelectorAll("main li")]
      .filter((li) => li.querySelector(":scope > .bar") && li.querySelector(":scope > .percent"))
      .map((li) => [parseInt(li.querySelector(".percent").textContent, 10), li.querySelector(".bar").className]),
  );
  assert.ok(bars.length > 0, "на Главной есть полосы бюджета");
  for (const [p, cls] of bars) assert.equal(cls, p >= 100 ? "bar over" : p >= 80 ? "bar warn" : "bar", `${p} % → ${cls}`);
});

test("Бюджет: цвет полос по порогам, пометки «к обычному», страховка по 1 000 ₽ в месяц", async () => {
  await openSection(browser, "Бюджет");
  await browser.$('[data-testid="budget-line"]').waitForDisplayed({ timeout: 5000 });
  const lines = await browser.execute(() =>
    [...document.querySelectorAll('[data-testid="budget-expense"] [data-testid="budget-line"]')].map((tr) => [
      tr.dataset.category,
      parseInt(tr.querySelector('[data-testid="percent"]')?.textContent ?? "0", 10),
      tr.querySelector(".bar")?.className ?? "",
    ]),
  );
  assert.ok(lines.length > 0);
  for (const [name, p, cls] of lines) assert.equal(cls, p >= 100 ? "bar over" : p >= 80 ? "bar warn" : "bar", `${name}: ${p} % → ${cls}`);
  const pills = await browser.execute(() => [...document.querySelectorAll('[data-testid="usual-pill"]')].map((e) => e.textContent));
  for (const t of pills) assert.match(t, /^[+−]\d+ % к обычному$/);
  assert.ok(await browser.$('[data-testid="budget-expense"] [data-testid="hint"]').isExisting(), "подсказка «?» у полос");
  // Страховка 12 000 ₽ прошлого месяца «на 12 месяцев»: в этом месяце 1 000 ₽.
  await waitText(browser, '//tr[@data-testid="budget-line" and @data-category="Страхование"]', money("1 000 ₽"));
});

test("Операции: разбитый чек одной строкой с раскрытием, значки тега и «по месяцам»", async () => {
  await openSection(browser, "Операции");
  await click(browser, "Сбросить");
  await setDate(browser, "dateFrom", iso(daysAgo(60)));
  const receipt = '//tr[@data-testid="txn-row" and @data-receipt="3"]';
  await waitText(browser, receipt, /Ашан, 3 категории/);
  await waitText(browser, receipt, money("−5 000 ₽"));
  await waitText(browser, receipt, /Супермаркет, [^,]*Аптека, [^,]*Одежда|Одежда, [^,]*Аптека, [^,]*Супермаркет/);
  await (await browser.$(`${receipt}//button[@aria-label="Раскрыть чек"]`)).click();
  await waitCount(browser, '[data-testid="receipt-part"]', 3);
  const parts = await browser.execute(() => [...document.querySelectorAll('[data-testid="receipt-part"]')].map((r) => r.textContent));
  // Части идут по названию категории: «Дети → Одежда», «Здоровье → Аптека», «Продукты → Супермаркет».
  for (const re of [/Супермаркет\D*3\s200\s₽/, /Аптека\D*450\s₽/, /Одежда\D*1\s350\s₽/]) assert.ok(parts.some((p) => re.test(p)), `${re} в ${parts.join(" | ")}`);
  await (await browser.$(`${receipt}//button[@aria-label="Свернуть чек"]`)).click();
  await waitCount(browser, '[data-testid="receipt-part"]', 0);
  // Ремонт с тегом «дача» и страховка «÷ 12 мес.».
  await waitText(browser, '//tr[@data-testid="txn-row"][.//*[@data-testid="txn-tag"]]', /#дача/);
  await waitText(browser, '//tr[@data-testid="txn-row"][.//*[@data-testid="txn-spread"]]', /÷ 12 мес\./);
  // Нажатие на чек открывает весь чек.
  await (await browser.$(`${receipt}/td[@class="date"]`)).click();
  await waitText(browser, `${dialog}//h2`, /Разбитый чек/);
  await waitText(browser, '[data-testid="receipt-split"]', /По категориям/);
  assert.equal(await count('[role="dialog"] [name^="partCategory"]'), 3);
  assert.ok(await browser.$(`${dialog}//button[normalize-space()="Удалить чек"]`).isExisting());
  await browser.keys("Escape");
  await browser.$(dialog).waitForExist({ timeout: 5000, reverse: true });
});

test("выделение: флажки, Shift-диапазон, полоса «Выбрано», итог найденного без выделения", async () => {
  await openSection(browser, "Операции");
  await click(browser, "Сбросить");
  await fill(browser, "search", "Самокат");
  await waitText(browser, '[data-testid="txn-count"]', /Показано 2 из 2/);
  // Ничего не выделено, но включён поиск: полоса показывает итог по найденному.
  await waitText(browser, '[data-testid="sel-sum"]', /Найдено 2: расходы 3[\s ]080 ₽, доходы 0 ₽, итог −3[\s ]080 ₽/);
  const boxes = await browser.$$('[data-testid="txn-select"]');
  await boxes[0].click();
  await waitText(browser, '[data-testid="sel-sum"]', /Выбрано 1: расходы 1[\s ]540 ₽/);
  await boxes[1].click();
  await waitText(browser, '[data-testid="sel-sum"]', /Выбрано 2: расходы 3[\s ]080 ₽, доходы 0 ₽, итог −3[\s ]080 ₽/);
  for (const b of ["Категория", "Получатель", "Счёт", "Тег", "Удалить"]) {
    assert.ok(await browser.$(`//*[@data-testid="sel-bar"]//button[normalize-space()="${b}"]`).isExisting(), `кнопка «${b}»`);
  }
  await browser.keys("Escape");
  await waitText(browser, '[data-testid="sel-sum"]', /Найдено 2/);

  // Shift-щелчок выделяет диапазон строк.
  await click(browser, "Сбросить");
  await setDate(browser, "dateFrom", iso(daysAgo(10)));
  await browser.$('[data-testid="txn-row"]').waitForDisplayed({ timeout: 5000 });
  await browser.pause(300);
  const rows = await browser.$$('[data-testid="txn-row"]');
  assert.ok(rows.length >= 4, `строк ${rows.length}`);
  await (await browser.$$('[data-testid="txn-select"]'))[0].click();
  await browser.execute(() => {
    const cb = document.querySelectorAll('[data-testid="txn-select"]')[3];
    cb.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
  });
  await browser.waitUntil(async () => (await count('tr[data-testid="txn-row"][aria-selected="true"]')) === 4, { timeout: 5000 });
  await waitText(browser, '[data-testid="sel-sum"]', /Выбрано \d+:/);
  // Ctrl+A выделяет всё найденное.
  await blur();
  await keys("Control", "a");
  const total = Number(/из (\d+)/.exec(await (await browser.$('[data-testid="txn-count"]')).getText())[1]);
  await browser.waitUntil(async () => (await count('tr[data-testid="txn-row"][aria-selected="true"]')) === rows.length, { timeout: 5000 });
  await waitText(browser, '[data-testid="sel-sum"]', /Выбрано \d+:/);
  const selected = Number(/Выбрано (\d+)/.exec(await (await browser.$('[data-testid="sel-sum"]')).getText())[1]);
  assert.ok(selected >= total, `Ctrl+A: выбрано ${selected}, найдено строк ${total}`);
  await browser.keys("Escape");
});

test("пачка: категория двум операциям, переводы пропускаются, всё отменяется одним Ctrl+Z", async () => {
  await openSection(browser, "Операции");
  await click(browser, "Сбросить");
  await fill(browser, "search", "Самокат");
  await waitText(browser, '[data-testid="txn-count"]', /Показано 2 из 2/);
  for (const b of await browser.$$('[data-testid="txn-select"]')) await b.click();
  await waitText(browser, '[data-testid="sel-sum"]', /Выбрано 2/);
  await click(browser, "Категория", '//*[@data-testid="sel-bar"]');
  await pickLike("bulkCategory", "Кафе");
  await click(browser, "Поставить", '//*[@data-testid="sel-bar"]');
  await waitText(browser, '[data-testid="bulk-message"]', /Категория поставлена: 2 операции\. Отменить — Ctrl\+Z\./);
  await browser.waitUntil(async () => (await browser.execute(() => [...document.querySelectorAll('[data-testid="txn-row"] .main')].map((e) => e.textContent).join("|"))).match(/Кафе[^|]*\|[^|]*Кафе/), {
    timeout: 5000,
    timeoutMsg: "обе операции получили «Кафе»",
  });
  await blur();
  await keys("Control", "z");
  await browser.waitUntil(async () => (await browser.execute(() => [...document.querySelectorAll('[data-testid="txn-row"] .main')].map((e) => e.textContent).join("|"))).match(/Супермаркет[^|]*\|[^|]*Супермаркет/), {
    timeout: 5000,
    timeoutMsg: "одним Ctrl+Z обе вернулись в «Супермаркет»",
  });

  // Переводы категорию не получают: программа говорит, сколько пропущено.
  await click(browser, "Сбросить");
  await setDate(browser, "dateFrom", iso(daysAgo(60)));
  const transfer = await browser.$('//tr[@data-testid="txn-row"][.//div[@class="main" and starts-with(normalize-space(), "Перевод")]]');
  if (await transfer.isExisting()) {
    // Полоса снизу может закрыть строку: щёлкаем флажки через страницу.
    await browser.execute(() => {
      const rows = [...document.querySelectorAll('tr[data-testid="txn-row"]:not([data-receipt])')];
      const isTransfer = (r) => r.querySelector(".main")?.textContent.startsWith("Перевод");
      rows.find(isTransfer).querySelector('[data-testid="txn-select"]').click();
      rows.find((r) => !isTransfer(r) && !r.querySelector(".main")?.textContent.startsWith("Корректировка")).querySelector('[data-testid="txn-select"]').click();
    });
    // Плашку «Отменено» от прошлого шага закрываем: она внизу экрана, как и полоса.
    if (await browser.$('[data-testid="undo-bar"]').isExisting()) await (await browser.$('[data-testid="undo-bar"] button[aria-label="Закрыть"]')).click();
    await click(browser, "Категория", '//*[@data-testid="sel-bar"]');
    await pickLike("bulkCategory", "Кафе");
    await click(browser, "Поставить", '//*[@data-testid="sel-bar"]');
    await waitText(browser, '[data-testid="bulk-message"]', /пропущено 1: переводы/);
    await blur();
    await keys("Control", "z");
    await waitText(browser, '[data-testid="undo-bar"]', /Отменено/);
  }
});

test("удаление пачки спрашивает подтверждение на полосе и отменяется Ctrl+Z", async () => {
  await openSection(browser, "Операции");
  await click(browser, "Сбросить");
  await fill(browser, "search", "Самокат");
  await waitText(browser, '[data-testid="txn-count"]', /Показано 2 из 2/);
  for (const b of await browser.$$('[data-testid="txn-select"]')) await b.click();
  await (await browser.$('[data-testid="bulk-delete"]')).click();
  await waitText(browser, '[data-testid="bulk-delete"]', /Удалить 2 операции\? Отменить можно через Ctrl\+Z\./);
  assert.match(await (await browser.$('[data-testid="txn-count"]')).getText(), /Показано 2 из 2/, "до подтверждения ничего не удалено");
  await (await browser.$('[data-testid="bulk-delete-confirm"]')).click();
  await waitText(browser, '[data-testid="txn-count"]', /Показано 0 из 0/);
  await blur();
  await keys("Control", "z");
  await waitText(browser, '[data-testid="txn-count"]', /Показано 2 из 2/);
});

test("форма расхода: разбить чек на две категории, сохранить можно только при нулевом остатке; новый тег по Enter", async () => {
  await openSection(browser, "Главная");
  await click(browser, "+ Расход");
  await fill(browser, "amount", "3000");
  await fill(browser, "payee", "Перекрёсток");
  await click(browser, "Разбить по категориям", dialog);
  await waitText(browser, '[data-testid="receipt-split"]', /По категориям/);
  await pickLike("partCategory0", "Супермаркет");
  await fill(browser, "partAmount0", "2000");
  await pickLike("partCategory1", "Аптека");
  await fill(browser, "partAmount1", "500");
  await waitText(browser, '[data-testid="receipt-left"]', /Остаток: 500/);
  await click(browser, "Сохранить", dialog);
  await waitText(browser, '[role="alert"]', /Распределите остаток/);
  await fill(browser, "partAmount1", "1000");
  await waitText(browser, '[data-testid="receipt-left"]', /Распределено полностью/);
  await (await browser.$('[role="dialog"] [name="tags"]')).click();
  await (await browser.$('[role="dialog"] [name="tags"]')).setValue("праздник");
  await browser.keys("Enter");
  await waitText(browser, '[data-testid="tag-input"]', /#праздник/);
  await save(browser);

  await openSection(browser, "Операции");
  await click(browser, "Сбросить");
  await fill(browser, "search", "Перекрёсток");
  const row = '//tr[@data-testid="txn-row" and @data-receipt="2"]';
  await waitText(browser, row, /Перекрёсток, 2 категории/);
  await waitText(browser, row, money("−3 000 ₽"));
  await waitText(browser, row, /#праздник/);
});

test("форма расхода: «Учитывать по месяцам» показывает части; тег из подсказки", async () => {
  await openSection(browser, "Главная");
  await click(browser, "+ Расход");
  await fill(browser, "amount", "1000");
  await (await browser.$('[role="dialog"] [name="spreadOn"]')).click();
  // Поле числа перерисовывается при каждом вводе: значение ставим через страницу.
  await setDate(browser, "spreadMonths", "3");
  // 1 000 / 3: копейки уходят в первую часть.
  await waitText(browser, '[data-testid="spread-preview"]', /по 333,33 ₽ в месяц[\s\S]*в первом 333,34/);
  await (await browser.$('[role="dialog"] [name="tags"]')).click();
  await (await browser.$('[role="dialog"] [name="tags"]')).setValue("да");
  await waitText(browser, '[role="dialog"] .tag-hints', /#дача/);
  await browser.keys("Escape");
  await browser.$(dialog).waitForExist({ timeout: 5000, reverse: true }).catch(async () => {
    await click(browser, "Отмена", dialog);
  });
});

test("фильтр «Тег» в Операциях и Ctrl+K находит тег", async () => {
  await openSection(browser, "Операции");
  await click(browser, "Сбросить");
  await pickLike("filterTag", "#дача");
  await waitText(browser, '[data-testid="txn-count"]', /Показано 1 из 1/);
  await waitText(browser, '[data-testid="sel-sum"]', /Найдено 1: расходы 4[\s ]500 ₽/);
  await click(browser, "Сбросить");
  await waitText(browser, '[data-testid="txn-count"]', /Показано \d+ из \d+/);

  await blur();
  await keys("Control", "k");
  await browser.$('[data-testid="palette"]').waitForDisplayed({ timeout: 3000 });
  await fill(browser, "paletteQuery", "дача");
  // Название в пункте обрезается многоточием, WebKit не отдаёт его через getText.
  await waitContent(browser, '[data-testid="palette"]', /Теги[\s\S]*дача/i);
  // Пункт тега — после заголовка «Теги».
  await browser.execute(() => {
    const items = [...document.querySelectorAll('[data-testid="palette-item"]')];
    const heads = [...document.querySelectorAll('[data-testid="palette"] *')].filter((e) => e.children.length === 0 && e.textContent.trim().toLowerCase() === "теги");
    const after = items.find((i) => heads.some((h) => h.compareDocumentPosition(i) & Node.DOCUMENT_POSITION_FOLLOWING) && /дача/i.test(i.textContent));
    (after ?? items.find((i) => /дача/i.test(i.textContent))).click();
  });
  await browser.$('//main//h1[normalize-space()="Операции"]').waitForDisplayed({ timeout: 5000 });
  await waitText(browser, '[data-testid="txn-count"]', /Показано 1 из 1/);
  await waitText(browser, '[data-testid="txn-row"]', /#дача/);
});

test("Отчёты «По тегу»: итог, категории и месяцы", async () => {
  await openSection(browser, "Отчёты");
  await click(browser, "По тегу", '//*[@role="tablist"]');
  await choose(browser, "periodKind", "Произвольный");
  await setDate(browser, "reportFrom", iso(daysAgo(60)));
  await setDate(browser, "reportTo", iso(now));
  await pickLike("reportTag", "#дача (1)");
  await waitText(browser, '[data-testid="tag-expense"]', money("4 500 ₽"));
  await waitText(browser, '[data-testid="tag-report"]', /По категориям[\s\S]*Жильё[\s\S]*100 %[\s\S]*По месяцам[\s\S]*4[\s\u00a0]500 ₽/);
  assert.ok(await browser.$('[data-testid="tag-report"] [data-testid="hint"]').isExisting(), "подсказка «?»");
});

test("Отчёты «Чистые активы»: 12 точек, разбивка под мышкой, 3 года и всё время", async () => {
  await click(browser, "Чистые активы", '//*[@role="tablist"]');
  await waitText(browser, '[data-testid="networth-last"]', /\d.*₽/);
  assert.equal(await count('[data-testid="networth-report"] rect.hit'), 12);
  assert.ok(await browser.$('[data-testid="networth-report"] [data-testid="hint"]').isExisting(), "подсказка «?»");
  const hits = await browser.$$('[data-testid="networth-report"] rect.hit');
  await hits[hits.length - 1].moveTo();
  await waitText(browser, '[data-testid="networth-tip"]', /Деньги на счетах[\s\S]*Чистые активы[\s\S]*К прошлому месяцу/);
  await click(browser, "3 года", '//*[@data-testid="networth-report"]');
  await browser.waitUntil(async () => (await count('[data-testid="networth-report"] rect.hit')) === 36, { timeout: 5000 });
  await click(browser, "Всё время", '//*[@data-testid="networth-report"]');
  await browser.waitUntil(async () => (await count('[data-testid="networth-report"] rect.hit')) >= 1, { timeout: 5000 });
});

test("Настройки: «Предупреждать о бюджете» включён по умолчанию и запоминается", async () => {
  await openSection(browser, "Настройки");
  const sw = () => browser.$('[data-testid="budget-alerts"]');
  await (await sw()).waitForDisplayed({ timeout: 5000 });
  assert.equal(await (await sw()).getAttribute("aria-checked"), "true");
  assert.match(await (await sw()).getText(), /Включено/);
  await (await sw()).click();
  await browser.waitUntil(async () => (await (await sw()).getAttribute("aria-checked")) === "false", { timeout: 5000 });
  await openSection(browser, "Главная");
  await openSection(browser, "Настройки");
  assert.equal(await (await sw()).getAttribute("aria-checked"), "false");
  assert.match(await (await sw()).getText(), /Выключено/);
  await (await sw()).click();
  await browser.waitUntil(async () => (await (await sw()).getAttribute("aria-checked")) === "true", { timeout: 5000 });
});

test("быстрый ввод понимает «#ремонт»", async () => {
  await openSection(browser, "Главная");
  await browser.$('textarea[name="quickText"]').setValue("леруа 4500 #ремонт");
  await waitText(browser, '[data-testid="quick-draft"]', /#ремонт/);
  await setDate(browser, "quickText", "");
});

test("Категории → Теги: переименовать и объединить, операции остаются", async () => {
  await openSection(browser, "Категории");
  const row = (t) => `//li[@data-testid="tag-row" and @data-tag="${t}"]`;
  await waitText(browser, row("дача"), /#дача/);
  // Кнопки строки видны под мышкой.
  await (await browser.$(row("дача"))).moveTo();
  await click(browser, "Переименовать", row("дача"));
  await fill(browser, "tagName", "дом и дача");
  await click(browser, "Сохранить", row("дача"));
  await waitText(browser, row("дом и дача"), /#дом и дача/);
  await (await browser.$(row("дом и дача"))).moveTo();
  await click(browser, "Объединить", row("дом и дача"));
  await pickLike("mergeInto", "#отпуск");
  await click(browser, "Объединить", `${row("дом и дача")}//form`);
  await browser.$(row("дом и дача")).waitForExist({ timeout: 5000, reverse: true });
  // Операция «Леруа Мерлен» осталась и теперь с тегом «отпуск».
  await openSection(browser, "Операции");
  await click(browser, "Сбросить");
  await fill(browser, "search", "Леруа");
  await waitText(browser, '[data-testid="txn-row"]', /#отпуск/);
});

test("событие разбитого чека: создание, смена и снятие сохраняются целиком и отменяются одним Ctrl+Z", async () => {
  // Команды используются для подготовки событий и чтения записанных частей;
  // создание и каждое изменение самого чека проходят через настоящую форму.
  const invoke = async (command, args = {}) => {
    const result = await browser.executeAsync((cmd, input, done) => {
      window.__TAURI_INTERNALS__.invoke(cmd, input)
        .then((value) => done({ value }), (error) => done({ error: String(error) }));
    }, command, args);
    assert.equal(result.error, undefined, `${command}: ${result.error}`);
    return result.value;
  };
  const eventNames = ["E2E: поездка чека", "E2E: другое событие"];
  const eventIds = [];
  for (const name of eventNames) {
    eventIds.push(await invoke("create_event", {
      input: { name, startDate: iso(now), endDate: iso(now), budget: null, note: null },
    }));
  }
  const payee = "Чек события E2E";
  const parts = () => invoke("list_transactions", { filter: { search: payee, limit: 100 } });
  const assertEvent = async (expected) => {
    const page = await parts();
    assert.equal(page.total, 2, "у чека остались обе части");
    assert.ok(page.items.every((p) => p.eventId === expected), "событие сохранено у каждой части");
    const receipt = await invoke("get_receipt", { splitId: page.items[0].splitId });
    assert.equal(receipt.eventId, expected);
    assert.equal(receipt.total, 120000, "смена события не меняет сумму");
  };
  const openReceipt = async () => {
    await browser.$('[data-testid="txn-row"] .date').click();
    await waitText(browser, `${dialog}//h2`, /Разбитый чек/);
    await waitCount(browser, '[role="dialog"] [name^="partCategory"]', 2);
    await browser.$('[role="dialog"] button[type="submit"]').waitForEnabled({ timeout: 5000 });
  };

  await openSection(browser, "Главная");
  await click(browser, "+ Расход");
  await fill(browser, "amount", "1200");
  await fill(browser, "payee", payee);
  await click(browser, "Разбить по категориям", dialog);
  await pickLike("partCategory0", "Супермаркет");
  await fill(browser, "partAmount0", "800");
  await pickLike("partCategory1", "Аптека");
  await fill(browser, "partAmount1", "400");
  await browser.$(`[role="dialog"] select[name="event"] option[value="${eventIds[0]}"]`).waitForExist({ timeout: 5000 });
  await choose(browser, "event", eventNames[0]);
  await save(browser);
  await openSection(browser, "Операции");
  await click(browser, "Сбросить");
  await fill(browser, "search", payee);
  await waitText(browser, '[data-testid="txn-count"]', /Показано 2 из 2/);
  await assertEvent(eventIds[0]);

  // Сохранение чека и привязка к событию — одна запись журнала, а не две команды.
  await blur();
  await keys("Control", "z");
  await waitText(browser, '[data-testid="txn-count"]', /Показано 0 из 0/);
  await keys("Control", "y");
  await waitText(browser, '[data-testid="txn-count"]', /Показано 2 из 2/);
  await assertEvent(eventIds[0]);

  await openReceipt();
  await fill(browser, "newNote", "Гарантия на весь чек E2E");
  await click(browser, "Добавить", dialog);
  await waitText(browser, '[data-testid="notes-block"]', /Гарантия на весь чек E2E/);
  await choose(browser, "event", eventNames[1]);
  await save(browser);
  await waitText(browser, '[data-testid="txn-event"]', /другое событие/);
  await assertEvent(eventIds[1]);
  await blur();
  await keys("Control", "z");
  await waitText(browser, '[data-testid="txn-event"]', /поездка чека/);
  await assertEvent(eventIds[0]);

  // Повторное открытие после undo должно получить свежий чек, а не старый кеш.
  await openReceipt();
  assert.equal(await browser.$('[role="dialog"] [name="event"]').getValue(), eventIds[0]);
  await choose(browser, "event", "Не относится");
  await save(browser);
  await browser.$('[data-testid="txn-event"]').waitForExist({ timeout: 5000, reverse: true });
  await assertEvent(null);
  await blur();
  await keys("Control", "z");
  await waitText(browser, '[data-testid="txn-event"]', /поездка чека/);
  await assertEvent(eventIds[0]);

  // После пересоздания частей заметка остаётся у всего чека. Открываем его через
  // категорию другой части: её ID отличается от канонического ID заметки.
  await openReceipt();
  await waitText(browser, '[data-testid="notes-block"]', /Гарантия на весь чек E2E/);
  await save(browser);
  const page = await parts();
  const canonical = page.items.map((p) => p.id).sort().at(-1);
  const other = page.items.find((p) => p.id !== canonical);
  await browser.$('[name="filterCategory"]').selectByAttribute("value", other.categoryId);
  await waitText(browser, '[data-testid="txn-count"]', /Показано 1 из 1/);
  await openReceipt();
  await waitText(browser, '[data-testid="notes-block"]', /Гарантия на весь чек E2E/);
  await browser.keys("Escape");
  await browser.$(dialog).waitForExist({ timeout: 5000, reverse: true });
});
