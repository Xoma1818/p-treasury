import { ArrowDown, ArrowUp, GripVertical, Plus } from "lucide-react";
import { useState, type ReactNode } from "react";
import { HOME_BLOCKS, moveBlock, placeBefore, resetLayout, toggleBlock, toggleHalf, withOverspendSlot, type HomeBlock, type HomeLayout } from "../lib/homeLayout";
import { homeBlock } from "../lib/directDrag";
import { useModules } from "../lib/modules";
import { useSettings } from "../lib/queries";
import { useUi } from "../lib/store";
import { CrashGuard } from "./Crash";
import { Hint } from "./Hint";
import { Modal } from "./Modal";

export function HomeCardsCard() {
  const settings = useSettings().data;
  const openEditor = useUi(s => s.openHomeEditor);
  return (
    <div className="card" data-testid="home-cards">
      <h2>Карточки Главной <Hint of="homeCards" /></h2>
      <p className="hint">Выберите карточки, расставьте их по порядку и задайте ширину прямо на Главной.</p>
      <button type="button" className="btn" onClick={openEditor} disabled={!settings}>Настроить Главную</button>
    </div>
  );
}

type EditCards = {
  busy: boolean;
  update: (next: HomeLayout, announcement: string) => void;
};

export function HomeLayoutTools({ layout, edit }: { layout: HomeLayout; edit: EditCards }) {
  const [catalog, setCatalog] = useState(false);
  const modules = useModules();
  const enabled = layout.order.filter(modules.blockOn);
  const available = enabled.filter(block => layout.hidden.includes(block));
  return (
    <div className="home-layout-tools" data-testid="home-editor">
      <div>
        <h2>Раскладка Главной</h2>
        <p className="hint">Карточки можно перетаскивать или двигать стрелками. Изменения видны сразу.</p>
      </div>
      <div className="home-layout-actions">
        <button type="button" className="btn" data-testid="home-catalog-open" disabled={edit.busy || !available.length}
          aria-haspopup="dialog" onClick={() => setCatalog(true)}>
          <Plus size={16} aria-hidden="true" /> Добавить карточку
        </button>
        <button type="button" className="link" data-testid="home-cards-default" disabled={edit.busy}
          onClick={() => edit.update(resetLayout(layout, enabled), "Восстановлено стандартное расположение. Сохраните его или отмените изменения.")}>
          Вернуть по умолчанию
        </button>
      </div>
      {catalog && (
        <Modal title="Добавить карточку" onClose={() => setCatalog(false)}>
          <ul className="home-catalog">
            {available.map(block => (
              <li key={block}>
                <button type="button" className="home-catalog-item" data-add-block={block} onClick={() => {
                  edit.update(toggleBlock(layout, block), `Добавлена карточка «${HOME_BLOCKS[block]}».`);
                  setCatalog(false);
                }}>
                  {HOME_BLOCKS[block]} <Plus size={16} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
          {available.length > 1 && (
            <button type="button" className="btn" data-testid="home-cards-all" onClick={() => {
              edit.update({ ...layout, hidden: layout.hidden.filter(block => !modules.blockOn(block)) }, "Добавлены все доступные карточки.");
              setCatalog(false);
            }}>Показать все</button>
          )}
        </Modal>
      )}
    </div>
  );
}

export function HomeCardGrid({ layout, childrenByBlock, overspendRef, edit }: {
  layout: HomeLayout;
  childrenByBlock: Record<HomeBlock, ReactNode>;
  overspendRef: (slot: HTMLDivElement | null) => void;
  edit: EditCards | null;
}) {
  const modules = useModules();
  const visible = layout.order.filter(b => modules.blockOn(b) && !layout.hidden.includes(b));
  const isHalf = (block: HomeBlock) => !!layout.half?.includes(block);
  const grouped = layout.groupedMain && visible.includes("accounts") && visible.includes("recent");
  const grid = withOverspendSlot(visible);

  // После распаковки прежней пары карточек React заменяет их родительский узел.
  // Вернём фокус действию, с которого пользователь изменил раскладку.
  function keepFocus(block: HomeBlock | undefined, control: string) {
    const previous = document.activeElement;
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active !== document.body && active !== previous) return;
      if (active === previous && previous instanceof HTMLButtonElement && previous.isConnected && !previous.disabled) return;
      const row = document.querySelector<HTMLElement>(`.home-grid [data-block="${block}"]`);
      const target = row?.querySelector<HTMLButtonElement>(`${control}:not(:disabled)`) ??
        row?.querySelector<HTMLButtonElement>(".home-block-actions button:not(:disabled)") ??
        document.querySelector<HTMLButtonElement>('[data-testid="home-catalog-open"]');
      target?.focus();
    });
  }

  function move(block: HomeBlock, next: HomeLayout) {
    const position = next.order.filter(b => visible.includes(b)).indexOf(block) + 1;
    edit?.update(next, `«${HOME_BLOCKS[block]}» — позиция ${position} из ${visible.length}.`);
  }

  function renderBlock(block: HomeBlock, child = false) {
    const title = HOME_BLOCKS[block];
    const body = <CrashGuard card={title}>{childrenByBlock[block]}</CrashGuard>;
    const className = [child ? "home-group-child" : "home-block", !child && isHalf(block) && "half", edit && "home-card-editing"].filter(Boolean).join(" ");
    if (!edit) return <div key={block} className={className} data-block={block}>{body}</div>;

    const index = visible.indexOf(block);
    return (
      <div key={block} className={className} data-block={block} data-testid="home-block" tabIndex={-1} data-insert-before=""
        {...homeBlock.target(
          src => !edit.busy && visible.includes(src) && src !== block && visible[visible.indexOf(src) + 1] !== block,
          src => move(src, placeBefore(layout, src, block, visible))
        )}>
        <div className="home-block-bar" {...(!edit.busy ? homeBlock.source(block) : {})}>
          <span className="home-block-title"><GripVertical className="grip" size={16} aria-hidden="true" />{title}</span>
          <div className="home-block-actions">
            <button type="button" className="icon-btn" aria-label={`Выше: ${title}`} title="Выше" disabled={edit.busy || index === 0}
              onClick={() => { keepFocus(block, '[title="Выше"]'); move(block, moveBlock(layout, block, -1, visible)); }}><ArrowUp size={15} aria-hidden="true" /></button>
            <button type="button" className="icon-btn" aria-label={`Ниже: ${title}`} title="Ниже" disabled={edit.busy || index === visible.length - 1}
              onClick={() => { keepFocus(block, '[title="Ниже"]'); move(block, moveBlock(layout, block, 1, visible)); }}><ArrowDown size={15} aria-hidden="true" /></button>
            <button type="button" className="link" data-testid="home-half" disabled={edit.busy}
              title="Изменить ширину карточки в широком окне"
              onClick={() => {
                keepFocus(block, '[data-testid="home-half"]');
                edit.update(toggleHalf(layout, block), `«${title}» — ${isHalf(block) ? "вся строка" : "половина строки"}.`);
              }}>
              {isHalf(block) ? "Во всю ширину" : "Половина"}
            </button>
            <button type="button" className="link" data-testid="home-hide" disabled={edit.busy} onClick={() => {
              keepFocus(visible[index + 1] ?? visible[index - 1], '[data-testid="home-hide"]');
              edit.update(toggleBlock(layout, block), `Карточка «${title}» скрыта. Вернуть её можно через «Добавить карточку».`);
            }}>Скрыть</button>
          </div>
        </div>
        <div className="home-block-body" inert>{body}</div>
      </div>
    );
  }

  return (
    <div className="home-grid">
      {grid.map(block => {
        if (block === "overspend") return <div key={block} className="home-overspend-slot" ref={overspendRef} inert={edit ? true : undefined} />;
        if (grouped && block === "recent") return null;
        if (grouped && block === "accounts") return (
          <div key="main" className={isHalf(block) ? "home-block half" : "home-block"} data-block="main">
            <div className="columns home">{renderBlock("accounts", true)}{renderBlock("recent", true)}</div>
          </div>
        );
        return renderBlock(block);
      })}
      {edit && visible.length > 1 && (
        <div className="home-drop-end" aria-hidden="true"
          {...homeBlock.target(block => !edit.busy && visible.includes(block) && visible.at(-1) !== block,
            block => move(block, moveBlock(layout, block, visible.length, visible)))}>
          Переместить в конец
        </div>
      )}
    </div>
  );
}
