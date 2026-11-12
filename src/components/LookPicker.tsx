import { CATEGORY_COLORS, CATEGORY_ICONS, COLOR_LABEL, colorVar, type CategoryColor } from "../lib/categoryLook";

/** Р21/Р22: выбор значка и цвета — для категорий и счетов. `inherited` — подпись «как у родителя». */
export function LookPicker({
  icon,
  color,
  onIcon,
  onColor,
  inherited,
}: {
  icon: string | null;
  color: CategoryColor | null;
  onIcon: (v: string | null) => void;
  onColor: (v: CategoryColor | null) => void;
  inherited?: boolean;
}) {
  return (
    <>
      <div className="field" role="group" aria-label="Значок">
        <span className="label">Значок {inherited && !icon && <span className="muted small">— как у родителя</span>}</span>
        <div className="look-pick" data-testid="icon-pick">
          <button type="button" aria-pressed={!icon} title="Без значка" onClick={() => onIcon(null)}>
            —
          </button>
          {Object.entries(CATEGORY_ICONS).map(([k, v]) => (
            <button key={k} type="button" aria-pressed={icon === k} title={v.label} aria-label={v.label} data-icon={k} onClick={() => onIcon(k)}>
              <v.icon size={16} strokeWidth={1.9} aria-hidden="true" />
            </button>
          ))}
        </div>
      </div>
      <div className="field" role="group" aria-label="Цвет">
        <span className="label">Цвет {inherited && !color && <span className="muted small">— как у родителя</span>}</span>
        <div className="look-pick" data-testid="color-pick">
          <button type="button" aria-pressed={!color} title="Без цвета" onClick={() => onColor(null)}>
            —
          </button>
          {CATEGORY_COLORS.map((c) => (
            <button key={c} type="button" className="swatch-btn" aria-pressed={color === c} title={COLOR_LABEL[c]} aria-label={COLOR_LABEL[c]} data-color={c} onClick={() => onColor(c)}>
              <span style={{ background: colorVar(c) }} />
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
