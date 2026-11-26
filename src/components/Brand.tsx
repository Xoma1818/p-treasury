import brandIcon from "../../src-tauri/icons/icon.svg";

export function Brand({ large = false, iconOnly = false }: { large?: boolean; iconOnly?: boolean }) {
  return (
    <div className={large ? "brand big" : "brand"} role="img" aria-label="Kazna">
      <img className="brand-logo" src={brandIcon} width="28" height="28" alt="" />
      {!iconOnly && <span className="brand-wordmark" aria-hidden="true">Kazna</span>}
    </div>
  );
}
