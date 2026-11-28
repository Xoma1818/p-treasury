import iconSvg from "../../src-tauri/icons/icon.svg?raw";

/** Те же два контура используют ярлык приложения, меню и годовой PNG. */
function readBrandMark() {
  const svg = new DOMParser().parseFromString(iconSvg, "image/svg+xml").querySelector("svg")!;
  return {
    viewBox: svg.getAttribute("viewBox")!,
    size: svg.viewBox.baseVal.height,
    plate: svg.querySelector("#plate")!.getAttribute("d")!,
    fold: svg.querySelector("#fold")!.getAttribute("d")!,
  };
}

let mark: ReturnType<typeof readBrandMark>;
export function brandMark() {
  return mark ??= readBrandMark();
}
