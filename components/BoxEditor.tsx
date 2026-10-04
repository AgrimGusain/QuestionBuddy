"use client";

import { useRef } from "react";
import { normalizeQuestionNumber } from "@/lib/number";
import type { QuestionType } from "@/lib/types";

export interface DraftBox {
  id: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  number: string;
  type: QuestionType;
  append: boolean; // continues a question saved from an earlier page
}

type Handle = "move" | "nw" | "ne" | "sw" | "se" | "n" | "s";

const MIN_W = 0.04;
const MIN_H = 0.015;
const COLORS = ["#2747c7", "#c2362b", "#18794e", "#a35f00", "#7b3fc4", "#0e7c86"];

const HANDLE_POS: Record<Exclude<Handle, "move">, { left: string; top: string }> = {
  nw: { left: "0%", top: "0%" },
  ne: { left: "100%", top: "0%" },
  sw: { left: "0%", top: "100%" },
  se: { left: "100%", top: "100%" },
  n: { left: "50%", top: "0%" },
  s: { left: "50%", top: "100%" },
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Colour per question: boxes sharing a number share a colour. */
export function groupColor(boxes: DraftBox[], box: DraftBox): string {
  const keys: string[] = [];
  for (const b of boxes) {
    const k = normalizeQuestionNumber(b.number);
    if (!keys.includes(k)) keys.push(k);
  }
  return COLORS[keys.indexOf(normalizeQuestionNumber(box.number)) % COLORS.length];
}

/** Part index (1-based) of a box within its question, and the part count. */
export function partOf(boxes: DraftBox[], box: DraftBox): [number, number] {
  const k = normalizeQuestionNumber(box.number);
  const same = boxes.filter((b) => normalizeQuestionNumber(b.number) === k);
  return [same.indexOf(box) + 1, same.length];
}

/**
 * The page photo with draggable question boxes. Tap a box to select it;
 * a selected box can be moved, and resized from its corners and top/bottom
 * edges. Unselected boxes let the page scroll normally under your finger.
 */
export function BoxEditor({
  imageUrl,
  boxes,
  selectedId,
  onSelect,
  onChange,
}: {
  imageUrl: string;
  boxes: DraftBox[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onChange: (boxes: DraftBox[]) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; handle: Handle; x: number; y: number; orig: DraftBox } | null>(null);

  const point = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  };

  const start = (e: React.PointerEvent, box: DraftBox, handle: Handle) => {
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const p = point(e);
    drag.current = { id: box.id, handle, x: p.x, y: p.y, orig: box };
  };

  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const p = point(e);
    const dx = p.x - d.x;
    const dy = p.y - d.y;
    const o = d.orig;
    let { x0, y0, x1, y1 } = o;
    if (d.handle === "move") {
      const w = o.x1 - o.x0;
      const h = o.y1 - o.y0;
      x0 = clamp(o.x0 + dx, 0, 1 - w);
      y0 = clamp(o.y0 + dy, 0, 1 - h);
      x1 = x0 + w;
      y1 = y0 + h;
    } else {
      if (d.handle.includes("w")) x0 = clamp(o.x0 + dx, 0, o.x1 - MIN_W);
      if (d.handle.includes("e")) x1 = clamp(o.x1 + dx, o.x0 + MIN_W, 1);
      if (d.handle.includes("n")) y0 = clamp(o.y0 + dy, 0, o.y1 - MIN_H);
      if (d.handle.includes("s")) y1 = clamp(o.y1 + dy, o.y0 + MIN_H, 1);
    }
    onChange(boxes.map((b) => (b.id === d.id ? { ...b, x0, y0, x1, y1 } : b)));
  };

  const end = () => {
    drag.current = null;
  };

  return (
    <div
      ref={ref}
      className="relative select-none bg-white"
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onClick={(e) => {
        if (e.target === e.currentTarget || (e.target as HTMLElement).tagName === "IMG") onSelect(null);
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={imageUrl} alt="Page photo" className="block w-full" draggable={false} />
      {boxes.map((b) => {
        const selected = b.id === selectedId;
        const color = groupColor(boxes, b);
        const [part, parts] = partOf(boxes, b);
        return (
          <div
            key={b.id}
            role="button"
            aria-label={`Question ${b.number || "without number"}${parts > 1 ? `, part ${part}` : ""}`}
            aria-pressed={selected}
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              onSelect(b.id);
            }}
            onKeyDown={(e) => e.key === "Enter" && onSelect(b.id)}
            onPointerDown={selected ? (e) => start(e, b, "move") : undefined}
            className="absolute"
            style={{
              left: `${b.x0 * 100}%`,
              top: `${b.y0 * 100}%`,
              width: `${(b.x1 - b.x0) * 100}%`,
              height: `${(b.y1 - b.y0) * 100}%`,
              border: `${selected ? 3 : 2}px solid ${color}`,
              background: selected ? `${color}22` : "transparent",
              touchAction: selected ? "none" : "auto",
              zIndex: selected ? 10 : 1,
            }}
          >
            <span
              className="absolute left-0 top-0 rounded-br-md px-1.5 text-sm font-bold text-white"
              style={{ background: color }}
            >
              {b.number || "?"}
              {parts > 1 ? ` (${part}/${parts})` : ""}
              {b.append ? " +" : ""}
            </span>
            {selected &&
              (Object.keys(HANDLE_POS) as (keyof typeof HANDLE_POS)[]).map((h) => (
                <span
                  key={h}
                  aria-hidden
                  onPointerDown={(e) => start(e, b, h)}
                  className="absolute size-8 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] bg-white shadow"
                  style={{ ...HANDLE_POS[h], borderColor: color, touchAction: "none" }}
                />
              ))}
          </div>
        );
      })}
    </div>
  );
}
