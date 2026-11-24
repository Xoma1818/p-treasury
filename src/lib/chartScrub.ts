import type { PointerEvent } from "react";

/** Шаг по указателю в координатах SVG с учётом полей viewBox и масштаба окна. */
export function chartScrub(firstX: number, lastX: number, lastStep: number, select: (step: number) => void) {
  function selectAt(event: PointerEvent<SVGSVGElement>) {
    const matrix = event.currentTarget.getScreenCTM();
    if (!matrix || !lastStep || firstX >= lastX) return;
    const { x } = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    if (!Number.isFinite(x)) return;
    const fraction = Math.max(0, Math.min(1, (x - firstX) / (lastX - firstX)));
    select(Math.round(fraction * lastStep));
  }

  return {
    onPointerDown(event: PointerEvent<SVGSVGElement>) {
      if (!event.isPrimary || event.button !== 0) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      selectAt(event);
    },
    onPointerMove(event: PointerEvent<SVGSVGElement>) {
      if (!event.isPrimary) return;
      // При прокрутке клавиатурой мышь может остаться над другой точкой без движения руки.
      const hovering = event.pointerType !== "touch" && event.buttons === 0 && (event.movementX !== 0 || event.movementY !== 0);
      if (event.currentTarget.hasPointerCapture(event.pointerId) || hovering) selectAt(event);
    },
    onPointerUp(event: PointerEvent<SVGSVGElement>) {
      if (event.isPrimary && event.currentTarget.hasPointerCapture(event.pointerId)) selectAt(event);
    },
  };
}
