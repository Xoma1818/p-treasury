import { brandMark } from "../lib/brandMark";

export function Brand({ large = false, iconOnly = false }: { large?: boolean; iconOnly?: boolean }) {
  const mark = brandMark();
  return (
    <div className={large ? "brand big" : "brand"} role="img" aria-label="Kazna">
      <svg className="brand-logo" width="28" height="28" viewBox={mark.viewBox} aria-hidden="true" focusable="false">
        <path d={mark.plate} fill="var(--palette-accent)" />
        <path d={mark.fold} fill="var(--palette-on-accent)" />
      </svg>
      {!iconOnly && <span className="brand-wordmark" aria-hidden="true">Kazna</span>}
    </div>
  );
}
