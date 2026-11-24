import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start, stop, onboard, openSettings, click, choose, fill, waitText } from "./app.mjs";

const dialog = '//*[@role="dialog"]';
let browser;
after(async () => { await stop(browser); });

test("профиль CSV сохраняется, повтор не дублирует операции, изменённый заголовок требует настройки", async () => {
  ({ browser } = await start());
  await onboard(browser, [{ name: "Карта для выписок", balance: "10000" }]);
  const folder = mkdtempSync(join(tmpdir(), "kazna-csv-profile-"));
  const statement = join(folder, "выписка.csv");
  const overlap = join(folder, "другая-выписка.csv");
  const changed = join(folder, "другой-формат.csv");
  const today = new Date();
  const date = `${String(today.getDate()).padStart(2, "0")}.${String(today.getMonth() + 1).padStart(2, "0")}.${today.getFullYear()}`;
  const rows = `${date};-65,00;Метро\n${date};-65,00;Метро\n`;
  writeFileSync(statement, "День;Сумма;Магазин\n" + rows);
  writeFileSync(overlap, "День;Сумма;Магазин\n" + rows);
  writeFileSync(changed, "День;Сумма;Описание\n" + rows);

  await openSettings(browser, "data");
  await click(browser, "Импорт выписки или CSV");
  const openCsv = async (path) => {
    await browser.execute((p) => (window.__ptPick = [p]), path);
    await click(browser, "Выбрать файл", dialog);
    await click(browser, "Настроить столбцы CSV", dialog);
    await browser.$('[data-testid="csv-profile-editor"] table').waitForDisplayed({ timeout: 5000 });
  };

  await openCsv(statement);
  const account = await browser.$('select[name="csvAccount"]');
  await account.selectByIndex(1);
  await choose(browser, "csv-column-date", "День");
  await choose(browser, "csv-column-signed", "Сумма");
  await choose(browser, "csv-column-payee", "Магазин");
  await fill(browser, "csvProfileName", "Мой CSV");
  await click(browser, "Сохранить профиль", dialog);
  await waitText(browser, '[data-testid="csv-profile-editor"] [role="status"]', /Профиль сохранён/);
  await click(browser, "Проверить строки", dialog);
  await waitText(browser, '[data-testid="import-summary"]', /строк 2, без ошибок 2/);
  await click(browser, "Загрузить 2", dialog);
  await waitText(browser, '[data-testid="import-done"]', /Загружено операций: 2/);

  await openCsv(statement);
  await choose(browser, "csvProfile", "Мой CSV");
  await click(browser, "Проверить строки", dialog);
  await waitText(browser, '[data-testid="import-summary"]', /уже загружено раньше 2/);

  await openCsv(overlap);
  await choose(browser, "csvProfile", "Мой CSV");
  await click(browser, "Проверить строки", dialog);
  await waitText(browser, '[data-testid="import-summary"]', /похожие строки 2/);
  await click(browser, "Разобрать 2 строки", dialog);
  assert.equal(await browser.$('input[name="statement-choice"][value^="link:"]').isExisting(), false);
  await browser.$('input[name="statement-choice"][value="skip"]').click();
  await click(browser, "К следующей строке", dialog);
  await browser.$('input[name="statement-choice"][value="add"]').click();
  await waitText(browser, '.statement-review [role="status"]', /Изменение остатка: −65(?:[.,]00)?\s*₽/);
  await click(browser, "К итогу", dialog);
  await click(browser, "Загрузить 1", dialog);
  await waitText(browser, '[data-testid="import-done"]', /Загружено операций: 1/);

  await openCsv(changed);
  await choose(browser, "csvProfile", "Мой CSV");
  await waitText(browser, '[data-testid="csv-profile-editor"] [role="status"]', /Заголовки файла отличаются/);
  assert.equal(await browser.$(`${dialog}//button[normalize-space()="Проверить строки"]`).isEnabled(), false);
  await click(browser, "Сопоставить заново", dialog);
  assert.equal(await browser.$('select[name="csv-column-date"]').getValue(), "");
});
