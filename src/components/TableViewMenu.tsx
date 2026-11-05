import { ArrowLeft, ArrowRight, Check, Columns3 } from "lucide-react";
import { COL_LABEL, DEFAULT_TABLE, FIXED_COLS, GROUP_LABEL, GROUPS, isDefaultTable, moveCol, saveTable, SORT_CHOICES, TABLE_COLS, toggleCol, type TxnTableLayout } from "../lib/txnTable";
import { usePopup } from "../lib/usePopup";

/** Г8: «Таблица» над списком операций — столбцы, их порядок и группы. Сортировка — по заголовкам. */
export function TableViewMenu({ layout }: { layout: TxnTableLayout }) {
  const { open, setOpen, ref } = usePopup();
  const custom = !isDefaultTable(layout);
  return (
    <div className="row-menu" ref={ref}>
      <button
        type="button"
        className={custom ? "btn small active" : "btn small"}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="table-view"
        onClick={() => setOpen(!open)}
        title="Столбцы, их порядок и группы"
      >
        <Columns3 size={14} strokeWidth={1.75} aria-hidden="true" /> Таблица
      </button>
      {open && (
        <div className="menu-pop head-menu table-menu" role="menu" data-testid="table-menu">
          <div className="menu-label first" role="presentation">
            Столбцы
          </div>
          {TABLE_COLS.map((c) => {
            const on = layout.cols.includes(c);
            const fixed = FIXED_COLS.includes(c);
            const i = layout.cols.indexOf(c);
            return (
              <div key={c} className="col-item">
                <button
                  role="menuitemcheckbox"
                  aria-checked={on}
                  aria-disabled={fixed || undefined}
                  className="menu-item check-item"
                  data-col={c}
                  title={fixed ? "Этот столбец виден всегда" : undefined}
                  onClick={() => saveTable(toggleCol(layout, c))}
                >
                  <span className="check-mark">{on && <Check size={14} aria-hidden />}</span>
                  {COL_LABEL[c]}
                </button>
                {on && (
                  <>
                    <button className="icon-btn small" aria-label={`«${COL_LABEL[c]}» левее`} data-move={`${c}:-1`} disabled={i === 0} onClick={() => saveTable(moveCol(layout, c, -1))}>
                      <ArrowLeft size={14} aria-hidden />
                    </button>
                    <button className="icon-btn small" aria-label={`«${COL_LABEL[c]}» правее`} data-move={`${c}:1`} disabled={i === layout.cols.length - 1} onClick={() => saveTable(moveCol(layout, c, 1))}>
                      <ArrowRight size={14} aria-hidden />
                    </button>
                  </>
                )}
              </div>
            );
          })}
          <div className="menu-label" role="presentation">
            Группировать
          </div>
          {GROUPS.map((g) => (
            <button key={g} role="menuitemradio" aria-checked={layout.group === g} className="menu-item check-item" data-group={g} onClick={() => saveTable({ ...layout, group: g })}>
              <span className="check-mark">{layout.group === g && <Check size={14} aria-hidden />}</span>
              {GROUP_LABEL[g]}
            </button>
          ))}
          <div className="menu-label" role="presentation">
            Порядок строк
          </div>
          {SORT_CHOICES.map((o) => {
            const on = layout.sort.by === o.by && layout.sort.desc === o.desc;
            return (
              <button key={`${o.by}:${o.desc}`} role="menuitemradio" aria-checked={on} className="menu-item check-item" data-sort-choice={`${o.by}:${o.desc ? "desc" : "asc"}`} onClick={() => saveTable({ ...layout, sort: { by: o.by, desc: o.desc } })}>
                <span className="check-mark">{on && <Check size={14} aria-hidden />}</span>
                {o.label}
              </button>
            );
          })}
          <p className="menu-note muted">Порядок меняется и нажатием на заголовок столбца.</p>
          {custom && (
            <button role="menuitem" className="menu-item" data-testid="table-reset" onClick={() => saveTable(DEFAULT_TABLE)}>
              Как было
            </button>
          )}
        </div>
      )}
    </div>
  );
}
