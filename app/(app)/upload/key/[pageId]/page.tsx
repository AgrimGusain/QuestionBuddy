"use client";

import { Plus, RotateCw, Scissors, Trash2, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { BoxEditor, type DraftBox } from "@/components/BoxEditor";
import { KeyEntryList } from "@/components/KeyEntryList";
import { ErrorNote, Loading } from "@/components/Status";
import { TopBar } from "@/components/TopBar";
import { useSignedUrls } from "@/components/useSignedUrls";
import { ZoomPane } from "@/components/ZoomPane";
import { describeParsed, parseAnswer } from "@/lib/answer-key/parse";
import {
  draftFromAi,
  emptyDraft,
  groupSolutions,
  keyWarnings,
  namedHeadings,
  regionWarnings,
  saveBlockers,
  saveEntries,
  setHeadingSection,
  setSectionForRange,
  type KeyDraft,
  type ShortDraft,
  type SolutionDraft,
} from "@/lib/answer-key/review";
import { isKeyResult } from "@/lib/answer-key/schema";
import { deleteWithFiles } from "@/lib/delete";
import { loadHierarchy, pathLabel, type Hierarchy } from "@/lib/hierarchy";
import { nextQuestionNumber, normalizeQuestionNumber } from "@/lib/number";
import { wakeQueueRunner } from "@/lib/queue/runner";
import { splitBox } from "@/lib/review";
import { supabase } from "@/lib/supabase/client";
import type { PageRow } from "@/lib/types";
import { uuid } from "@/lib/uuid";

const draftKey = (pageId: string) => `sqb:keydraft:${pageId}`;
const AI_PENDING: PageRow["status"][] = ["queued", "processing", "rate_limited"];
const POLL_MS = 4000;

const SAVE_ERRORS: Record<string, (numbers: string[]) => string> = {
  section_required: (n) => `Give these entries a section (or ignore them): ${n.join(", ")}.`,
  invalid_section: () => "One of the sections no longer exists. Pick the sections again.",
  page_already_saved: () => "This page was already saved.",
  original_unreadable: () => "The page photo couldn't be read. Delete this page and upload it again.",
  crop_upload_failed: () => "Uploading the solution images failed. Check your connection and save again.",
};

function readDraft(pageId: string): KeyDraft | null {
  try {
    const raw = localStorage.getItem(draftKey(pageId));
    return raw ? (JSON.parse(raw) as KeyDraft) : null;
  } catch {
    return null; // Ignore a corrupt draft.
  }
}

/** A new solution box below the last one, or at the top of the page. */
function newSolution(d: KeyDraft): SolutionDraft {
  const last = d.solutions[d.solutions.length - 1];
  const y0 = last && last.y1 + 0.12 <= 1 ? last.y1 + 0.005 : 0.05;
  return {
    id: uuid(),
    x0: last?.x0 ?? 0.04,
    x1: last?.x1 ?? 0.96,
    y0,
    y1: Math.min(1, y0 + 0.1),
    number: last ? nextQuestionNumber(last.number) : "1",
    type: "theory",
    append: false,
    text: "",
    options: null,
    sectionId: last?.sectionId ?? d.fallbackSectionId,
    manual: true,
    ignored: false,
    statedAnswer: null,
  };
}

export default function KeyReviewPage() {
  const { pageId } = useParams<{ pageId: string }>();
  const router = useRouter();
  const [page, setPage] = useState<PageRow | null>(null);
  const [h, setH] = useState<Hierarchy | null>(null);
  const [draft, setDraft] = useState<KeyDraft | null>(null);
  const [selected, setSelected] = useState<{ kind: "short" | "solution"; id: string } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedCount, setSavedCount] = useState<number | null>(null);
  const [splitting, setSplitting] = useState<{ boxId: string; t: number } | null>(null);
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null);
  const [range, setRange] = useState({ from: "", to: "", sectionId: "" });
  // Set once the draft came from storage or the model, so a late AI result never replaces edits.
  const populated = useRef(false);

  const sections = useMemo(() => (h && page ? h.sections.filter((s) => s.chapter_id === page.chapter_id) : []), [h, page]);

  useEffect(() => {
    let live = true;
    Promise.all([supabase().from("pages").select("*").eq("id", pageId).maybeSingle(), loadHierarchy()])
      .then(([res, hier]) => {
        if (res.error) throw new Error(res.error.message);
        const p = res.data as PageRow | null;
        if (!live) return;
        if (p && p.kind !== "answer_key") {
          router.replace(`/upload/${pageId}`);
          return;
        }
        setPage(p);
        setH(hier);
        const stored = readDraft(pageId);
        if (stored) {
          populated.current = true;
          setDraft(stored);
        } else if (p && isKeyResult(p.ai_result)) {
          populated.current = true;
          setDraft(draftFromAi(p.ai_result, hier.sections.filter((s) => s.chapter_id === p.chapter_id), p.section_id));
        } else if (p) {
          setDraft(emptyDraft(p.section_id));
        }
      })
      .catch((e) => live && setError(e.message))
      .finally(() => live && setLoaded(true));
    return () => {
      live = false;
    };
  }, [pageId, router]);

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

  // Fill in what the model read when it finishes — unless entries were already added by hand.
  useEffect(() => {
    if (!page || populated.current || !isKeyResult(page.ai_result)) return;
    populated.current = true;
    const fromAi = draftFromAi(page.ai_result, sections, page.section_id);
    setDraft((d) => (d && (d.shorts.length || d.solutions.length) ? d : fromAi));
  }, [page, sections]);

  // Keep a local draft so leaving the screen doesn't lose edits.
  useEffect(() => {
    if (!draft || savedCount !== null) return;
    try {
      if (draft.shorts.length || draft.solutions.length) localStorage.setItem(draftKey(pageId), JSON.stringify(draft));
    } catch {
      // Storage full or unavailable: the draft just isn't kept.
    }
  }, [draft, pageId, savedCount]);

  const imagePath = page ? (page.processed_path ?? page.original_path) : null;
  const urls = useSignedUrls("pages", imagePath ? [imagePath] : []);
  const imageUrl = imagePath ? urls[imagePath] : undefined;
  useEffect(() => {
    if (!imageUrl) return;
    const img = new Image();
    img.onload = () => setImgSize({ w: img.naturalWidth, h: img.naturalHeight });
    img.src = imageUrl;
  }, [imageUrl]);

  const groups = useMemo(() => (draft ? groupSolutions(draft.solutions) : []), [draft]);
  const warnings = useMemo(() => (draft ? keyWarnings(draft) : new Map<string, string[]>()), [draft]);
  const tableWarnings = useMemo(() => (draft ? regionWarnings(draft) : []), [draft]);

  if (!loaded) return <Loading />;
  if (!page || !draft) {
    return (
      <>
        <TopBar title="Review answer key" back="/upload" />
        <main className="px-4 py-4">
          <ErrorNote>{error ?? "This page no longer exists."}</ErrorNote>
        </main>
      </>
    );
  }

  const chapter = h?.chapters.find((c) => c.id === page.chapter_id);
  const summaryHref = chapter ? `/library/${chapter.subject_id}/${chapter.id}/answers` : "/library";

  if (page.status === "saved") {
    return (
      <>
        <TopBar title="Answer key saved" back="/upload" />
        <main className="space-y-4 px-4 py-6">
          <p className="text-lg">
            {savedCount !== null ? `Saved ${savedCount} ${savedCount === 1 ? "entry" : "entries"} and matched them to questions.` : "This answer key is already saved."}
          </p>
          <Link href={summaryHref} className="btn-primary w-full">
            See what matched
          </Link>
          <Link href="/upload" className="btn-secondary w-full">
            Add more pages
          </Link>
        </main>
      </>
    );
  }

  const update = (fn: (d: KeyDraft) => KeyDraft) => setDraft((d) => (d ? fn(d) : d));
  const selectedShort: ShortDraft | undefined = selected?.kind === "short" ? draft.shorts.find((s) => s.id === selected.id) : undefined;
  const selectedBox: SolutionDraft | undefined = selected?.kind === "solution" ? draft.solutions.find((s) => s.id === selected.id) : undefined;
  const selectedGroup = selectedBox ? groups.find((g) => g.boxes.some((b) => b.id === selectedBox.id)) : undefined;
  const flaggedCount = [...warnings.values()].length;
  const entryCount = draft.shorts.filter((s) => !s.ignored).length + groups.filter((g) => !g.ignored).length;
  const sectionName = (id: string | null) => sections.find((s) => s.id === id)?.name;

  function editShort(id: string, patch: Partial<ShortDraft>) {
    update((d) => ({ ...d, shorts: d.shorts.map((s) => (s.id === id ? { ...s, ...patch } : s)) }));
  }

  /** Number and text belong to one box; section and "ignored" to every part of its solution. */
  function editSolution(id: string, patch: Partial<SolutionDraft>) {
    update((d) => {
      const target = d.solutions.find((s) => s.id === id);
      if (!target) return d;
      const sameGroup = (s: SolutionDraft) =>
        s.sectionId === target.sectionId && normalizeQuestionNumber(s.number) === normalizeQuestionNumber(target.number);
      const groupWide = "sectionId" in patch || "ignored" in patch || "manual" in patch;
      return {
        ...d,
        solutions: d.solutions.map((s) => {
          if (s.id === id) {
            const flags = s.flags && "text" in patch ? { ...s.flags, unread: false } : s.flags;
            return { ...s, ...patch, flags };
          }
          return groupWide && sameGroup(s) ? { ...s, ...patch } : s;
        }),
      };
    });
  }

  function addShort() {
    const last = draft!.shorts[draft!.shorts.length - 1];
    const s: ShortDraft = {
      id: uuid(),
      number: last ? nextQuestionNumber(last.number) : "1",
      sectionId: last?.sectionId ?? draft!.fallbackSectionId,
      manual: true,
      raw: "",
      ignored: false,
      bbox: null,
    };
    update((d) => ({ ...d, shorts: [...d.shorts, s] }));
    setSelected({ kind: "short", id: s.id });
  }

  function addSolution() {
    const s = newSolution(draft!);
    update((d) => ({ ...d, solutions: [...d.solutions, s] }));
    setSelected({ kind: "solution", id: s.id });
  }

  function confirmSplit() {
    if (!splitting) return;
    const next = splitBox(draft!.solutions, splitting.boxId, splitting.t) as SolutionDraft[];
    const idx = next.findIndex((b) => b.id === splitting.boxId);
    update((d) => ({ ...d, solutions: next }));
    const bottom = next[idx + 1];
    if (bottom) setSelected({ kind: "solution", id: bottom.id }); // the new bottom half needs its number typed
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
    const blocker = saveBlockers(draft!);
    if (blocker) return setError(blocker);
    setSaving(true);
    const res = await fetch(`/api/pages/${pageId}/save-key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries: saveEntries(draft!) }),
    }).catch(() => null);
    const body = res ? await res.json().catch(() => ({})) : {};
    setSaving(false);
    if (!res?.ok) {
      const code = body.error as string | undefined;
      return setError(
        code && SAVE_ERRORS[code]
          ? SAVE_ERRORS[code](body.numbers ?? [])
          : res
            ? `Saving failed (${code ?? res.status}). Try again.`
            : "No connection. Your entries are kept on this phone; save again when you're online.",
      );
    }
    localStorage.removeItem(draftKey(pageId));
    setSavedCount(body.saved as number);
    setPage((p) => (p ? { ...p, status: "saved" } : p));
  }

  async function discard() {
    if (!window.confirm("Delete this answer-key page? Answers it gave that you haven't edited are removed too.")) return;
    try {
      localStorage.removeItem(draftKey(pageId));
      await deleteWithFiles({ pageId });
      router.replace("/upload");
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const sectionSelect = (value: string | null, onChange: (id: string | null) => void, id: string) => (
    <select id={id} className="field" value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">No section</option>
      {sections.map((s) => (
        <option key={s.id} value={s.id}>
          {s.name}
        </option>
      ))}
    </select>
  );

  const selectedWarnings = selectedShort ? warnings.get(selectedShort.id) : selectedGroup ? warnings.get(selectedGroup.id) : undefined;

  return (
    <>
      <TopBar
        title="Review answer key"
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
          <p className="mx-4 rounded-xl bg-sunken px-3 py-2 text-sm text-muted" role="status">
            Reading this answer key… the answers appear here when it&apos;s done. You can also add them yourself now.
          </p>
        )}
        {page.status === "failed" && (
          <div className="mx-4 space-y-2 rounded-xl border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad" role="alert">
            <p>Couldn&apos;t read this page automatically{page.error ? ` (${page.error})` : ""}. Add the answers yourself, or try again.</p>
            <button type="button" className="chip" onClick={retryAi}>
              <RotateCw size={14} aria-hidden /> Try again
            </button>
          </div>
        )}
        {(flaggedCount > 0 || tableWarnings.length > 0) && (
          <div className="mx-4 space-y-1 text-sm text-bad">
            {flaggedCount > 0 && (
              <p className="flex items-center gap-2">
                <TriangleAlert size={16} className="shrink-0" aria-hidden />
                Check the {flaggedCount === 1 ? "entry" : `${flaggedCount} entries`} marked ⚠ — tap one to see why.
              </p>
            )}
            {tableWarnings.map((w) => (
              <p key={w} className="flex items-center gap-2">
                <TriangleAlert size={16} className="shrink-0" aria-hidden />
                {w}
              </p>
            ))}
          </div>
        )}

        {imageUrl ? (
          <ZoomPane>
            <div className="relative">
              <BoxEditor
                imageUrl={imageUrl}
                boxes={draft.solutions}
                selectedId={selectedBox?.id ?? null}
                onSelect={(id) => !splitting && setSelected(id ? { kind: "solution", id } : null)}
                onChange={(boxes: DraftBox[]) => update((d) => ({ ...d, solutions: boxes as SolutionDraft[] }))}
                splitBoxId={splitting?.boxId ?? null}
                splitT={splitting?.t}
                onSplitDrag={(t) => setSplitting((s) => (s ? { ...s, t } : s))}
              />
              {/* Short-answer tables the model found: shown for reference, not editable. */}
              {draft.regions.map((r, i) => (
                <div
                  key={i}
                  aria-hidden
                  className="pointer-events-none absolute border-2 border-dashed border-accent"
                  style={{
                    left: `${r.bbox[0] * 100}%`,
                    top: `${r.bbox[1] * 100}%`,
                    width: `${(r.bbox[2] - r.bbox[0]) * 100}%`,
                    height: `${(r.bbox[3] - r.bbox[1]) * 100}%`,
                  }}
                >
                  <span className="absolute left-0 top-0 rounded-br-md bg-accent px-1.5 text-xs font-bold text-white">
                    Answers {r.first}–{r.last}
                  </span>
                </div>
              ))}
            </div>
          </ZoomPane>
        ) : (
          <div className="mx-4 h-96 animate-pulse rounded-xl bg-sunken" />
        )}

        <section className="space-y-3 px-4 pt-2">
          {namedHeadings(draft).length > 0 && (
            <div className="space-y-2">
              <h2 className="font-bold">Headings on this page</h2>
              {namedHeadings(draft).map((hd) => (
                <div key={hd.index} className="flex items-center gap-2">
                  <label htmlFor={`heading-${hd.index}`} className="min-w-0 flex-1 truncate text-sm">
                    “{hd.text}” is section
                  </label>
                  <div className="w-44 shrink-0">{sectionSelect(hd.sectionId, (id) => update((d) => setHeadingSection(d, hd.index, id)), `heading-${hd.index}`)}</div>
                </div>
              ))}
            </div>
          )}
          <div className="space-y-2">
            <h2 className="font-bold">Set the section for a range</h2>
            <div className="flex flex-wrap items-center gap-2">
              <input className="field w-16 text-center" aria-label="From number" placeholder="1" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />
              <span className="text-sm text-muted">to</span>
              <input className="field w-16 text-center" aria-label="To number" placeholder="36" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />
              <div className="min-w-36 flex-1">{sectionSelect(range.sectionId || null, (id) => setRange({ ...range, sectionId: id ?? "" }), "range-section")}</div>
              <button
                type="button"
                className="chip"
                disabled={!range.from || !range.to || !range.sectionId}
                onClick={() => update((d) => setSectionForRange(d, range.from, range.to, range.sectionId || null))}
              >
                Apply
              </button>
            </div>
          </div>

          <KeyEntryList
            draft={draft}
            groups={groups}
            sections={sections}
            warnings={warnings}
            selectedId={selected?.id ?? null}
            onSelect={(kind, id) => !splitting && setSelected({ kind, id })}
            imageUrl={imageUrl}
            imgSize={imgSize}
          />
          {!draft.shorts.length && !draft.solutions.length && !aiPending && (
            <p className="text-sm text-muted">No answers yet. Add them with “+ Entry”, or draw a box around each worked solution with “+ Solution”.</p>
          )}
        </section>
        <div className="h-[55vh]" aria-hidden />
      </main>

      {/* Action panel, fixed above the bottom navigation */}
      <div className="fixed inset-x-0 z-20 border-t border-line bg-surface" style={{ bottom: "calc(4rem + env(safe-area-inset-bottom, 0px))" }}>
        <div className="mx-auto max-h-[50vh] max-w-xl space-y-3 overflow-y-auto px-4 py-3">
          {error && <ErrorNote>{error}</ErrorNote>}
          {selectedWarnings?.map((w) => (
            <p key={w} className="text-sm text-bad">
              {w}
            </p>
          ))}
          {splitting ? (
            <>
              <p className="text-sm">Drag the red line to where the next solution starts.</p>
              <div className="grid grid-cols-2 gap-2">
                <button type="button" className="btn-secondary" onClick={() => setSplitting(null)}>
                  Cancel
                </button>
                <button type="button" className="btn-primary" onClick={confirmSplit}>
                  Split here
                </button>
              </div>
            </>
          ) : selectedShort ? (
            <>
              <div className="flex items-center gap-2">
                <label htmlFor="entry-number" className="text-sm font-bold text-muted">
                  Number
                </label>
                <input id="entry-number" className="field w-20 text-center text-lg font-bold" value={selectedShort.number} onChange={(e) => editShort(selectedShort.id, { number: e.target.value })} />
                <button
                  type="button"
                  className="btn-icon ml-auto text-bad"
                  aria-label="Delete entry"
                  onClick={() => {
                    update((d) => ({ ...d, shorts: d.shorts.filter((s) => s.id !== selectedShort.id) }));
                    setSelected(null);
                  }}
                >
                  <Trash2 size={20} aria-hidden />
                </button>
              </div>
              <div className="space-y-1">
                <label htmlFor="entry-section" className="text-sm font-bold text-muted">
                  Section
                </label>
                {sectionSelect(selectedShort.sectionId, (id) => editShort(selectedShort.id, { sectionId: id, manual: true }), "entry-section")}
              </div>
              <div className="space-y-1">
                <label htmlFor="entry-answer" className="text-sm font-bold text-muted">
                  Answer, as printed
                </label>
                <input id="entry-answer" className="field" value={selectedShort.raw} placeholder="(c), 4.5, 4.4 to 4.6…" onChange={(e) => editShort(selectedShort.id, { raw: e.target.value })} />
                <p className="text-sm text-muted">Read as: {describeParsed(parseAnswer(selectedShort.raw))}</p>
              </div>
              <label className="flex min-h-10 items-center gap-3 text-sm">
                <input type="checkbox" className="size-5 accent-[var(--accent)]" checked={selectedShort.ignored} onChange={(e) => editShort(selectedShort.id, { ignored: e.target.checked })} />
                Ignore this entry (keep it, but don&apos;t match it)
              </label>
              <button type="button" className="btn-primary w-full" onClick={() => setSelected(null)}>
                Done
              </button>
            </>
          ) : selectedBox && selectedGroup ? (
            <>
              <div className="flex items-center gap-2">
                <label htmlFor="solution-number" className="text-sm font-bold text-muted">
                  Number
                </label>
                <input id="solution-number" className="field w-20 text-center text-lg font-bold" value={selectedBox.number} onChange={(e) => editSolution(selectedBox.id, { number: e.target.value })} />
                {selectedGroup.boxes.length > 1 && (
                  <span className="text-sm text-muted">
                    Part {selectedGroup.boxes.findIndex((b) => b.id === selectedBox.id) + 1} of {selectedGroup.boxes.length}
                  </span>
                )}
                <button
                  type="button"
                  className="btn-icon ml-auto text-bad"
                  aria-label="Delete box"
                  onClick={() => {
                    update((d) => ({ ...d, solutions: d.solutions.filter((s) => s.id !== selectedBox.id) }));
                    setSelected(null);
                  }}
                >
                  <Trash2 size={20} aria-hidden />
                </button>
              </div>
              <div className="space-y-1">
                <label htmlFor="solution-section" className="text-sm font-bold text-muted">
                  Section
                </label>
                {sectionSelect(selectedBox.sectionId, (id) => editSolution(selectedBox.id, { sectionId: id, manual: true }), "solution-section")}
              </div>
              <div className="space-y-1">
                <label htmlFor="solution-text" className="text-sm font-bold text-muted">
                  Solution text
                </label>
                <textarea id="solution-text" className="field min-h-24" value={selectedBox.text} onChange={(e) => editSolution(selectedBox.id, { text: e.target.value })} />
                <p className="text-xs text-muted">The cropped image is saved as the solution; the text makes it searchable.</p>
              </div>
              <label className="flex min-h-10 items-center gap-3 text-sm">
                <input type="checkbox" className="size-5 accent-[var(--accent)]" checked={selectedBox.ignored} onChange={(e) => editSolution(selectedBox.id, { ignored: e.target.checked })} />
                Ignore this solution
              </label>
              <div className="grid grid-cols-3 gap-2">
                <button type="button" className="btn-secondary" onClick={() => setSplitting({ boxId: selectedBox.id, t: 0.5 })}>
                  <Scissors size={18} aria-hidden /> Split
                </button>
                <button type="button" className="btn-secondary" onClick={addSolution}>
                  <Plus size={18} aria-hidden /> Box
                </button>
                <button type="button" className="btn-primary" onClick={() => setSelected(null)}>
                  Done
                </button>
              </div>
              <p className="text-xs text-muted">Give two boxes the same number to join them into one solution (e.g. when it runs into the next column).</p>
            </>
          ) : (
            <div className="grid grid-cols-3 gap-2">
              <button type="button" className="btn-secondary" onClick={addShort}>
                <Plus size={18} aria-hidden /> Entry
              </button>
              <button type="button" className="btn-secondary" onClick={addSolution}>
                <Plus size={18} aria-hidden /> Solution
              </button>
              <button type="button" className="btn-primary" onClick={save} disabled={saving || entryCount === 0}>
                {saving ? "Saving…" : `Save ${entryCount}`}
              </button>
            </div>
          )}
          {!selected && !splitting && page.section_id && (
            <p className="text-xs text-muted">Entries with no heading above them go to {sectionName(page.section_id) ?? "the section picked at upload"}.</p>
          )}
        </div>
      </div>
    </>
  );
}
