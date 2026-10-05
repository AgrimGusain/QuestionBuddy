"use client";

import { TriangleAlert } from "lucide-react";
import { describeParsed, parseAnswer } from "@/lib/answer-key/parse";
import type { KeyDraft, SolutionGroup } from "@/lib/answer-key/review";
import type { Section } from "@/lib/types";

/** A box's region of the page, cut out with CSS (no extra download), at most 160px tall. */
function SolutionThumb({ imageUrl, size, box }: { imageUrl: string; size: { w: number; h: number }; box: { x0: number; y0: number; x1: number; y1: number } }) {
  const w = box.x1 - box.x0;
  const h = box.y1 - box.y0;
  const aspect = (w * size.w) / (h * size.h);
  const pos = (start: number, span: number) => (span >= 0.999 ? 0 : (start / (1 - span)) * 100);
  return (
    <div
      aria-hidden
      className="rounded-lg border border-line bg-white"
      style={{
        width: `min(100%, ${Math.round(160 * aspect)}px)`,
        aspectRatio: `${aspect}`,
        backgroundImage: `url("${imageUrl}")`,
        backgroundSize: `${100 / w}% ${100 / h}%`,
        backgroundPosition: `${pos(box.x0, w)}% ${pos(box.y0, h)}%`,
        backgroundRepeat: "no-repeat",
      }}
    />
  );
}

/**
 * The entries read from an answer-key page: short answers (number, section,
 * the text read, what it was parsed as) and worked solutions (with a
 * thumbnail). Tapping a row selects it for editing.
 */
export function KeyEntryList({
  draft,
  groups,
  sections,
  warnings,
  selectedId,
  onSelect,
  imageUrl,
  imgSize,
}: {
  draft: KeyDraft;
  groups: SolutionGroup[];
  sections: Section[];
  warnings: Map<string, string[]>;
  selectedId: string | null;
  onSelect: (kind: "short" | "solution", id: string) => void;
  imageUrl?: string;
  imgSize: { w: number; h: number } | null;
}) {
  const sectionName = (id: string | null) => (id ? (sections.find((s) => s.id === id)?.name ?? "?") : "No section");

  return (
    <div className="space-y-4">
      {draft.shorts.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-bold">Answers ({draft.shorts.length})</h2>
          <ul className="divide-y divide-line rounded-xl border border-line">
            {draft.shorts.map((s) => {
              const warn = warnings.get(s.id);
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    className={`flex w-full items-center gap-3 px-3 py-2 text-left ${selectedId === s.id ? "bg-accent/10" : ""} ${s.ignored ? "opacity-50" : ""}`}
                    onClick={() => onSelect("short", s.id)}
                  >
                    <span className="w-10 shrink-0 font-bold">{s.number || "?"}</span>
                    <span className="min-w-0 flex-1">
                      <span className={`block ${s.ignored ? "line-through" : ""}`}>
                        <span className="text-muted">read </span>
                        <q>{s.raw || "—"}</q>
                        <span className="text-muted"> → </span>
                        {describeParsed(parseAnswer(s.raw))}
                      </span>
                      <span className={`block text-xs ${s.sectionId ? "text-muted" : "text-bad"}`}>
                        {s.ignored ? "Ignored" : sectionName(s.sectionId)}
                      </span>
                    </span>
                    {warn && <TriangleAlert size={16} className="shrink-0 text-bad" aria-label={warn.join(" ")} />}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {groups.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-bold">Worked solutions ({groups.length})</h2>
          <ul className="space-y-3">
            {groups.map((g) => {
              const warn = warnings.get(g.id);
              return (
                <li key={g.id}>
                  <button
                    type="button"
                    className={`card w-full space-y-2 p-3 text-left ${g.boxes.some((b) => b.id === selectedId) ? "border-accent" : ""} ${g.ignored ? "opacity-50" : ""}`}
                    onClick={() => onSelect("solution", g.id)}
                  >
                    <span className="flex items-center gap-2 font-bold">
                      {warn && <TriangleAlert size={16} className="shrink-0 text-bad" aria-label={warn.join(" ")} />}
                      {g.number || "No number"}
                      <span className={`text-sm font-normal ${g.sectionId ? "text-muted" : "text-bad"}`}>
                        {g.ignored ? "Ignored" : sectionName(g.sectionId)}
                      </span>
                      {g.boxes.length > 1 && <span className="text-sm font-normal text-muted">· {g.boxes.length} parts</span>}
                    </span>
                    {imageUrl && imgSize && g.boxes.map((b) => <SolutionThumb key={b.id} imageUrl={imageUrl} size={imgSize} box={b} />)}
                    <span className={`line-clamp-3 block whitespace-pre-wrap text-sm ${g.text.trim() ? "" : "text-muted"}`}>
                      {g.text.trim() || "No text read — the image is what gets saved."}
                    </span>
                    {g.statedAnswer && <span className="block text-sm text-muted">States: {g.statedAnswer}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
