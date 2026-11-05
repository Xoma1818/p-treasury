import { Check, MoreHorizontal } from "lucide-react";
import { api, type Template } from "../lib/api";
import { today } from "../lib/dates";
import { DEFAULT_HEAD, isDefaultHead, saveHead, shownTemplates, toggleHead, useHeadBar } from "../lib/headBar";
import { useUi } from "../lib/store";
import { useAction } from "../lib/useAction";
import { usePopup } from "../lib/usePopup";
import { ExportButton, FORMATS, type useExport } from "./DataTools";
import { ErrorText } from "./Modal";
import { useTemplates } from "./Templates";

const IMPORT_TITLE = "Выписка банка (Excel, CSV, PDF) или таблица по шаблону. Файл можно просто перетащить в окно";

/** Г5: шапка «Операций». Видимые кнопки выбирает человек в «⋯»: «Загрузить выписку»,
 *  «Выгрузить», любимые шаблоны. Скрытые действия остаются в том же «⋯». */
export function TxnHeadBar({ onImport, exp }: { onImport: () => void; exp: ReturnType<typeof useExport> }) {
  const head = useHeadBar();
  const templates = useTemplates().data ?? [];
  const openTxnForm = useUi((s) => s.openTxnForm);
  const apply = useAction((id: string) => api.applyTemplate(id, today()));
  const { open, setOpen, ref } = usePopup();
  const pick = (t: Template) => {
    if (t.complete) return apply.run(t.id);
    api.templateUsed(t.id);
    openTxnForm({ mode: "new", type: t.type, prefill: { amount: t.amount, accountId: t.accountId, toAccountId: t.toAccountId, categoryId: t.categoryId, payee: t.payee, note: t.note } });
  };
  const shown = (id: string) => head.shown.includes(id);
  const pinned = shownTemplates(head, templates.map((t) => t.id)).map((id) => templates.find((t) => t.id === id)!);
  const run = (f: () => void) => () => (setOpen(false), f());
  const toggle = (id: string) => saveHead(toggleHead(head, id));
  const options: { id: string; text: string }[] = [
    { id: "import", text: "Загрузить выписку" },
    { id: "export", text: "Выгрузить" },
    ...templates.map((t) => ({ id: `tpl:${t.id}`, text: `Шаблон «${t.name}»` })),
  ];
  return (
    <>
      {pinned.map((t) => (
        <button key={t.id} className="btn" data-testid="head-template" onClick={() => pick(t)} title={t.complete ? "Записать операцию сейчас" : "Открыть форму с этими данными"}>
          {t.name}
        </button>
      ))}
      {shown("import") && (
        <button className="btn" data-testid="txn-import" onClick={onImport} title={IMPORT_TITLE}>
          Загрузить выписку
        </button>
      )}
      {shown("export") && <ExportButton exp={exp} title="Операции по текущему фильтру в CSV, Excel или OFX" />}
      <div className="row-menu" ref={ref}>
        <button className="icon-btn" aria-label="Ещё действия и кнопки шапки" aria-haspopup="menu" aria-expanded={open} data-testid="head-more" onClick={() => setOpen(!open)}>
          <MoreHorizontal size={18} aria-hidden />
        </button>
        {open && (
          <div className="menu-pop head-menu" role="menu" data-testid="head-menu">
            {!shown("import") && (
              <button role="menuitem" className="menu-item" onClick={run(onImport)}>
                Загрузить выписку
              </button>
            )}
            {!shown("export") &&
              exp.formats.map((f) => (
                <button key={f} role="menuitem" className="menu-item" data-format={f} onClick={run(() => exp.run(f))}>
                  {FORMATS[f].label.replace(/^Скачать/, "Выгрузить")}
                </button>
              ))}
            {templates
              .filter((t) => !shown(`tpl:${t.id}`))
              .map((t) => (
                <button key={t.id} role="menuitem" className="menu-item" onClick={run(() => pick(t))}>
                  {t.name}
                </button>
              ))}
            <div className="menu-label" role="presentation">
              Видно в шапке
            </div>
            {options.map((o) => (
              <button key={o.id} role="menuitemcheckbox" aria-checked={shown(o.id)} className="menu-item check-item" data-head={o.id} onClick={() => toggle(o.id)}>
                <span className="check-mark">{shown(o.id) && <Check size={14} aria-hidden />}</span>
                {o.text}
              </button>
            ))}
            {!isDefaultHead(head) && (
              <button role="menuitem" className="menu-item" data-testid="head-reset" onClick={() => saveHead(DEFAULT_HEAD)}>
                Как было
              </button>
            )}
          </div>
        )}
      </div>
      <ErrorText error={apply.error} />
    </>
  );
}
