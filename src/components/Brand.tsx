import brandIcon from "../../src-tauri/icons/icon.svg";

export function Brand({ large = false }: { large?: boolean }) {
  return (
    <div className={large ? "brand big" : "brand"} role="img" aria-label="Kazna">
      <img className="brand-logo" src={brandIcon} width="28" height="28" alt="" />
      <span className="brand-wordmark" aria-hidden="true" />
    </div>
  );
}
