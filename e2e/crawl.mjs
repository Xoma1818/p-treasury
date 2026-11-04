// Обход «нажать всё»: открывает каждый раздел на примере данных, нажимает каждую
// кнопку (и каждую кнопку в открывшемся окне один уровень) и записывает:
//  - ошибки JS и отклонённые вызовы ядра (invoke),
//  - кнопки, после которых на экране ничего не изменилось,
//  - текст ошибок, показанный пользователю.
// Запуск: xvfb-run -a node e2e/crawl.mjs > crawl.json
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start, stop } from "./app.mjs";

const SECTIONS = ["Главная", "Операции", "Календарь", "Бюджет", "Отчёты", "Взгляд вперёд", "Счета", "Займы и долги", "Категории", "Заметки", "Настройки"];
// Не нажимаем: заменяют данные целиком, закрывают программу или открывают другой файл.
const SKIP = /^(Удалить пример|Восстановить|Восстановить из копии|Открыть файл|Обновить|Перенести|Выйти|Новый файл|Начать заново|Сбросить все данные)/;
const OUT = mkdtempSync(join(tmpdir(), "kazna-crawl-"));
const findings = [];
const log = (kind, where, text, extra = "") => {
  findings.push({ kind, where, text, extra });
  console.error(`[${kind}] ${where} :: ${text} ${extra}`);
};

const HOOK = () => {
  if (window.__crawl) return;
  window.__crawl = { errs: [] };
  const push = (m) => window.__crawl.errs.push(String(m).slice(0, 300));
  window.addEventListener("error", (e) => push(`js: ${e.message}`));
  window.addEventListener("unhandledrejection", (e) => push(`promise: ${e.reason?.message ?? e.reason}`));
  const ce = console.error;
  console.error = (...a) => (push(`console: ${a.map(String).join(" ")}`), ce(...a));
  const inv = window.__TAURI_INTERNALS__.invoke;
  window.__TAURI_INTERNALS__.invoke = (cmd, args, opts) =>
    inv(cmd, args, opts).catch((e) => {
      if (!/^plugin:dialog/.test(cmd)) push(`invoke ${cmd}: ${typeof e === "string" ? e : JSON.stringify(e)}`);
      throw e;
    });
};

async function snapshot(b) {
  return b.execute(() => {
    const main = document.querySelector("main")?.innerText ?? "";
    const dlg = [...document.querySelectorAll('[role="dialog"]')].map((d) => d.innerText).join("|");
    const pressed = [...document.querySelectorAll("[aria-selected=true],[aria-pressed=true],[aria-expanded=true],input:checked")].length;
    const h1 = document.querySelector("main h1")?.textContent ?? "";
    const toast = document.querySelector('[data-testid="undo-bar"]')?.innerText ?? "";
    return `${h1}#${main.length}#${main.slice(0, 4000)}#${dlg}#${pressed}#${toast}#${document.activeElement?.tagName}`;
  });
}

async function errors(b) {
  return b.execute(() => {
    const e = window.__crawl?.errs.splice(0) ?? [];
    const shown = [...document.querySelectorAll(".error, [role=alert]")].map((x) => x.innerText.trim()).filter(Boolean);
    return { e, shown };
  });
}

async function home(b, section) {
  for (let i = 0; i < 3 && (await b.$('[role="dialog"]').isExisting()); i++) {
    await b.keys("Escape");
    const ask = await b.$('//*[@data-testid="unsaved-ask"]//button[normalize-space()="Закрыть"]');
    if (await ask.isExisting()) await ask.click().catch(() => {});
    await b.pause(150);
  }
  const item = await b.$(`//nav//button[normalize-space()="${section}"]`);
  await item.click();
  await b.$(`//main//h1[normalize-space()="${section}"]`).waitForDisplayed({ timeout: 5000 });
  await b.pause(300);
}

/** Видимые доступные кнопки в области: [{i, text}] */
async function buttons(b, scope) {
  return b.execute((scope) => {
    const root = document.querySelector(scope);
    if (!root) return [];
    return [...root.querySelectorAll("button, [role=button], a[href]")]
      .map((el, i) => ({ el, i }))
      .filter(({ el }) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && !el.disabled && getComputedStyle(el).visibility !== "hidden";
      })
      .map(({ el, i }) => ({ i, text: (el.innerText || el.getAttribute("aria-label") || el.title || "").trim().replace(/\s+/g, " ").slice(0, 60), role: el.getAttribute("role") ?? "" }));
  }, scope);
}

async function press(b, scope, i) {
  return b.execute(
    (scope, i) => {
      const el = document.querySelector(scope)?.querySelectorAll("button, [role=button], a[href]")[i];
      if (!el) return false;
      el.scrollIntoView({ block: "center" });
      // Файлы: «Сохранить как» получает путь во временной папке, «Открыть» — отмену.
      window.__ptPick = [window.__crawlSave ?? null];
      el.click();
      return true;
    },
    scope,
    i,
  );
}

async function tryButton(b, where, scope, btn, restore, depth) {
  if (!btn.text || SKIP.test(btn.text)) return;
  await b.execute((p) => (window.__crawlSave = p), join(OUT, `f${findings.length}-${Date.now()}.xlsx`));
  const before = await snapshot(b);
  const ok = await press(b, scope, btn.i);
  if (!ok) return;
  await b.pause(700);
  // Окно подтверждения «Удалить?» и т.п. — нажать подтверждение не будем, достаточно что открылось.
  const after = await snapshot(b);
  const { e, shown } = await errors(b);
  const label = `${where} → «${btn.text}»`;
  for (const x of e) log("error", label, x);
  for (const x of shown) log("shown", label, x);
  if (before === after && !e.length) log("noop", label, "на экране ничего не изменилось");
  // Один уровень внутрь нового окна.
  if (depth === 0) {
    const dlgNow = await b.$('[role="dialog"]').isExisting();
    const dlgBefore = before.split("#")[3] !== "";
    if (dlgNow && !dlgBefore) {
      const title = await b.execute(() => document.querySelector('[role="dialog"] h2, [role="dialog"] h1')?.textContent ?? "окно");
      const inner = await buttons(b, '[role="dialog"]');
      for (const ib of inner) {
        if (/^(Закрыть|Отмена|×|Позже|Удалить.*)$/i.test(ib.text) || ib.text === "") continue;
        await restore();
        await press(b, scope, btn.i);
        await b.pause(500);
        if (!(await b.$('[role="dialog"]').isExisting())) break;
        const cur = await buttons(b, '[role="dialog"]');
        const same = cur.find((c) => c.i === ib.i && c.text === ib.text);
        if (!same) continue;
        await tryButton(b, `${label} [${title}]`, '[role="dialog"]', same, restore, 1);
      }
    }
  }
  await restore();
}

const app = await start(undefined, { env: { PTREASURY_UPDATE_URL: "http://127.0.0.1:9/latest.json" } });
const b = app.browser;
try {
  await b.$("//h1[normalize-space()='Основная валюта']").waitForDisplayed({ timeout: 15000 });
  await b.execute(() => window.__TAURI_INTERNALS__.invoke("seed_demo"));
  await b.refresh();
  await b.$('//main//h1[normalize-space()="Главная"]').waitForDisplayed({ timeout: 15000 });
  for (const section of SECTIONS) {
    await b.execute(HOOK);
    const restoreTo = (tabs) => async () => {
      await home(b, section);
      await b.execute(HOOK);
      for (const t of tabs) {
        await press(b, "main", t);
        await b.pause(300);
      }
      await errors(b);
    };
    await restoreTo([])();
    const list = await buttons(b, "main");
    console.error(`# ${section}: ${list.length} кнопок`);
    for (const btn of list) {
      try {
        await tryButton(b, section, "main", btn, restoreTo([]), 0);
      } catch (err) {
        log("crawl", `${section} → «${btn.text}»`, err.message.slice(0, 200));
        await restoreTo([])().catch(() => {});
      }
      // Вкладки: пройти и их содержимое.
      if (btn.role === "tab") {
        try {
          await press(b, "main", btn.i);
          await b.pause(400);
          const inner = await buttons(b, "main");
          const known = new Set(list.map((x) => `${x.i}:${x.text}`));
          for (const ib of inner.filter((x) => !known.has(`${x.i}:${x.text}`))) {
            await tryButton(b, `${section} / ${btn.text}`, "main", ib, restoreTo([btn.i]), 0).catch((err) => log("crawl", `${section} / ${btn.text} → «${ib.text}»`, err.message.slice(0, 200)));
          }
        } catch (err) {
          log("crawl", `${section} / ${btn.text}`, err.message.slice(0, 200));
        }
        await restoreTo([])().catch(() => {});
      }
    }
  }
} finally {
  writeFileSync(process.env.CRAWL_OUT ?? join(OUT, "findings.json"), JSON.stringify(findings, null, 1));
  console.error(`# итог: ${findings.length} записей; файлы: ${OUT}`);
  await stop(b);
}
