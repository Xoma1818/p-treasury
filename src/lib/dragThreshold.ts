import { api, isTauri } from "./api";

let physical: [number, number] | null = null;

export function pastDragThreshold(dx: number, dy: number) {
  const scale = window.devicePixelRatio || 1;
  const x = physical ? physical[0] / scale : 5;
  const y = physical ? physical[1] / scale : 5;
  return Math.abs(dx) >= x || Math.abs(dy) >= y;
}

/** Read the user's drag rectangle before a gesture; never wait for IPC while moving. */
export function watchDragThreshold() {
  if (!isTauri()) return;
  let revision = 0;
  let ratio = window.devicePixelRatio;
  const refresh = () => {
    const request = ++revision;
    ratio = window.devicePixelRatio;
    void api.dragThreshold().then((value) => {
      if (revision === request) physical = value;
    }).catch(() => { /* The default rectangle remains usable. */ });
  };
  const resize = () => { if (ratio !== window.devicePixelRatio) refresh(); };
  refresh();
  window.addEventListener("focus", refresh);
  window.addEventListener("resize", resize);
  return () => {
    revision++;
    window.removeEventListener("focus", refresh);
    window.removeEventListener("resize", resize);
  };
}
