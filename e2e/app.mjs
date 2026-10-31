// Запуск настоящего окна приложения через tauri-driver (WebDriver) для сквозных тестов.
// Каждый вызов start() открывает приложение с чистой папкой данных.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { remote } from "webdriverio";

const ROOT = resolve(import.meta.dirname, "..");
/** В Windows нет pkill/pgrep/xdotool: процессы ищем по командной строке через PowerShell. */
export const WIN = process.platform === "win32";
export const APP_BIN = process.env.PTREASURY_BIN ?? join(ROOT, WIN ? "target/debug/budget-app.exe" : "target/debug/budget-app");
/** Имя файла программы для копии рядом с переносной версией (в Windows с .exe). */
export const APP_FILE = basename(APP_BIN);

/** PID процессов (Windows), в командной строке которых есть `pattern`. */
function winPids(pattern) {
  const ps = "$p=$env:KAZNA_E2E_PATTERN; Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Replace([string][char]34, '').Contains($p) } | ForEach-Object { $_.ProcessId }";
  const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], {
    encoding: "utf8",
    env: { ...process.env, KAZNA_E2E_PATTERN: pattern },
  });
  return r.stdout.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
}

/** Программы прогона в Windows: всё, что может пережить сессию и помешать следующей. */
const WIN_IMAGES = ["tauri-driver.exe", "msedgedriver.exe", APP_FILE, "msedgewebview2.exe"];

/** Есть ли ещё процесс с таким именем файла (tasklist отвечает «INFO: No tasks…», если нет). */
function winRunning(image) {
  const r = spawnSync("tasklist", ["/FI", `IMAGENAME eq ${image}`, "/NH", "/FO", "CSV"], { encoding: "utf8" });
  return r.stdout.toLowerCase().includes(`"${image.toLowerCase()}"`);
}

/** Закрыть всё от прошлого запуска и дождаться, пока процессы исчезнут: живой
 *  tauri-driver держит порт 4444 (новая сессия попала бы в него), а WebView2 —
 *  свою папку, и тогда msedgedriver отвечает «DevToolsActivePort file doesn't exist». */
async function winCleanup(timeout = 20000) {
  const until = Date.now() + timeout;
  for (;;) {
    const left = WIN_IMAGES.filter(winRunning);
    if (!left.length) return;
    if (Date.now() > until) {
      console.error(`# после прогона остались процессы: ${left.join(", ")}`);
      return;
    }
    for (const image of left) spawnSync("taskkill", ["/IM", image, "/T", "/F"]);
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Windows: запускается ли программа сама по себе (без WebDriver). Проверяется один раз;
 *  если она сразу закрывается, сессия всё равно не создастся — тесты падают сразу, а не по таймауту. */
let winProbe;
function winProbeApp(bin, env) {
  if (winProbe !== undefined) return winProbe;
  const dir = mkdtempSync(join(tmpdir(), "p-treasury-probe-"));
  const r = spawnSync(bin, [`--data-dir=${dir}`], { encoding: "utf8", timeout: 15000, env });
  if (r.error?.code === "ETIMEDOUT") {
    console.error("# проверка запуска: программа работает 15 с — запускается нормально");
    winProbe = null;
  } else {
    winProbe = `программа закрылась сама: код ${r.status}, сигнал ${r.signal}, ошибка ${r.error?.message ?? "нет"}; stdout: ${(r.stdout || "").slice(-2000)}; stderr: ${(r.stderr || "").slice(-4000)}`;
    console.error(`# проверка запуска: ${winProbe}`);
  }
  return winProbe;
}

/**
 * Windows: открывает ли WebView2 программы порт отладки по переменной
 * WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS — так его открывает msedgedriver. Если нет,
 * DevToolsActivePort не появляется и сессия не создаётся. Один раз за прогон.
 */
let winDevtools;
async function winProbeDevtools(bin, env) {
  if (winDevtools !== undefined) return winDevtools;
  const dir = mkdtempSync(join(tmpdir(), "p-treasury-devtools-"));
  const udf = mkdtempSync(join(tmpdir(), "p-treasury-wv2-"));
  const port = 9333;
  const child = spawn(bin, [`--data-dir=${dir}`, "--remote-debugging-port=0", "--test-type=webdriver"], {
    env: { ...env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`, WEBVIEW2_USER_DATA_FOLDER: udf },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  let exit = null;
  child.on("exit", (code) => (exit = code));
  let version = null;
  for (let i = 0; i < 40 && exit === null && !version; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) version = (await r.json()).Browser ?? "есть";
    } catch {
      // порт ещё не открыт
    }
  }
  const list = (d) => {
    try {
      return readdirSync(d, { recursive: true }).filter((f) => /DevToolsActivePort|EBWebView$/.test(f)).join(", ") || "нет";
    } catch (e) {
      return e.message;
    }
  };
  winDevtools = `порт отладки ${version ? `открыт (${version})` : "не открылся за 20 с"}; программа ${exit === null ? "работает" : `закрылась, код ${exit}`}; DevToolsActivePort в папке WEBVIEW2_USER_DATA_FOLDER: ${list(udf)}; в папке данных: ${list(dir)}; в LOCALAPPDATA: ${list(join(process.env.LOCALAPPDATA ?? dir, "app.kazna.desktop"))}; вывод: ${out.slice(-1500)}`;
  console.error(`# проверка WebView2: ${winDevtools}`);
  if (exit === null) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"]);
  return winDevtools;
}

/**
 * Windows: после первой неудачной сессии start() падает сразу, не тратя минуты
 * на таймауты, — и в других файлах тестов того же прогона (метка у общего родителя).
 */
const WIN_FAIL_MARK = join(tmpdir(), `kazna-e2e-session-failed-${process.ppid}.txt`);
let winSessionError = WIN && existsSync(WIN_FAIL_MARK) ? readFileSync(WIN_FAIL_MARK, "utf8") : undefined;

let driver;
let currentDir;
/** По этому образцу добивается процесс приложения после прогона. */
let killPattern;

export async function start(dataDir = mkdtempSync(join(tmpdir(), "p-treasury-e2e-")), { env = {}, bin = APP_BIN, args, homeDefaults = false } = {}) {
  currentDir = dataDir;
  killPattern = args ? bin : `--data-dir=${dataDir}`;
  // Переменные окружения доходят до приложения через tauri-driver.
  // Курсы ЦБ грузятся сами раз в день: в тестах сайт ЦБ подменён закрытым портом,
  // чтобы настоящие курсы не меняли суммы (cbr.test.mjs ставит свой сервер).
  const cbr = { PTREASURY_CBR_URL: "http://127.0.0.1:9/scripts/XML_daily.asp", NO_PROXY: "127.0.0.1,localhost" };
  const wv2 = {};
  // Windows: msedgedriver напрямую (как его вызывает tauri-driver), с подробным журналом —
  // если сессия не создаётся, его хвост объясняет почему.
  const edgeLog = WIN ? join(mkdtempSync(join(tmpdir(), "p-treasury-edgelog-")), "msedgedriver.log") : null;
  const appArgs = args ?? [`--data-dir=${dataDir}`];
  const open = async () => {
    if (WIN) await winCleanup();
    const childEnv = { ...process.env, ...cbr, ...wv2, ...env };
    driver = WIN
      ? spawn("msedgedriver", ["--port=4444", "--verbose", `--log-path=${edgeLog}`], { stdio: ["ignore", "ignore", "inherit"], env: childEnv })
      : spawn("tauri-driver", [], { stdio: ["ignore", "ignore", "inherit"], env: childEnv });
    await new Promise((r) => setTimeout(r, 1500));
    return remote({
      hostname: "127.0.0.1",
      port: 4444,
      logLevel: "error",
      capabilities: WIN
        ? // Классический WebDriver, как с tauri-driver в Linux: через BiDi скрипт
          // видел window.__TAURI_INTERNALS__ без invoke.
          { browserName: "webview2", "wdio:enforceWebDriverClassic": true, "ms:edgeOptions": { binary: bin, args: appArgs } }
        : // `args: []` — запуск без своей папки данных (переносная версия).
          { "tauri:options": { application: bin, args: appArgs } },
    });
  };
  const edgeTail = () => {
    try {
      return readFileSync(edgeLog, "utf8").split(/\r?\n/).slice(-80).join("\n");
    } catch (e) {
      return `журнала нет: ${e.message}`;
    }
  };
  if (WIN && winSessionError) throw new Error(`сессия WebDriver в Windows не создаётся: ${winSessionError}`);
  if (WIN) {
    await winCleanup();
    const dead = winProbeApp(bin, { ...process.env, ...cbr, ...wv2, ...env });
    await winCleanup();
    if (dead) throw new Error(dead);
  }
  let browser;
  try {
    browser = await open();
  } catch (e) {
    if (!WIN) throw e;
    // Первый запуск WebView2 на чистой машине бывает дольше таймаута msedgedriver: одна повторная попытка.
    console.error(`# сессия не создана (${e.message}); процессы: ${WIN_IMAGES.filter(winRunning).join(", ") || "нет"}; журнал msedgedriver:\n${edgeTail()}`);
    await winCleanup();
    await winProbeDevtools(bin, { ...process.env, ...cbr, ...wv2, ...env });
    await winCleanup();
    winSessionError = e.message;
    try {
      writeFileSync(WIN_FAIL_MARK, e.message);
    } catch {
      // метка не обязательна
    }
    throw e;
  }
  // С 0.21 на Главной по умолчанию пять карточек. Старые сценарии проверяют все
  // карточки, поэтому включаем их (как у пользователя, который их включил);
  // `homeDefaults: true` оставляет Главную как после установки.
  if (!homeDefaults) await showAllHomeCards(browser);
  return { browser, dataDir };
}

/** Показать все карточки Главной (раскладка до 0.21: всё видно) и перезагрузить окно. */
export async function showAllHomeCards(browser) {
  await browser.waitUntil(() => browser.execute(() => document.readyState === "complete" && typeof window.__TAURI_INTERNALS__?.invoke === "function"), { timeout: 15000 });
  const ok = await browser.executeAsync((done) => {
    window.__TAURI_INTERNALS__
      .invoke("set_setting", { key: "home_layout", value: JSON.stringify({ order: [], hidden: [] }) })
      .then(() => done(true), () => done(false));
  });
  // База могла не открыться (сценарии ошибок): тогда тест сам увидит своё.
  if (ok) await browser.refresh();
}

export async function stop(browser) {
  try {
    await browser?.deleteSession();
  } finally {
    if (WIN) {
      // kill() в Windows не трогает дочерние процессы: msedgedriver и приложение
      // пережили бы прогон, а с 0.26 следующий запуск отдавался бы старой копии
      // (одна копия программы) — «session not created: DevToolsActivePort».
      if (driver?.pid) spawnSync("taskkill", ["/PID", String(driver.pid), "/T", "/F"]);
      await winCleanup();
      return;
    }
    driver?.kill();
    // Приложение сворачивается в трей при закрытии окна: добиваем процесс этого прогона.
    if (killPattern) spawnSync("pkill", ["-f", "--", killPattern]);
    // WebKitWebDriver иногда переживает сессию и держит порт: следующий запуск попал бы в старый процесс.
    spawnSync("pkill", ["-x", "WebKitWebDriver"]);
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** PID приложения этого прогона (или null, если оно завершилось). */
export function appPid(dataDir = currentDir) {
  if (WIN) return winPids(`--data-dir=${dataDir}`)[0] ?? null;
  const r = spawnSync("pgrep", ["-f", "--", `--data-dir=${dataDir}`], { encoding: "utf8" });
  return r.stdout.trim().split("\n").filter(Boolean)[0] ?? null;
}

/** Закрыть окно кнопкой «×», как пользователь (WebDriver вместо этого убивает процесс). */
export function closeLikeUser(dataDir = currentDir) {
  const pid = appPid(dataDir);
  if (!pid && WIN) {
    const all = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", `Get-CimInstance Win32_Process -Filter "Name='${APP_FILE}'" | ForEach-Object { $_.CommandLine }`], { encoding: "utf8" }).stdout.trim();
    throw new Error(`приложение не запущено: нет процесса с --data-dir=${dataDir}; запущены: ${all || "нет"}`);
  }
  if (!pid) throw new Error("приложение не запущено");
  if (WIN) {
    // taskkill без /F посылает окнам WM_CLOSE — то же, что нажать «×».
    const r = spawnSync("taskkill", ["/PID", pid], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`не удалось закрыть окно: ${r.stderr || r.stdout}`);
    return;
  }
  const wins = spawnSync("xdotool", ["search", "--pid", pid], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean);
  const r = spawnSync("python3", [join(ROOT, "e2e/wm_close.py"), ...wins], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`не удалось закрыть окно: ${r.stderr}`);
}

/** Нажать пункт бокового меню по названию. */
export async function openSection(browser, title) {
  // Если предыдущий тест упал с открытым диалогом, закрываем его, чтобы не ронять следующие.
  if (await browser.$('[role="dialog"]').isExisting()) await browser.keys("Escape");
  const item = await browser.$(`//nav//button[normalize-space()="${title}"]`);
  await item.click();
  await browser.$(`//main//h1[normalize-space()="${title}"]`).waitForDisplayed({ timeout: 5000 });
}

/** Поле по атрибуту name (в открытом диалоге, если он есть). */
export async function field(browser, name) {
  // Один селектор вместо поиска внутри диалога: диалог может перерисоваться
  // между поисками, и ссылка на него устареет (stale element).
  const inDialog = await browser.$('[role="dialog"]').isExisting();
  return browser.$(inDialog ? `[role="dialog"] [name="${name}"]` : `[name="${name}"]`);
}

export async function fill(browser, name, value) {
  const el = await field(browser, name);
  await el.waitForDisplayed({ timeout: 5000 });
  // clearValue в WebKit не вызывает input: React при следующей перерисовке
  // возвращал старое значение, и новое дописывалось к нему («6000» + «6230»).
  // Очищаем так, чтобы React увидел изменение, и проверяем результат.
  await setDate(browser, name, "");
  await el.setValue(value);
  const got = await el.getValue();
  if (got !== value) throw new Error(`Поле ${name}: ожидалось «${value}», в поле «${got}»`);
}

export async function choose(browser, name, visibleText) {
  const el = await field(browser, name);
  await el.waitForDisplayed({ timeout: 5000 });
  await el.selectByVisibleText(visibleText);
}

/** Почему элемент не виден WebDriver: есть ли он, где он, что сверху, у кого из предков прозрачность. */
async function why(browser, el) {
  return browser
    .execute((b) => {
      if (!b) return "нет элемента";
      const r = b.getBoundingClientRect();
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      const faded = [];
      for (let n = b; n && n.nodeType === 1; n = n.parentElement) {
        const cs = getComputedStyle(n);
        if (cs.opacity !== "1" || cs.visibility !== "visible" || cs.display === "none")
          faded.push(`${n.tagName}.${n.className}: op=${cs.opacity} vis=${cs.visibility} disp=${cs.display} anim=${cs.animationName}`);
      }
      return `rect=${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)}x${Math.round(r.height)} win=${innerWidth}x${innerHeight}; text=«${(b.textContent || "").slice(0, 80)}»; сверху=${top?.outerHTML.slice(0, 160)}; предки=${faded.join(" | ")}`;
    }, el)
    .catch((e) => `диагностика не удалась: ${e.message}`);
}

/** Выбрать пункт списка, текст которого содержит `text` (подкатегории идут с отступом). */
export async function chooseLike(browser, name, text) {
  const el = await field(browser, name);
  await el.waitForDisplayed({ timeout: 5000 });
  const value = await browser.execute(
    (n, t) => {
      const sel = document.querySelector(`[role="dialog"] select[name="${n}"]`) ?? document.querySelector(`select[name="${n}"]`);
      return [...sel.options].find((o) => o.text.trim() === t)?.value ?? null;
    },
    name,
    text,
  );
  if (value === null) throw new Error(`В списке ${name} нет пункта «${text}»`);
  await el.selectByAttribute("value", value);
}

export async function click(browser, text, scope = "") {
  const el = await browser.$(`${scope}//button[normalize-space()="${text}"]`);
  // Кнопку ниже края окна WebKit не считает доступной, а внизу экрана её может закрыть
  // плашка «Отменить»: сначала ставим её в середину окна, потом ждём доступности.
  await el.waitForExist({ timeout: 5000 });
  await browser.execute((b) => {
    b.scrollIntoView({ block: "center" });
    // Внизу короткого экрана прокрутить некуда: плашку «Отменить» над кнопкой закрываем.
    const r = b.getBoundingClientRect();
    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    const bar = top?.closest('[data-testid="undo-bar"]');
    if (bar && !bar.contains(b)) bar.querySelector('button[aria-label="Закрыть"]')?.click();
  }, el);
  // Мышь к кнопке, как у пользователя: кнопки строки видны под мышкой, а прокрутка
  // выше могла увести строку из-под неё.
  await el.moveTo().catch(() => {});
  await el.waitForClickable({ timeout: 5000 }).catch(async (e) => {
    throw new Error(`Кнопка «${text}» недоступна: ${e.message}; ${await why(browser, el)}`);
  });
  await el.click().catch(async (e) => {
    // Что оказалось поверх кнопки: так проще понять «click intercepted».
    const top = await browser
      .execute((b) => {
        const r = b.getBoundingClientRect();
        return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.outerHTML.slice(0, 160);
      }, el)
      .catch(() => "");
    throw new Error(`Кнопка «${text}»: ${e.message}${top ? `; сверху: ${top}` : ""}`);
  });
}

/** Нажать «Сохранить» в диалоге и дождаться, что он закрылся (или вернуть текст ошибки). */
export async function save(browser, button = "Сохранить") {
  await click(browser, button, '//*[@role="dialog"]');
  // Каждый раз ищем заново: сохранённая ссылка на закрывшийся диалог устаревает.
  const open = () => browser.$('[role="dialog"]').isExisting();
  await browser.waitUntil(async () => !(await open()) || (await browser.$('[role="alert"]').isExisting()), {
    timeout: 5000,
  });
  if (await open()) throw new Error(`Диалог не закрылся: ${await browser.$('[role="alert"]').getText()}`);
}

export async function mainText(browser) {
  return browser.$("main").getText();
}

/** Дождаться, пока текст элемента станет подходящим. */
export async function waitText(browser, selector, re, timeout = 5000) {
  let last = "";
  await browser
    .waitUntil(
      async () => {
        const el = await browser.$(selector);
        last = (await el.isExisting()) ? await el.getText() : "";
        // Ниже края окна WebKit отдаёт пустой текст: прокручиваем к элементу и читаем снова.
        if (!re.test(last) && (await el.isExisting())) {
          await browser.execute((b) => b.scrollIntoView({ block: "nearest" }), el);
          last = await el.getText();
        }
        return re.test(last);
      },
      { timeout },
    )
    .catch(async () => {
      const el = await browser.$(selector);
      const info = (await el.isExisting()) ? await why(browser, el) : "нет элемента";
      throw new Error(`Текст ${selector} не совпал с ${re}: «${last}»; ${info}`);
    });
  return last;
}

/** Как waitText, но по textContent: WebKit не отдаёт через getText текст обрезаемых меток календаря. */
export async function waitContent(browser, selector, re, timeout = 5000) {
  let last = "";
  await browser
    .waitUntil(
      async () => {
        last = (await browser.execute((s) => document.querySelector(s)?.textContent ?? "", selector)) || "";
        return re.test(last);
      },
      { timeout },
    )
    .catch(() => {
      throw new Error(`Текст ${selector} не совпал с ${re}: «${last}»`);
    });
  return last;
}

/** Дождаться, пока элементов станет ровно `count` (список дорисовывается после клика). */
export async function waitCount(browser, selector, count, timeout = 5000) {
  let last = 0;
  await browser
    .waitUntil(
      async () => {
        last = await browser.execute((s) => document.querySelectorAll(s).length, selector);
        return last === count;
      },
      { timeout },
    )
    .catch(() => {
      throw new Error(`Элементов ${selector}: ${last}, ждали ${count}`);
    });
}

/** Пройти мастер первого запуска: rows = [{ name, type?, currency?, balance }]. */
export async function onboard(browser, rows, { categories = true } = {}) {
  await browser.$("//h1[normalize-space()='Основная валюта']").waitForDisplayed({ timeout: 15000 });
  await click(browser, "Далее");
  // В мастере два счёта по умолчанию: подгоняем их число под rows.
  for (let i = 2; i < rows.length; i++) await click(browser, "+ Добавить счёт");
  for (let i = rows.length; i < 2; i++) await (await browser.$$('button[aria-label="Убрать счёт"]'))[rows.length].click();
  for (const [i, r] of rows.entries()) {
    await fill(browser, `account-name-${i}`, r.name);
    if (r.type) await choose(browser, `account-type-${i}`, r.type);
    if (r.currency) await choose(browser, `account-currency-${i}`, r.currency);
    await fill(browser, `account-balance-${i}`, r.balance);
  }
  await click(browser, "Далее");
  if (!categories) await (await field(browser, "defaultCategories")).click();
  await click(browser, "Начать");
  await browser.$('//main//h1[normalize-space()="Главная"]').waitForDisplayed({ timeout: 10000 });
}

/** Регулярка для суммы вида «14 977,23 ₽»: пробелы в образце совпадают с любыми пробелами. */
export function money(text) {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(escaped.replace(/ /g, "[\\s\\u00A0]"));
}

/** Ввести дату в поле type=date так, чтобы React увидел изменение (WebKit не печатает в такие поля). */
export async function setDate(browser, name, value) {
  await browser.execute(
    (n, v) => {
      const el = document.querySelector(`[role="dialog"] [name="${n}"]`) ?? document.querySelector(`[name="${n}"]`);
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value").set.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    },
    name,
    value,
  );
}

/** Новый долг через форму расчёта (0.16): поля расчёта, затем «Записать заём» с кем и счётом.
 *  По умолчанию проценты «по месяцам» — так считались суммы в тестах до 0.16. */
export async function newDebt(browser, { counterparty, principal, rate, term, firstPayment, account, lent = false, repayment, maturity, daily = false }) {
  await openSection(browser, "Займы и долги");
  await click(browser, "+ Новый долг");
  await browser.$('//main//h1[contains(., "Новый долг")]').waitForDisplayed({ timeout: 5000 });
  if (repayment) await choose(browser, "repayment", repayment);
  await fill(browser, "principal", principal);
  if (rate) await fill(browser, "rate", rate);
  if (term) {
    await choose(browser, "termUnit", "месяцев");
    await fill(browser, "term", term);
  }
  if (maturity) await setDate(browser, "maturity", maturity);
  if (firstPayment) await setDate(browser, "firstPayment", firstPayment);
  await click(browser, daily ? "по дням, как банк" : "по месяцам");
  await browser.$('[data-testid="loan-payment"]').waitForDisplayed({ timeout: 5000 });
  await click(browser, "Записать заём");
  if (lent) await click(browser, "Я дал в долг", '//*[@role="dialog"]');
  await fill(browser, "counterparty", counterparty);
  if (account) await choose(browser, "account", account);
}
