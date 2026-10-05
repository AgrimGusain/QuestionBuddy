"use client";

import { Plus, RotateCw, Scissors, Trash2, TriangleAlert, X } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { BoxEditor, isFlagged, partOf, type DraftBox } from "@/components/BoxEditor";
import { ErrorNote, Loading } from "@/components/Status";
import { TopBar } from "@/components/TopBar";
import { useSignedUrls } from "@/components/useSignedUrls";
import { ZoomPane } from "@/components/ZoomPane";
import { deleteWithFiles } from "@/lib/delete";
import { loadHierarchy, pathLabel, type Hierarchy } from "@/lib/hierarchy";
import { nextQuestionNumber, normalizeQuestionNumber } from "@/lib/number";
import { wakeQueueRunner } from "@/lib/queue/runner";
import { boxesFromAi, continuationTarget, mergedOptions, mergedText, splitBox } from "@/lib/review";
import { getSnapDisplay } from "@/lib/settings";
import { supabase } from "@/lib/supabase/client";
import { OPTION_LETTERS, TYPE_SHORT, type AiResult, type PageRow, type QuestionType } from "@/lib/types";
import { uuid } from "@/lib/uuid";

const draftKey = (pageId: string) => `sqb:draft:${pageId}`;
const AI_PENDING: PageRow["status"][] = ["queued", "processing", "rate_limited"];
const POLL_MS = 4000;
const MAX_OPTIONS = 8;
const isChoice = (t: QuestionType) => t === "mcq" || t === "msq";

interface Group {
  number: string;
  type: QuestionType;
  append: boolean;
  boxes: DraftBox[];
}

/** Boxes with the same number form one question; parts keep their order. */
function groupBoxes(boxes: DraftBox[]): Group[] {
  const groups = new Map<string, Group>();
  for (const b of boxes) {
    const k = normalizeQuestionNumber(b.number);
    const g = groups.get(k);
    if (g) g.boxes.push(b);
    else groups.set(k, { number: b.number.trim(), type: b.type, append: b.append, boxes: [b] });
  }
  return [...groups.values()];
}

/** A new box below the last one; jumps to the right column at the bottom of the left one. */
function newBox(boxes: DraftBox[]): DraftBox {
  const last = boxes[boxes.length - 1];
  if (!last) {
    return { id: uuid(), x0: 0.04, y0: 0.05, x1: 0.96, y1: 0.18, number: "1", type: "mcq", append: false, text: "", options: null };
  }
  const h = Math.min(0.13, Math.max(0.05, last.y1 - last.y0));
  let { x0, x1 } = last;
  let y0 = last.y1 + 0.005;
  if (y0 + h > 1) {
    const leftColumn = last.x1 < 0.62;
    y0 = 0.04;
    if (leftColumn) {
      x0 = 0.51;
      x1 = 0.97;
    }
  }
  return {
    id: uuid(),
    x0,
    x1,
    y0,
    y1: Math.min(1, y0 + h),
    number: nextQuestionNumber(last.number),
    type: last.type,
    append: false,
    text: "",
    options: null,
  };
}

function readDraft(pageId: string): DraftBox[] | null {
  try {
    const raw = localStorage.getItem(draftKey(pageId));
    if (!raw) return null;
    // Older (Phase 1) drafts have no text/options.
    return (JSON.parse(raw) as Partial<DraftBox>[]).map((b) => ({ ...b, text: b.text ?? "", options: b.options ?? null }) as DraftBox);
  } catch {
    return null; // Ignore a corrupt draft.
  }
}

/** The model's boxes, with a first block that continues an earlier page pointed at that page's last question. */
async function initialBoxes(page: PageRow): Promise<DraftBox[]> {
  if (!page.ai_result) return [];
  const boxes = boxesFromAi(page.ai_result, getSnapDisplay());
  const first = boxes[0];
  if (first?.flags?.continuesFromPrevious && page.section_id) {
    const prev = await supabase()
      .from("pages")
      .select("ai_result")
      .eq("section_id", page.section_id)
      .eq("kind", "questions")
      .neq("id", page.id)
      .lt("created_at", page.created_at)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const target = continuationTarget((prev.data as { ai_result: AiResult | null } | null) ?? null);
    if (target) boxes[0] = { ...first, number: target, append: true };
  }
  return boxes;
}

function cleanOptions(options: string[] | null): string[] | null {
  const cleaned = (options ?? []).map((o) => o.trim().slice(0, 500)).filter(Boolean).slice(0, MAX_OPTIONS);
  return cleaned.length ? cleaned : null;
}

const SAVE_ERRORS: Record<string, (numbers: string[], section: string) => string> = {
  number_exists: (n, s) =>
    n.length
      ? `${n.join(", ")} already ${n.length > 1 ? "exist" : "exists"} in ${s}. Change the number, or tick "Continues from an earlier page" if this is the rest of that question.`
      : `One of these numbers already exists in ${s}.`,
  append_target_missing: (n, s) => `There's no saved question ${n.join(", ")} in ${s} to continue. Untick "Continues from an earlier page".`,
  duplicate_in_page: (n) => `Number ${n.join(", ")} is used twice. Give each question its own number.`,
  page_already_saved: () => "This page was already saved.",
  original_unreadable: () => "The page photo couldn't be read. Delete this page and upload it again.",
  crop_upload_failed: () => "Uploading the question images failed. Check your connection and save again.",
};

/** A box's region of the page, cut out with CSS (no extra download), at most 320px tall. */
function CropPreview({ imageUrl, size, box }: { imageUrl: string; size: { w: number; h: number }; box: DraftBox }) {
  const w = box.x1 - box.x0;
  const h = box.y1 - box.y0;
  const aspect = (w * size.w) / (h * size.h);
  const pos = (start: number, span: number) => (span >= 0.999 ? 0 : (start / (1 - span)) * 100);
  return (
    <div
      aria-hidden
      className="rounded-lg border border-line bg-white"
      style={{
        width: `min(100%, ${Math.round(320 * aspect)}px)`,
        aspectRatio: `${aspect}`,
        backgroundImage: `url("${imageUrl}")`,
        backgroundSize: `${100 / w}% ${100 / h}%`,
        backgroundPosition: `${pos(box.x0, w)}% ${pos(box.y0, h)}%`,
        backgroundRepeat: "no-repeat",
      }}
    />
  );
}

function OptionsEditor({ options, onChange }: { options: string[]; onChange: (o: string[]) => void }) {
  return (
    <div className="space-y-2">
      {options.map((o, i) => (
        <div key={i} className="flex items-center gap-2">
          <span className="w-5 shrink-0 text-center text-sm font-bold text-muted">{OPTION_LETTERS[i] ?? i + 1}</span>
          <input
            className="field"
            aria-label={`Option ${i + 1}`}
            value={o}
            onChange={(e) => onChange(options.map((x, j) => (j === i ? e.target.value : x)))}
          />
          <button type="button" className="btn-icon shrink-0" aria-label={`Remove option ${i + 1}`} onClick={() => onChange(options.filter((_, j) => j !== i))}>
            <X size={16} aria-hidden />
          </button>
        </div>
      ))}
      {options.length < MAX_OPTIONS && (
        <button type="button" className="chip" onClick={() => onChange([...options, ""])}>
          <Plus size={14} aria-hidden /> Option
        </button>
      )}
    </div>
  );
}

export default function ReviewPage() {
  const { pageId } = useParams<{ pageId: string }>();
  const router = useRouter();
  const [page, setPage] = useState<PageRow | null>(null);
  const [h, setH] = useState<Hierarchy | null>(null);
  const [boxes, setBoxes] = useState<DraftBox[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedCount, setSavedCount] = useState<number | null>(null);
  const [nextPage, setNextPage] = useState<string | null>(null);
  const [splitting, setSplitting] = useState<{ boxId: string; t: number } | null>(null);
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null);
  const [debug, setDebug] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  // Set once boxes have come from a draft or the model, so a late AI result never replaces them.
  const populated = useRef(false);

  // Hidden debug toggle: open the page with ?debug to compare raw and snapped boxes.
  useEffect(() => {
    setDebug(new URLSearchParams(window.location.search).has("debug"));
  }, []);

  useEffect(() => {
    let live = true;
    Promise.all([supabase().from("pages").select("*").eq("id", pageId).maybeSingle(), loadHierarchy()])
      .then(async ([res, hier]) => {
        if (res.error) throw new Error(res.error.message);
        const p = res.data as PageRow | null;
        if (!live) return;
        setPage(p);
        setH(hier);
        const draft = readDraft(pageId);
        if (draft) {
          populated.current = true;
          setBoxes(draft);
        } else if (p?.ai_result) {
          populated.current = true;
          const initial = await initialBoxes(p);
          if (live) setBoxes(initial);
        }
      })
      .catch((e) => live && setError(e.message))
      .finally(() => live && setLoaded(true));
    return () => {
      live = false;
    };
  }, [pageId]);

  // While the model is still reading this page, check back for its result.
  const aiPending = !!page && AI_PENDING.includes(page.status);
  useEffect(() => {
    if (!aiPending) return;
    const id = setInterval(async () => {
      const res = await supabase().from("pages").select("*").eq("id", pageId).maybeSingle();
      if (res.data) setPage(res.data as PageRow);
    }, POLL_MS);
    return () => clearInterval(id);
  }, [aiPending, pageId]);

  // Fill in the model's boxes when it finishes — unless boxes were already drawn by hand meanwhile.
  useEffect(() => {
    if (!loaded || !page?.ai_result || populated.current) return;
    populated.current = true;
    if (boxes.length) return;
    initialBoxes(page).then((b) => setBoxes((current) => (current.length ? current : b)));
  }, [loaded, page, boxes.length]);

  // Keep a local draft so leaving the screen doesn't lose the boxes.
  useEffect(() => {
    if (!loaded || savedCount !== null) return;
    try {
      if (boxes.length) localStorage.setItem(draftKey(pageId), JSON.stringify(boxes));
      else localStorage.removeItem(draftKey(pageId));
    } catch {
      // Storage full or unavailable: the draft just isn't kept.
    }
  }, [boxes, loaded, pageId, savedCount]);

  // The boxes are positioned on the flattened copy when there is one.
  const imagePath = page ? (page.processed_path ?? page.original_path) : null;
  const urls = useSignedUrls("pages", imagePath ? [imagePath] : []);
  const imageUrl = imagePath ? urls[imagePath] : undefined;

  useEffect(() => {
    if (!imageUrl) return;
    const img = new Image();
    img.onload = () => setImgSize({ w: img.naturalWidth, h: img.naturalHeight });
    img.src = imageUrl;
  }, [imageUrl]);

  const groups = useMemo(() => groupBoxes(boxes), [boxes]);
  const selected = boxes.find((b) => b.id === selectedId) ?? null;
  const flaggedCount = boxes.filter(isFlagged).length;
  const sectionName = (h && page?.section_id && h.sections.find((s) => s.id === page.section_id)?.name) || "this section";

  function edit(id: string, patch: Partial<DraftBox>) {
    setBoxes((list) => {
      const target = list.find((b) => b.id === id);
      if (!target) return list;
      // Type and "continues" belong to the whole question: apply to every part.
      const key = normalizeQuestionNumber(target.number);
      return list.map((b) => {
        if (b.id === id) {
          // Editing the number answers the model's duplicate/gap warning;
          // editing the text or options answers its reading warning.
          let flags = b.flags;
          if (flags && "number" in patch) flags = { ...flags, duplicateNumber: false, sequenceGap: false };
          if (flags && ("text" in patch || "options" in patch)) flags = { ...flags, unread: false, optionsMismatch: false };
          return { ...b, ...patch, flags };
        }
        if (normalizeQuestionNumber(b.number) === key && ("type" in patch || "append" in patch)) {
          return { ...b, ...("type" in patch ? { type: patch.type! } : {}), ...("append" in patch ? { append: patch.append! } : {}) };
        }
        return b;
      });
    });
  }

  function addBox() {
    const b = newBox(boxes);
    setBoxes((list) => [...list, b]);
    setSelectedId(b.id);
  }

  function confirmSplit() {
    if (!splitting) return;
    const next = splitBox(boxes, splitting.boxId, splitting.t);
    const idx = next.findIndex((b) => b.id === splitting.boxId);
    setBoxes(next);
    setSelectedId(next[idx + 1]?.id ?? null); // the new bottom half needs its number typed
    setSplitting(null);
  }

  async function retryAi() {
    setError(null);
    const res = await supabase().from("pages").update({ status: "queued", error: null, retry_after: null, retry_count: 0 }).eq("id", pageId);
    if (res.error) return setError(res.error.message);
    wakeQueueRunner();
    setPage((p) => (p ? { ...p, status: "queued", error: null } : p));
  }

  async function save() {
    setError(null);
    const blank = boxes.find((b) => !normalizeQuestionNumber(b.number));
    if (blank) {
      setSelectedId(blank.id);
      return setError("Every box needs a question number.");
    }
    setSaving(true);
    const res = await fetch(`/api/pages/${pageId}/save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        questions: groups.map((g) => ({
          number: g.number,
          type: g.type,
          append: g.append,
          boxes: g.boxes.map(({ x0, y0, x1, y1 }) => ({ x0, y0, x1, y1 })),
          text: mergedText(g.boxes).slice(0, 4000),
          options: isChoice(g.type) ? cleanOptions(mergedOptions(g.boxes)) : null,
        })),
      }),
    }).catch(() => null);
    const body = res ? await res.json().catch(() => ({})) : {};
    setSaving(false);

    if (!res?.ok) {
      const code = body.error as string | undefined;
      const msg = code && SAVE_ERRORS[code]
        ? SAVE_ERRORS[code](body.numbers ?? [], sectionName)
        : res
          ? `Saving failed (${code ?? res.status}). Try again.`
          : "No connection. Your boxes are kept on this phone; save again when you're online.";
      return setError(msg);
    }

    localStorage.removeItem(draftKey(pageId));
    setSavedCount(body.saved as number);
    setPage((p) => (p ? { ...p, status: "saved" } : p));
    const next = await supabase()
      .from("pages")
      .select("id")
      .eq("kind", "questions")
      .in("status", ["uploaded", "needs_review"])
      .neq("id", pageId)
      .order("created_at")
      .limit(1)
      .maybeSingle();
    setNextPage((next.data?.id as string | undefined) ?? null);
  }

  async function discard() {
    if (!window.confirm("Delete this page photo? Questions already saved from it are kept.")) return;
    try {
      localStorage.removeItem(draftKey(pageId));
      await deleteWithFiles({ pageId });
      router.replace("/upload");
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (!loaded) return <Loading />;
  if (!page) {
    return (
      <>
        <TopBar title="Review questions" back="/upload" />
        <main className="px-4 py-4">
          <ErrorNote>{error ?? "This page no longer exists."}</ErrorNote>
        </main>
      </>
    );
  }

  const section = h && page.section_id ? h.sections.find((s) => s.id === page.section_id) : undefined;
  const chapter = h ? h.chapters.find((c) => c.id === page.chapter_id) : undefined;
  const libraryHref = chapter ? `/library/${chapter.subject_id}/${chapter.id}` : "/library";

  if (page.status === "saved") {
    return (
      <>
        <TopBar title="Page saved" back="/upload" />
        <main className="space-y-4 px-4 py-6">
          <p className="text-lg">
            {savedCount !== null
              ? `Saved ${savedCount} ${savedCount === 1 ? "question" : "questions"} to ${section?.name ?? "the section"}.`
              : "This page's questions are already in your library."}
          </p>
          {nextPage && (
            <Link href={`/upload/${nextPage}`} className="btn-primary w-full">
              Review the next page
            </Link>
          )}
          <Link href={libraryHref} className={`${nextPage ? "btn-secondary" : "btn-primary"} w-full`}>
            Open in library
          </Link>
          <Link href="/upload" className="btn-secondary w-full">
            Add more pages
          </Link>
        </main>
      </>
    );
  }

  const [part, parts] = selected ? partOf(boxes, selected) : [1, 1];

  return (
    <>
      <TopBar
        title="Review questions"
        subtitle={h ? pathLabel(h, page.chapter_id, page.section_id) : undefined}
        back="/upload"
        right={
          <button type="button" className="btn-icon" aria-label="Delete this page" onClick={discard}>
            <Trash2 size={20} aria-hidden />
          </button>
        }
      />
      <main className="space-y-3 py-3">
        {aiPending && (
          <p className="mx-4 flex items-center gap-2 rounded-xl bg-sunken px-3 py-2 text-sm text-muted" role="status">
            Reading this page… the boxes appear here when it&apos;s done. You can also draw them yourself now.
          </p>
        )}
        {page.status === "failed" && (
          <div className="mx-4 space-y-2 rounded-xl border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad" role="alert">
            <p>Couldn&apos;t read this page automatically{page.error ? ` (${page.error})` : ""}. Draw the boxes yourself, or try again.</p>
            <button type="button" className="chip" onClick={retryAi}>
              <RotateCw size={14} aria-hidden /> Try again
            </button>
          </div>
        )}
        {flaggedCount > 0 && (
          <p className="mx-4 flex items-center gap-2 text-sm text-bad">
            <TriangleAlert size={16} className="shrink-0" aria-hidden />
            Check the {flaggedCount === 1 ? "box" : `${flaggedCount} boxes`} marked ⚠ — tap one to see why.
          </p>
        )}
        <p className="px-4 text-sm text-muted">
          Tap a box to move it, resize it, split it, or fix its number, text and options. Boxes with the same number join into one
          question. Pinch to zoom.
        </p>
        {debug && (
          <label className="mx-4 flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-5 accent-[var(--accent)]" checked={showRaw} onChange={(e) => setShowRaw(e.target.checked)} />
            Show the model&apos;s raw boxes (dashed)
          </label>
        )}

        {imageUrl ? (
          <ZoomPane>
            <BoxEditor
              imageUrl={imageUrl}
              boxes={boxes}
              selectedId={selectedId}
              onSelect={(id) => !splitting && setSelectedId(id)}
              onChange={setBoxes}
              splitBoxId={splitting?.boxId ?? null}
              splitT={splitting?.t}
              onSplitDrag={(t) => setSplitting((s) => (s ? { ...s, t } : s))}
              showRaw={showRaw}
            />
          </ZoomPane>
        ) : (
          <div className="mx-4 h-96 animate-pulse rounded-xl bg-sunken" />
        )}

        {groups.length > 0 && imageUrl && imgSize && (
          <section className="space-y-2 px-4 pt-2">
            <h2 className="font-bold">Questions on this page</h2>
            <ul className="space-y-3">
              {groups.map((g) => {
                const text = mergedText(g.boxes);
                const flagged = g.boxes.some(isFlagged);
                return (
                  <li key={g.boxes[0].id}>
                    <button
                      type="button"
                      className={`card w-full space-y-2 p-3 text-left ${g.boxes.some((b) => b.id === selectedId) ? "border-accent" : ""}`}
                      onClick={() => !splitting && setSelectedId(g.boxes[0].id)}
                    >
                      <span className="flex items-center gap-2 font-bold">
                        {flagged && <TriangleAlert size={16} className="shrink-0 text-bad" aria-label="Needs checking" />}
                        {g.number || "No number"}
                        <span className="text-sm font-normal text-muted">{TYPE_SHORT[g.type]}</span>
                        {g.append && <span className="text-sm font-normal text-muted">· continues earlier page</span>}
                      </span>
                      {g.boxes.map((b) => (
                        <CropPreview key={b.id} imageUrl={imageUrl} size={imgSize} box={b} />
                      ))}
                      <span className={`block whitespace-pre-wrap text-sm ${text ? "" : "text-muted"}`}>{text || "No text read for this question."}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
        <div className="h-[55vh]" aria-hidden />
      </main>

      {/* Action panel, fixed above the bottom navigation */}
      <div
        className="fixed inset-x-0 z-20 border-t border-line bg-surface"
        style={{ bottom: "calc(4rem + env(safe-area-inset-bottom, 0px))" }}
      >
        <div className="mx-auto max-h-[50vh] max-w-xl space-y-3 overflow-y-auto px-4 py-3">
          {error && <ErrorNote>{error}</ErrorNote>}
          {splitting ? (
            <>
              <p className="text-sm">Drag the red line to where the second question starts.</p>
              <div className="grid grid-cols-2 gap-2">
                <button type="button" className="btn-secondary" onClick={() => setSplitting(null)}>
                  Cancel
                </button>
                <button type="button" className="btn-primary" onClick={confirmSplit}>
                  Split here
                </button>
              </div>
            </>
          ) : selected ? (
            <>
              <div className="flex items-center gap-2">
                <label htmlFor="box-number" className="text-sm font-bold text-muted">
                  Number
                </label>
                <input
                  id="box-number"
                  className="field w-24 text-center text-lg font-bold"
                  value={selected.number}
                  onChange={(e) => edit(selected.id, { number: e.target.value })}
                />
                {parts > 1 && <span className="text-sm text-muted">Part {part} of {parts}</span>}
                <button
                  type="button"
                  className="btn-icon ml-auto text-bad"
                  aria-label="Delete box"
                  onClick={() => {
                    setBoxes((list) => list.filter((b) => b.id !== selected.id));
                    setSelectedId(null);
                  }}
                >
                  <Trash2 size={20} aria-hidden />
                </button>
              </div>

              {selected.flags?.duplicateNumber && (
                <p className="text-sm text-bad">
                  This number was read twice on this page. If it&apos;s one question running across columns, keep the same number;
                  otherwise fix it.
                </p>
              )}
              {selected.flags?.sequenceGap && (
                <p className="text-sm text-bad">The number before this one looks skipped — check this number, or whether a question was missed.</p>
              )}
              {selected.flags?.unread && (
                <p className="text-sm text-bad">The model couldn&apos;t read this question&apos;s text. Type it below, or leave it blank.</p>
              )}
              {selected.flags?.optionsMismatch && (
                <p className="text-sm text-bad">The number of options read doesn&apos;t match what&apos;s printed — check the options below.</p>
              )}
              {selected.flags?.continuesFromPrevious && (
                <p className="text-sm text-bad">
                  {selected.append && selected.number
                    ? `This looks like the rest of question ${selected.number} from the previous page.`
                    : "This looks like the rest of a question from an earlier page: type its number and tick “Continues from an earlier page”."}
                </p>
              )}

              {part === 1 ? (
                <>
                  <div className="flex gap-2" role="radiogroup" aria-label="Question type">
                    {(["mcq", "msq", "numerical", "theory"] as QuestionType[]).map((t) => (
                      <button
                        key={t}
                        type="button"
                        role="radio"
                        aria-checked={selected.type === t}
                        className="chip flex-1 justify-center px-2"
                        onClick={() => edit(selected.id, { type: t })}
                      >
                        {TYPE_SHORT[t]}
                      </button>
                    ))}
                  </div>
                  <label className="flex min-h-10 items-center gap-3 text-sm">
                    <input
                      type="checkbox"
                      className="size-5 accent-[var(--accent)]"
                      checked={selected.append}
                      onChange={(e) => edit(selected.id, { append: e.target.checked })}
                    />
                    Continues from an earlier page (adds to the saved question)
                  </label>
                </>
              ) : (
                <p className="text-sm text-muted">Type and settings follow part 1 of this question.</p>
              )}

              <div className="space-y-1">
                <label htmlFor="box-text" className="text-sm font-bold text-muted">
                  Text
                </label>
                <textarea
                  id="box-text"
                  className="field min-h-24"
                  value={selected.text}
                  placeholder={selected.number ? "No text read — type it if you want it searchable." : undefined}
                  onChange={(e) => edit(selected.id, { text: e.target.value })}
                />
                {parts > 1 && <p className="text-xs text-muted">The question keeps the text of its first part that has any.</p>}
                {selected.append && <p className="text-xs text-muted">Text you typed on the saved question is never replaced.</p>}
              </div>

              {isChoice(selected.type) && (
                <div className="space-y-1">
                  <span className="text-sm font-bold text-muted">Options</span>
                  <OptionsEditor options={selected.options ?? []} onChange={(o) => edit(selected.id, { options: o })} />
                </div>
              )}

              <div className="grid grid-cols-3 gap-2">
                <button type="button" className="btn-secondary" onClick={() => setSplitting({ boxId: selected.id, t: 0.5 })}>
                  <Scissors size={18} aria-hidden /> Split
                </button>
                <button type="button" className="btn-secondary" onClick={addBox}>
                  <Plus size={18} aria-hidden /> Box
                </button>
                <button type="button" className="btn-primary" onClick={() => setSelectedId(null)}>
                  Done
                </button>
              </div>
            </>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <button type="button" className="btn-secondary" onClick={addBox}>
                <Plus size={18} aria-hidden /> Add box
              </button>
              <button type="button" className="btn-primary" onClick={save} disabled={saving || boxes.length === 0}>
                {saving
                  ? "Saving…"
                  : groups.length
                    ? `Save ${groups.length} ${groups.length === 1 ? "question" : "questions"}`
                    : "Save"}
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
