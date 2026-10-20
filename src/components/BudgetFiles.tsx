import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, type BudgetFileRow } from "../lib/api";
import { pickOpen, DB } from "../lib/files";
import { useAction } from "../lib/useAction";
import { ErrorText } from "./Modal";

/** После смены файла все экраны начинают с чистого листа. */
const reload = () => window.location.reload();

/**
 * Несколько файлов бюджета: «Семья», «Дача», «Бизнес мамы». Каждый файл — свои
 * счета, операции и настройки; переключение — одной кнопкой.
 */
export function BudgetFilesCard() {
  const files = useQuery({ queryKey: ["files"], queryFn: api.listFiles }).data ?? [];
  const info = useQuery({ queryKey: ["appInfo"], queryFn: api.appInfo }).data;
  const [name, setName] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ path: string; name: string } | null>(null);
  const create = useAction((n: string) => api.createFile(n), reload);
  const open = useAction(async () => {
    const path = await pickOpen([DB]);
    if (path) await api.openFile(path);
    return path;
  }, (path) => path && reload());
  const switchTo = useAction((f: BudgetFileRow) => api.switchFile(f.path), reload);
  const rename = useAction((path: string, n: string) => api.renameFile(path, n), () => setRenaming(null));
  const forget = useAction((path: string) => api.forgetFile(path));
  const error = create.error ?? open.error ?? switchTo.error ?? rename.error ?? forget.error;

  return (
    <div className="card" data-testid="budget-files">
      <h2>Файлы бюджета</h2>
      <p className="muted">
        Отдельный файл — отдельные счета, операции и бюджет: например, «Дача» или «Бизнес». Переключаться можно в любой момент.
      </p>
      <ul className="file-list">
        {files.map((f) => (
          <li key={f.path} className={f.current ? "current" : undefined} data-testid="file-row" data-name={f.name}>
            {renaming?.path === f.path ? (
              <form
                className="inline-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  rename.run(f.path, renaming.name);
                }}
              >
                <input name="fileRename" value={renaming.name} autoFocus onChange={(e) => setRenaming({ ...renaming, name: e.target.value })} />
                <button className="btn small" type="submit">
                  Сохранить
                </button>
              </form>
            ) : (
              <span className="file-name">
                <b>{f.name}</b>
                {f.current && <span className="event-tag">открыт</span>}
                {f.missing && <span className="hint warn"> файла нет на месте</span>}
                <span className="sub">{f.path}</span>
              </span>
            )}
            <span className="row-actions">
              {!f.current && !f.missing && (
                <button className="link" onClick={() => switchTo.run(f)}>
                  Открыть
                </button>
              )}
              {!f.main && renaming?.path !== f.path && (
                <button className="link" onClick={() => setRenaming({ path: f.path, name: f.name })}>
                  Переименовать
                </button>
              )}
              {!f.main && !f.current && (
                <button className="link" onClick={() => forget.run(f.path)} title="Сам файл останется на диске">
                  Убрать из списка
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
      {name === null ? (
        <div className="btn-group">
          <button className="btn" onClick={() => setName("")}>
            + Новый файл
          </button>
          <button className="btn" onClick={() => open.run()} aria-busy={open.busy}>
            Открыть файл…
          </button>
        </div>
      ) : (
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            create.run(name);
          }}
        >
          <input name="fileName" placeholder="Название, например «Дача»" value={name} autoFocus onChange={(e) => setName(e.target.value)} />
          <button className="btn primary" type="submit" disabled={!name.trim() || create.busy}>
            Создать и открыть
          </button>
          <button type="button" className="link" onClick={() => setName(null)}>
            Не нужно
          </button>
        </form>
      )}
      <ErrorText error={error} />
      {info?.portable && (
        <p className="hint" data-testid="portable-note">
          Переносная версия: все данные лежат в папке {info.dataDir}. Обновления скачивайте вручную и копируйте программу поверх.
        </p>
      )}
    </div>
  );
}
