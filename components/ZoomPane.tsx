"use client";

import { usePinch } from "@use-gesture/react";
import { useRef, useState } from "react";

const MAX_SCALE = 4;

/**
 * Pinch to zoom its content. Zooming widens the content instead of using a
 * CSS transform, so one-finger panning stays native scrolling and children
 * that measure themselves with getBoundingClientRect (BoxEditor) keep
 * working unchanged. touch-action "pan-x pan-y" leaves pinch to us, not the
 * browser; a selected box sets touch-action none on itself, so dragging it
 * never scrolls.
 */
export function ZoomPane({ children }: { children: React.ReactNode }) {
  const outer = useRef<HTMLDivElement>(null);
  const scaleRef = useRef(1);
  const [scale, setScale] = useState(1);

  function zoomTo(next: number, originX: number, originY: number) {
    const el = outer.current;
    if (!el || next === scaleRef.current) return;
    const rect = el.getBoundingClientRect();
    const ratio = next / scaleRef.current;
    const offsetX = originX - rect.left;
    const offsetY = originY - rect.top;
    const contentX = el.scrollLeft + offsetX;
    scaleRef.current = next;
    setScale(next);
    // Keep the point under the fingers still once the wider content has laid out.
    requestAnimationFrame(() => {
      el.scrollLeft = contentX * ratio - offsetX;
      window.scrollBy(0, offsetY * (ratio - 1));
    });
  }

  usePinch(({ offset: [s], origin: [ox, oy] }) => zoomTo(s, ox, oy), {
    target: outer,
    from: () => [scaleRef.current, 0],
    scaleBounds: { min: 1, max: MAX_SCALE },
    eventOptions: { passive: false },
  });

  return (
    <div className="relative">
      <div ref={outer} className="overflow-x-auto" style={{ touchAction: "pan-x pan-y" }}>
        <div style={{ width: `${scale * 100}%` }}>{children}</div>
      </div>
      {scale > 1 && (
        <button
          type="button"
          className="chip absolute right-2 top-2 z-20 bg-surface"
          onClick={() => {
            scaleRef.current = 1;
            setScale(1);
          }}
        >
          Reset zoom
        </button>
      )}
    </div>
  );
}
