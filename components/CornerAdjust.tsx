"use client";

import { useEffect, useRef, useState } from "react";
import { ErrorNote } from "@/components/Status";
import { detectCorners, flattenAndEnhance, type Point } from "@/lib/opencv";

type Handle = 0 | 1 | 2 | 3;

const FULL: [Point, Point, Point, Point] = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
];
const DISPLAY_MAX_EDGE = 1200;
const MAGNIFIER_SIZE = 96;
const MAGNIFIER_ZOOM = 3;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/**
 * Shown right after a photo is captured/picked, before upload. Lets the
 * user correct the auto-detected page corners (or start from the full
 * image if detection failed) and either flatten the perspective or skip.
 */
export function CornerAdjust({
  bitmap,
  onFlatten,
  onSkip,
}: {
  bitmap: ImageBitmap;
  onFlatten: (blob: Blob) => void;
  onSkip: () => void;
}) {
  const [corners, setCorners] = useState<[Point, Point, Point, Point] | null>(null);
  const [dragging, setDragging] = useState<Handle | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const magRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<Handle | null>(null);

  useEffect(() => {
    let live = true;
    detectCorners(bitmap)
      .then((c) => live && setCorners(c ?? FULL))
      .catch(() => live && setCorners(FULL));
    return () => {
      live = false;
    };
  }, [bitmap]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const scale = Math.min(1, DISPLAY_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  }, [bitmap]);

  function point(e: React.PointerEvent) {
    const r = containerRef.current!.getBoundingClientRect();
    return { x: clamp01((e.clientX - r.left) / r.width), y: clamp01((e.clientY - r.top) / r.height) };
  }

  function drawMagnifier(xFrac: number, yFrac: number) {
    const canvas = magRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const srcSize = MAGNIFIER_SIZE / MAGNIFIER_ZOOM;
    const cx = xFrac * bitmap.width;
    const cy = yFrac * bitmap.height;
    ctx.clearRect(0, 0, MAGNIFIER_SIZE, MAGNIFIER_SIZE);
    ctx.drawImage(bitmap, cx - srcSize / 2, cy - srcSize / 2, srcSize, srcSize, 0, 0, MAGNIFIER_SIZE, MAGNIFIER_SIZE);
    ctx.strokeStyle = "red";
    ctx.beginPath();
    ctx.moveTo(MAGNIFIER_SIZE / 2, 0);
    ctx.lineTo(MAGNIFIER_SIZE / 2, MAGNIFIER_SIZE);
    ctx.moveTo(0, MAGNIFIER_SIZE / 2);
    ctx.lineTo(MAGNIFIER_SIZE, MAGNIFIER_SIZE / 2);
    ctx.stroke();
  }

  function start(e: React.PointerEvent, handle: Handle) {
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    dragRef.current = handle;
    setDragging(handle);
    const p = point(e);
    drawMagnifier(p.x, p.y);
  }

  function move(e: React.PointerEvent) {
    const handle = dragRef.current;
    if (handle === null) return;
    const p = point(e);
    setCorners((c) => (c ? (c.map((pt, i) => (i === handle ? p : pt)) as [Point, Point, Point, Point]) : c));
    drawMagnifier(p.x, p.y);
  }

  function end() {
    dragRef.current = null;
    setDragging(null);
  }

  async function flatten() {
    if (!corners) return;
    setBusy(true);
    setError(null);
    try {
      const blob = await flattenAndEnhance(bitmap, corners);
      onFlatten(blob);
    } catch (e) {
      const msg = (e as Error).message === "opencv_load_failed" ? "Couldn't load the flattening tool." : "Couldn't flatten this photo.";
      setError(`${msg} Try Skip instead.`);
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <p className="px-4 text-sm text-muted">Drag the corners to match the page edges, then flatten — or skip to use the photo as-is.</p>
      <div
        ref={containerRef}
        className="relative select-none bg-black"
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
      >
        <canvas ref={canvasRef} className="block w-full" />
        {corners && (
          <svg className="pointer-events-none absolute inset-0 h-full w-full" preserveAspectRatio="none" viewBox="0 0 100 100">
            <polygon
              points={corners.map((c) => `${c.x * 100},${c.y * 100}`).join(" ")}
              fill="rgba(39,71,199,0.15)"
              stroke="var(--accent)"
              strokeWidth={0.5}
            />
          </svg>
        )}
        {corners &&
          corners.map((c, i) => (
            <span
              key={i}
              role="button"
              aria-label={`Corner handle ${i + 1}`}
              onPointerDown={(e) => start(e, i as Handle)}
              className="absolute size-10 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-accent bg-white/80"
              style={{ left: `${c.x * 100}%`, top: `${c.y * 100}%`, touchAction: "none" }}
            />
          ))}
      </div>
      {dragging !== null && (
        <canvas
          ref={magRef}
          width={MAGNIFIER_SIZE}
          height={MAGNIFIER_SIZE}
          className="pointer-events-none fixed left-1/2 top-4 z-30 -translate-x-1/2 rounded-full border-2 border-accent bg-white shadow-lg"
        />
      )}
      {error && <div className="px-4"><ErrorNote>{error}</ErrorNote></div>}
      <div className="grid grid-cols-2 gap-2 px-4">
        <button type="button" className="btn-secondary" onClick={onSkip} disabled={busy}>
          Skip
        </button>
        <button type="button" className="btn-primary" onClick={flatten} disabled={busy || !corners}>
          {busy ? "Flattening…" : "Flatten"}
        </button>
      </div>
    </div>
  );
}
