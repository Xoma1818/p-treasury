// Снимки 0.16 «Быстрые победы» на примере данных, 1280 и 1920, тёмная и светлая темы:
// node e2e/screenshots-quickwins.mjs <папка> (под xvfb-run -s "-screen 0 1920x1080x24").
// Имена файлов — русские слова латиницей: 01-glavnaya-proverte-1280-temnaya.png и т. п.
import { start, stop, setDate } from "./app.mjs";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const dir = resolve(process.argv[2] ?? "screens");
mkdirSync(dir, { recursive: true });
const SIZES = [["1280", 1280, 800], ["1920", 1920, 1080]];
const THEMES = [["temnaya", "Тёмная"], ["svetlaya", "Светлая"]];
const pad = (n) => String(n).padStart(2, "0");
const now = new Date();
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const daysAgo = (n) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - n);

const { browser } = await start();
const pause = (ms = 600) => browser.pause(ms);
// Нажатия через страницу: при большом окне WebKitWebDriver промахивается координатами.
const js = (fn, ...args) => browser.execute(fn, ...args);
const section = async (title) => {
  await js(() => document.querySelector('[role="dialog"]') && document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await js((t) => [...document.querySelectorAll("nav button")].find((b) => b.textContent.trim().startsWith(t))?.click(), title);
  await browser.$(`//main//h1[normalize-space()="${title}"]`).waitForDisplayed({ timeout: 5000 });
  await pause(800);
};
const button = (text, scope = "document") =>
  js(
    (t, s) => {
      const root = s === "document" ? document : document.querySelector(s);
      const b = [...root.querySelectorAll("button")].find((x) => x.textContent.trim() === t);
      if (!b) throw new Error(`нет кнопки «${t}»`);
      b.scrollIntoView({ block: "center" });
      b.click();
    },
    text,
    scope,
  );
const scrollTo = (sel, block = "start") => js((s, b) => document.querySelector(s)?.scrollIntoView({ block: b }), sel, block);
const setValue = (sel, v) =>
  js(
    (s, val) => {
      const el = document.querySelector(s);
      const proto = Object.getPrototypeOf(el);
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, val);
      el.dispatchEvent(new Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
    },
    sel,
    v,
  );
const selectByText = (sel, text) =>
  js(
    (s, t) => {
      const el = document.querySelector(s);
      const o = [...el.options].find((x) => x.text.trim().includes(t));
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(el, o.value);
      el.dispatchEvent(new Event("change", { bubbles: true }));
    },
    sel,
    text,
  );
const escape = async () => {
  await browser.keys("Escape");
  await pause(300);
};

try {
  await browser.$("//h1[normalize-space()='Основная валюта']").waitForDisplayed({ timeout: 15000 });
  await button("Посмотреть на примере");
  await browser.$('//main//h1[normalize-space()="Главная"]').waitForDisplayed({ timeout: 15000 });
  for (const [size, w, h] of SIZES) {
    await browser.setWindowSize(w, h);
    for (const [themeName, theme] of THEMES) {
      // Тема — кнопкой в боковом меню, как у пользователя.
      await js((t) => [...document.querySelectorAll("nav button, aside button")].find((b) => b.textContent.trim() === t)?.click(), theme);
      await pause(400);
      let n = 0;
      const shot = async (name) => {
        n += 1;
        await browser.saveScreenshot(join(dir, `${pad(n)}-${name}-${size}-${themeName}.png`));
      };

      // Главная: «Проверьте», «Необычно в этом месяце», цветные полосы бюджета.
      await section("Главная");
      await scrollTo('[data-testid="home-checks"]');
      await pause();
      await shot("glavnaya-proverte-i-neobychno");
      await js(() => {
        const bar = [...document.querySelectorAll("main li > .bar.warn, main li > .bar.over, main li > .bar")][0];
        bar?.closest(".card")?.scrollIntoView({ block: "center" });
      });
      await pause();
      await shot("glavnaya-cvetnye-polosy-byudzheta");

      // Бюджет: пометки «к обычному».
      await section("Бюджет");
      await scrollTo('[data-testid="budget-expense"]');
      await pause();
      await shot("byudzhet-k-obychnomu");

      // Операции: выделение и полоса сумм.
      await section("Операции");
      await button("Сбросить");
      await setDate(browser, "dateFrom", iso(daysAgo(10)));
      await pause(800);
      await js(() => {
        const boxes = document.querySelectorAll('[data-testid="txn-select"]');
        for (const i of [1, 2, 3]) boxes[i]?.click();
      });
      await pause(800);
      await shot("operacii-vydelenie-i-polosa-summ");
      await escape();
      // Раскрытый чек «Ашан, 3 категории» и значки тегов.
      await js(() => document.querySelector('tr[data-receipt] button[aria-label="Раскрыть чек"]')?.click());
      await scrollTo('tr[data-receipt]', "center");
      await pause();
      await shot("operacii-raskrytyj-chek-i-tegi");
      await js(() => document.querySelector('tr[data-receipt] button[aria-label="Свернуть чек"]')?.click());

      // Форма расхода: разбивка чека, затем «по месяцам» и теги («+ Расход» есть на Главной).
      await section("Главная");
      await button("+ Расход");
      await browser.$('[role="dialog"]').waitForDisplayed({ timeout: 5000 });
      await setValue('[role="dialog"] [name="amount"]', "3000");
      await setValue('[role="dialog"] [name="payee"]', "Перекрёсток");
      await button("Разбить по категориям", '[role="dialog"]');
      await pause(300);
      await selectByText('[role="dialog"] [name="partCategory0"]', "Супермаркет");
      await setValue('[role="dialog"] [name="partAmount0"]', "2200");
      await selectByText('[role="dialog"] [name="partCategory1"]', "Аптека");
      await setValue('[role="dialog"] [name="partAmount1"]', "500");
      await pause();
      await shot("forma-razbivka-cheka");
      await escape();
      await button("+ Расход");
      await browser.$('[role="dialog"]').waitForDisplayed({ timeout: 5000 });
      await setValue('[role="dialog"] [name="amount"]', "12000");
      await setValue('[role="dialog"] [name="payee"]', "Ингосстрах");
      await js(() => document.querySelector('[role="dialog"] [name="spreadOn"]').click());
      await pause(200);
      // Поле тегов перерисовывается после каждого тега: ищем его заново.
      const tags = () => browser.$('[role="dialog"] [name="tags"]');
      await js(() => document.querySelector('[role="dialog"] [name="tags"]').focus());
      await (await tags()).setValue("дача");
      await browser.keys("Enter");
      await pause(300);
      await pause(500);
      await shot("forma-po-mesyacam-i-tegi");
      await escape();
      await escape();

      // Категории → Теги.
      await section("Категории");
      await scrollTo('[data-testid="tags-card"]', "center");
      await pause();
      await shot("kategorii-tegi");

      // Отчёты «По тегу» и «Чистые активы» с подсказкой.
      await section("Отчёты");
      await button("По тегу", '[role="tablist"]');
      await selectByText('[name="periodKind"]', "Произвольный");
      await setDate(browser, "reportFrom", iso(daysAgo(90)));
      await setDate(browser, "reportTo", iso(now));
      await pause(400);
      await selectByText('[name="reportTag"]', "отпуск");
      await pause(800);
      await scrollTo('[data-testid="tag-report"]');
      await js(() => document.querySelector('[data-testid="tag-report"] [data-testid="hint"]').dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body })));
      await pause(700);
      await shot("otchety-po-tegu");
      await button("Чистые активы", '[role="tablist"]');
      await browser.$('[data-testid="networth-last"]').waitForDisplayed({ timeout: 5000 });
      await scrollTo('[data-testid="networth-report"]', "center");
      // Наведение на предпоследний месяц через страницу: при большом окне координаты WebDriver сбиваются.
      await js(() => {
        const hits = document.querySelectorAll('[data-testid="networth-report"] rect.hit');
        hits[hits.length - 2].dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }));
      });
      await pause(700);
      await shot("otchety-chistye-aktivy-s-podskazkoj");

      // Настройки: выключатель «Предупреждать о бюджете».
      await section("Настройки");
      await scrollTo('[data-testid="budget-alerts"]', "center");
      await (await browser.$('[data-testid="budget-alerts"]')).moveTo();
      await pause();
      await shot("nastrojki-preduprezhdat-o-byudzhete");
    }
  }
} finally {
  await stop(browser);
}
