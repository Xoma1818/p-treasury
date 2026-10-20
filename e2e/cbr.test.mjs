// Курсы ЦБ РФ по кнопке (0.9.0). Вместо cbr.ru — местный сервер с ответом в формате ЦБ:
// из тестовой среды сайт ЦБ недоступен, а ответ так ещё и не зависит от дня.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { start, stop, openSection, onboard, fill, click, setDate, waitText, money } from "./app.mjs";

// Ответ ЦБ приходит в windows-1251: русские названия здесь заменены байтами этой кодировки.
const xml = (date, usd) =>
  Buffer.concat([
    Buffer.from(`<?xml version="1.0" encoding="windows-1251"?><ValCurs Date="${date}" name="Foreign Currency Market">`),
    Buffer.from(`<Valute ID="R01235"><NumCode>840</NumCode><CharCode>USD</CharCode><Nominal>1</Nominal><Name>`),
    Buffer.from([0xc4, 0xee, 0xeb, 0xeb, 0xe0, 0xf0]),
    Buffer.from(`</Name><Value>${usd}</Value><VunitRate>${usd}</VunitRate></Valute>`),
    Buffer.from(`<Valute ID="R01239"><NumCode>978</NumCode><CharCode>EUR</CharCode><Nominal>1</Nominal><Name>E</Name><Value>100,5000</Value><VunitRate>100,5</VunitRate></Valute>`),
    Buffer.from(`<Valute ID="R01820"><NumCode>392</NumCode><CharCode>JPY</CharCode><Nominal>100</Nominal><Name>J</Name><Value>61,2345</Value></Valute></ValCurs>`),
  ]);

let app;
let server;
let mode = "ok";
const requests = [];

before(async () => {
  server = createServer((req, res) => {
    requests.push(req.url);
    if (mode === "down") {
      res.writeHead(503).end();
      return;
    }
    const q = new URL(req.url, "http://x").searchParams.get("date_req") ?? "";
    const [d, m, y] = q.split("/");
    // На воскресенье 18.10 ЦБ отдаёт курс, установленный на субботу 17.10.
    const date = q === "18/10/2026" ? "17.10.2026" : `${d}.${m}.${y}`;
    res.writeHead(200, { "Content-Type": "application/xml; charset=windows-1251" }).end(xml(date, q === "18/10/2026" ? "91,5000" : "92,1500"));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/scripts/XML_daily.asp`;
  app = await start(undefined, { env: { PTREASURY_CBR_URL: url, NO_PROXY: "127.0.0.1,localhost" } });
});
after(async () => {
  await stop(app?.browser);
  server?.close();
});

const loadCbr = async (browser) => {
  const button = await browser.$('[data-testid="cbr-load"]');
  await button.waitForClickable({ timeout: 5000 });
  await button.click();
};

test("на главной кнопка «Загрузить курс ЦБ» включает валютный счёт в баланс", async () => {
  const { browser } = app;
  await onboard(browser, [
    { name: "Карта", balance: "10000" },
    { name: "Вклад USD", type: "Вклад / сбережения", currency: "USD", balance: "100" },
  ]);
  await waitText(browser, '[data-testid="home-missing-rates"]', /Нет курса для USD/);
  await loadCbr(browser);
  await waitText(browser, '[data-testid="cbr-result"]', /Курсы ЦБ РФ на \d\d\.\d\d\.\d{4} загружены: USD\./);
  // 10 000 ₽ + 100 $ × 92,15.
  await waitText(browser, '[data-testid="total-balance"]', money("19 215 ₽"));
  assert.ok(requests.at(-1).includes("date_req="), requests.at(-1));
});

test("в Настройках курс ЦБ на выбранную дату с подписью «ЦБ РФ»; ручной курс не затирается", async () => {
  const { browser } = app;
  await openSection(browser, "Настройки");
  await waitText(browser, '[data-testid="rates"]', /1 USD = 92,15 ₽\s*ЦБ РФ/);

  // Воскресенье: ЦБ присылает субботний курс, он и записывается на субботу.
  await setDate(browser, "cbrDate", "2026-10-18");
  await loadCbr(browser);
  await waitText(browser, '[data-testid="cbr-result"]', /на 17\.10\.2026 загружены: USD/);
  assert.equal(requests.at(-1), "/scripts/XML_daily.asp?date_req=18/10/2026");
  await waitText(browser, '[data-testid="rates"]', /17\.10\.2026\s*1 USD = 91,5 ₽\s*ЦБ РФ/);

  // Ручной курс на ту же дату остаётся, ЦБ его не трогает.
  await setDate(browser, "rateDate", "2026-10-15");
  await fill(browser, "rate", "95");
  await click(browser, "Добавить");
  await waitText(browser, '[data-testid="rates"]', /15\.10\.2026\s*1 USD = 95 ₽\s*вручную/);
  await setDate(browser, "cbrDate", "2026-10-15");
  await loadCbr(browser);
  await waitText(browser, '[data-testid="cbr-result"]', /введённый вручную на эту дату, оставлен: USD/);
  await waitText(browser, '[data-testid="rates"]', /15\.10\.2026\s*1 USD = 95 ₽\s*вручную/);
});

test("ошибки: сайт ЦБ отвечает ошибкой или недоступен", async () => {
  const { browser } = app;
  mode = "down";
  await loadCbr(browser);
  await waitText(browser, '[data-testid="cbr-error"]', /Сайт ЦБ РФ ответил ошибкой 503/);
  await new Promise((r) => server.close(r));
  server = null;
  await loadCbr(browser);
  await waitText(browser, '[data-testid="cbr-error"]', /Нет связи с сайтом ЦБ РФ/, 30000);
  // Кнопка снова доступна, приложение работает.
  await (await browser.$('[data-testid="cbr-load"]')).waitForClickable({ timeout: 5000 });
});
