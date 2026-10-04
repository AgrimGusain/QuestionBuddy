"use client";

import { Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { BoxEditor, partOf, type DraftBox } from "@/components/BoxEditor";
import { ErrorNote, Loading } from "@/components/Status";
import { TopBar } from "@/components/TopBar";
import { useSignedUrls } from "@/components/useSignedUrls";
import { deleteWithFiles } from "@/lib/delete";
import { loadHierarchy, pathLabel, type Hierarchy } from "@/lib/hierarchy";
import { nextQuestionNumber, normalizeQuestionNumber } from "@/lib/number";
import { supabase } from "@/lib/supabase/client";
import { TYPE_SHORT, type PageRow, type QuestionType } from "@/lib/types";
import { uuid } from "@/lib/uuid";

const draftKey = (pageId: string) => `sqb:draft:${pageId}`;

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
    return { id: uuid(), x0: 0.04, y0: 0.05, x1: 0.96, y1: 0.18, number: "1", type: "mcq", append: false };
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
  };
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

export default function MarkBoxesPage() {
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

  useEffect(() => {
    Promise.all([supabase().from("pages").select("*").eq("id", pageId).maybeSingle(), loadHierarchy()])
      .then(([res, hier]) => {
        if (res.error) throw new Error(res.error.message);
        setPage(res.data as PageRow | null);
        setH(hier);
        try {
          const draft = localStorage.getItem(draftKey(pageId));
          if (draft) setBoxes(JSON.parse(draft));
        } catch {
          // Ignore a corrupt draft.
        }
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoaded(true));
  }, [pageId]);

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

  const urls = useSignedUrls("pages", page ? [page.original_path] : []);
  const imageUrl = page ? urls[page.original_path] : undefined;
  const groups = useMemo(() => groupBoxes(boxes), [boxes]);
  const selected = boxes.find((b) => b.id === selectedId) ?? null;
  const sectionName = (h && page?.section_id && h.sections.find((s) => s.id === page.section_id)?.name) || "this section";

  function edit(id: string, patch: Partial<DraftBox>) {
    setBoxes((list) => {
      const target = list.find((b) => b.id === id);
      if (!target) return list;
      // Type and "continues" belong to the whole question: apply to every part.
      const key = normalizeQuestionNumber(target.number);
      return list.map((b) => {
        if (b.id === id) return { ...b, ...patch };
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
        <TopBar title="Mark questions" back="/upload" />
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
              Mark the next page
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
        title="Mark questions"
        subtitle={h ? pathLabel(h, page.chapter_id, page.section_id) : undefined}
        back="/upload"
        right={
          <button type="button" className="btn-icon" aria-label="Delete this page" onClick={discard}>
            <Trash2 size={20} aria-hidden />
          </button>
        }
      />
      <main className="space-y-3 py-3">
        <p className="px-4 text-sm text-muted">
          Add a box for each question, then tap a box to move it, resize it or change its number. Give two boxes the
          same number to join them into one question.
        </p>
        {imageUrl ? (
          <BoxEditor imageUrl={imageUrl} boxes={boxes} selectedId={selectedId} onSelect={setSelectedId} onChange={setBoxes} />
        ) : (
          <div className="mx-4 h-96 animate-pulse rounded-xl bg-sunken" />
        )}
        <div className="h-56" aria-hidden />
      </main>

      {/* Action panel, fixed above the bottom navigation */}
      <div
        className="fixed inset-x-0 z-20 border-t border-line bg-surface"
        style={{ bottom: "calc(4rem + env(safe-area-inset-bottom, 0px))" }}
      >
        <div className="mx-auto max-w-xl space-y-3 px-4 py-3">
          {error && <ErrorNote>{error}</ErrorNote>}
          {selected ? (
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
              <div className="grid grid-cols-2 gap-2">
                <button type="button" className="btn-secondary" onClick={addBox}>
                  <Plus size={18} aria-hidden /> Next box
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
