import type { PointerEvent as ReactPointerEvent } from "react";
import type { HomeBlock } from "./homeLayout";
import { pastDragThreshold } from "./dragThreshold";
import "./directDrag.css";

type Destination<T> = { accepts: (item: T) => boolean; drop: (item: T) => Promise<unknown> | void };
let cancelCurrent: (() => void) | undefined;

// The click generated after pointerup can land on a button or open the source
// row. A fresh press (including one on the same control) is always independent.
function consumeDragClick() {
  const guard = new AbortController();
  window.addEventListener("pointerdown", () => guard.abort(), { capture: true, signal: guard.signal });
  window.addEventListener("click", (event) => {
    if (!event.detail) return;
    guard.abort();
    event.preventDefault();
    event.stopImmediatePropagation();
  }, { capture: true, signal: guard.signal });
}

function scrollParent(source: HTMLElement) {
  for (let parent = source.parentElement; parent; parent = parent.parentElement) {
    if (/auto|scroll/.test(getComputedStyle(parent).overflowY) && parent.scrollHeight > parent.clientHeight) return parent;
  }
  return document.scrollingElement;
}

// WebView2 reserves native file drops for Tauri. A pointer gesture inside the
// document coexists with dropping a statement from Explorer. Each type has
// its own destinations; a DOM id or arbitrary external payload cannot commit.
function directDrag<T>(kind: string) {
  const targets = new WeakMap<HTMLElement, Destination<T>>();
  const selector = '[data-drag-target="' + kind + '"]';

  function target(accepts: Destination<T>["accepts"], drop: Destination<T>["drop"]) {
    return {
      "data-drag-target": kind,
      ref: (node: HTMLElement | null) => {
        if (!node) return;
        targets.set(node, { accepts, drop });
        return () => { targets.delete(node); };
      },
    };
  }

  function start(event: ReactPointerEvent<HTMLElement>, item: T) {
    const source = event.currentTarget;
    const hit = event.target instanceof Element ? event.target : null;
    if (!event.isPrimary || event.button !== 0 || event.pointerType === "touch" || event.shiftKey || event.ctrlKey || event.metaKey ||
        hit?.closest("[data-drag-source]") !== source ||
        hit.closest('button, a, input, select, textarea, [contenteditable="true"]')) return;
    cancelCurrent?.();
    const controller = new AbortController();
    const listen = { capture: true, signal: controller.signal };
    const pointer = event.pointerId;
    const originX = event.clientX;
    const originY = event.clientY;
    let x = originX, y = originY;
    let active = false;
    let current: HTMLElement | null = null;
    let scroll: Element | null = null;
    let frame = 0;
    let lastScroll = 0;

    function highlight(next: HTMLElement | null) {
      if (current === next) return;
      current?.removeAttribute("data-drag-over");
      current = next;
      current?.setAttribute("data-drag-over", "");
    }
    function underPointer() {
      const element = document.elementFromPoint(x, y)?.closest<HTMLElement>(selector);
      return element && targets.get(element)?.accepts(item) ? element : null;
    }
    function finish() {
      if (controller.signal.aborted) return;
      controller.abort();
      cancelCurrent = undefined;
      cancelAnimationFrame(frame);
      highlight(null);
      if (active) {
        source.removeAttribute("data-drag-active");
        document.documentElement.removeAttribute("data-direct-drag");
        consumeDragClick();
      }
    }
    function edgeScroll(time: number) {
      frame = 0;
      if (!source.isConnected) return finish();
      if (!scroll) return;
      const bounds = scroll.getBoundingClientRect();
      const top = Math.max(0, bounds.top), bottom = Math.min(innerHeight, bounds.bottom);
      if (x < bounds.left || x > bounds.right || y < top || y > bottom) return;
      const edge = 42;
      const direction = y < top + edge ? -1 : y > bottom - edge ? 1 : 0;
      if (!direction) { lastScroll = 0; return; }
      const distance = direction < 0 ? y - top : bottom - y;
      const previous = scroll.scrollTop;
      const elapsed = lastScroll ? Math.min(32, time - lastScroll) : 16;
      lastScroll = time;
      scroll.scrollTop += direction * Math.max(1, Math.round(0.7 * elapsed * (1 - distance / edge)));
      if (scroll.scrollTop !== previous) {
        highlight(underPointer());
        frame = requestAnimationFrame(edgeScroll);
      }
    }
    cancelCurrent = finish;
    window.addEventListener("pointermove", (e) => {
      if (e.pointerId !== pointer) return;
      x = e.clientX; y = e.clientY;
      if (!(e.buttons & 1) || !source.isConnected || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return finish();
      if (!active) {
        if (!pastDragThreshold(x - originX, y - originY)) return;
        active = true;
        source.setAttribute("data-drag-active", "");
        document.documentElement.setAttribute("data-direct-drag", "");
        scroll = scrollParent(source);
      }
      e.preventDefault();
      highlight(underPointer());
      if (!frame) frame = requestAnimationFrame(edgeScroll);
    }, listen);
    window.addEventListener("pointerup", (e) => {
      if (e.pointerId !== pointer || e.button !== 0) return;
      x = e.clientX; y = e.clientY;
      const node = active && source.isConnected ? underPointer() : null;
      const destination = node && targets.get(node);
      finish();
      if (!destination || !node) return;
      const focus = document.activeElement;
      const restoreFocus = (element: HTMLElement) => {
        if (element.isConnected && document.hasFocus() && (document.activeElement === focus || document.activeElement === document.body)) {
          element.focus({ preventScroll: true });
        }
      };
      const result = destination.drop(item);
      // Opening a form owns its own focus. A saved move keeps a stable anchor.
      if (result) void result.then(() => restoreFocus(node), () => restoreFocus(source));
    }, listen);
    window.addEventListener("scroll", () => { if (active) highlight(underPointer()); }, listen);
    window.addEventListener("pointercancel", (e) => { if (e.pointerId === pointer) finish(); }, listen);
    window.addEventListener("lostpointercapture", (e) => { if (e.pointerId === pointer) finish(); }, listen);
    window.addEventListener("pointerout", (e) => { if (e.pointerId === pointer && !e.relatedTarget) finish(); }, listen);
    window.addEventListener("blur", finish, { signal: controller.signal });
    document.addEventListener("visibilitychange", () => { if (document.hidden) finish(); }, listen);
    window.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (active) { e.preventDefault(); e.stopImmediatePropagation(); }
      finish();
    }, listen);
  }
  return {
    source: (item: T) => ({ "data-drag-source": kind, onPointerDown: (e: ReactPointerEvent<HTMLElement>) => start(e, item) }),
    target,
  };
}

export const accountOrder = directDrag<string>("account-order");
export const categoryGroup = directDrag<string>("category-group");
export const calendarTxn = directDrag<{ id: string; date: string }>("calendar-txn");
export const spendAccount = directDrag<string>("spend-account");
export const homeBlock = directDrag<HomeBlock>("home-block");
