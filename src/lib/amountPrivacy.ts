import { createStore } from "zustand/vanilla";

/** До завершения последней записи суммы закрыты даже для старого ответа get_settings. */
export function createAmountPrivacy(initialMask = false) {
  const state = createStore(() => ({ masked: initialMask, failed: false, generation: 0 }));
  let intended: boolean | null = null;
  let revision = 0;
  let writes = Promise.resolve();

  function toggle(savedHidden: boolean, write: (hidden: boolean) => Promise<void>, guard: (on: boolean) => void) {
    const hidden = !(intended ?? (state.getState().masked || savedHidden));
    const request = ++revision;
    intended = hidden;
    state.setState(s => ({ masked: true, failed: false, generation: s.generation + 1 }));
    guard(true);
    writes = writes.then(async () => {
      if (request !== revision) return;
      try {
        await write(hidden);
        if (request !== revision) return;
        intended = null;
        guard(false);
        state.setState({ masked: false, failed: false });
      } catch {
        if (request !== revision) return;
        intended = null;
        state.setState({ masked: true, failed: true });
      }
    });
    return writes;
  }
  return { state, toggle };
}

// Оба окна Tauri используют один origin. В хранилище только защитная метка.
export const AMOUNT_GUARD = "kazna-amounts-pending";
export function guardActive() {
  try { return typeof localStorage !== "undefined" && localStorage.getItem(AMOUNT_GUARD) === "1"; }
  catch { return false; }
}
export function persistGuard(on: boolean) {
  try {
    if (on) localStorage.setItem(AMOUNT_GUARD, "1");
    else localStorage.removeItem(AMOUNT_GUARD);
  } catch { /* В этом окне остаётся синхронная защита в памяти. */ }
}
export const amountPrivacy = createAmountPrivacy(guardActive());
