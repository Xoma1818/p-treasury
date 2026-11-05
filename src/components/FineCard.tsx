import { api } from "../lib/api";
import { DEFAULT_FINE, saveFine, useFine, type Fine } from "../lib/fine";
import { useSettings } from "../lib/queries";
import { SECTIONS } from "../lib/sections";
import { useAction } from "../lib/useAction";
import { Field } from "./Fields";
import { ErrorText } from "./Modal";

const UNUSUAL = ["15", "25", "40", "60"];
const CHECK_DAYS = ["7", "14", "30", "60", "90"];

/** Г12: «Тонкие настройки» — свёрнутый раздел для тех, кому важны мелочи. */
export function FineCard() {
  const f = useFine();
  const settings = useSettings().data;
  const set = useAction(api.setSetting);
  const put = (patch: Partial<Fine>) => saveFine({ ...f, ...patch });
  const custom = JSON.stringify(f) !== JSON.stringify(DEFAULT_FINE) || (settings?.unusual_percent ?? "25") !== "25" || (settings?.checks_days ?? "30") !== "30";
  return (
    <details className="card fine-card" data-testid="fine-card" open={custom || undefined}>
      <summary>
        <h2>Тонкие настройки</h2>
        <span className="muted">Экран при запуске, неделя, копейки, пороги подсказок</span>
      </summary>
      <div className="settings-list">
        <Field label="Экран при запуске">
          {(id) => (
            <select id={id} name="fineStart" value={f.start} onChange={(e) => put({ start: e.target.value as Fine["start"] })}>
              <option value="last">Где закончили</option>
              {SECTIONS.filter((s) => s.id !== "settings").map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Неделя начинается" hint="Для календаря и недельного вида.">
          {(id) => (
            <select id={id} name="fineWeek" value={f.week} onChange={(e) => put({ week: e.target.value as Fine["week"] })}>
              <option value="mon">С понедельника</option>
              <option value="sun">С воскресенья</option>
            </select>
          )}
        </Field>
        <Field label="Копейки" hint="Только на экране: в базе, выгрузках и расчётах суммы остаются точными.">
          {(id) => (
            <select id={id} name="fineKopecks" value={f.kopecks ? "1" : "0"} onChange={(e) => put({ kopecks: e.target.value === "1" })}>
              <option value="1">Показывать</option>
              <option value="0">Округлять до рублей</option>
            </select>
          )}
        </Field>
        <Field label="Валюта в суммах">
          {(id) => (
            <select id={id} name="fineCode" value={f.code ? "1" : "0"} onChange={(e) => put({ code: e.target.value === "1" })}>
              <option value="0">Значком: 1 200 ₽</option>
              <option value="1">Кодом: 1 200 RUB</option>
            </select>
          )}
        </Field>
        <Field label="«Необычно в этом месяце»" hint="С какого отклонения от обычного показывать трату на Главной.">
          {(id) => (
            <select id={id} name="fineUnusual" value={settings?.unusual_percent ?? "25"} onChange={(e) => set.run("unusual_percent", e.target.value)}>
              {UNUSUAL.map((v) => (
                <option key={v} value={v}>
                  На {v} % и больше
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="«Проверьте»" hint="За сколько последних дней искать дубли, крупные траты и подорожания.">
          {(id) => (
            <select id={id} name="fineChecks" value={settings?.checks_days ?? "30"} onChange={(e) => set.run("checks_days", e.target.value)}>
              {CHECK_DAYS.map((v) => (
                <option key={v} value={v}>
                  За {v} дней
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      {custom && (
        <button
          className="link"
          data-testid="fine-reset"
          onClick={() => {
            saveFine(DEFAULT_FINE);
            api.setSetting("unusual_percent", "25").then(() => set.run("checks_days", "30"));
          }}
        >
          Как было
        </button>
      )}
      <ErrorText error={set.error} />
    </details>
  );
}
