"use client";

import { Camera, KeyRound, MoreHorizontal, Plus, Search } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { friendlyDbError } from "@/components/NamedList";
import { QuestionCard } from "@/components/QuestionCard";
import { Empty, ErrorNote, Loading } from "@/components/Status";
import { TopBar } from "@/components/TopBar";
import { useSignedUrls } from "@/components/useSignedUrls";
import { deleteWithFiles } from "@/lib/delete";
import { fetchAll } from "@/lib/fetch-all";
import { invalidateHierarchy, loadHierarchy, nextPosition, type Hierarchy } from "@/lib/hierarchy";
import { compareQuestionNumbers } from "@/lib/number";
import { supabase } from "@/lib/supabase/client";
import type { QuestionOverview } from "@/lib/types";

const COLUMNS =
  "question_id, section_id, chapter_id, subject_id, number, number_normalized, type, is_starred, is_theory, ocr_text, created_at, image_paths, thumbnail_path, has_answer, attempt_count, wrong_count, last_verdict, last_attempted_at";

type Filter = "starred" | "theory" | "unanswered";

export default function ChapterPage() {
  const { subjectId, chapterId } = useParams<{ subjectId: string; chapterId: string }>();
  const [h, setH] = useState<Hierarchy | null>(null);
  const [rows, setRows] = useState<QuestionOverview[] | null>(null);
  const [tab, setTab] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<Set<Filter>>(new Set());
  const [menuOpen, setMenuOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Debounce typing into the search box.
  useEffect(() => {
    const t = setTimeout(() => setSearch(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  const load = useCallback(async () => {
    try {
      const [hier, qs] = await Promise.all([
        loadHierarchy(),
        fetchAll<QuestionOverview>((from, to) => {
          let q = supabase().from("question_overview").select(COLUMNS).eq("chapter_id", chapterId).range(from, to);
          if (search) q = q.textSearch("search", search, { type: "websearch", config: "english" });
          return q;
        }),
      ]);
      setH(hier);
      setRows(qs);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [chapterId, search]);

  useEffect(() => {
    void load();
  }, [load]);

  const sections = useMemo(() => h?.sections.filter((s) => s.chapter_id === chapterId) ?? [], [h, chapterId]);
  const chapter = h?.chapters.find((c) => c.id === chapterId);
  const subject = h?.subjects.find((s) => s.id === subjectId);
  const activeSection = sections.find((s) => s.id === tab);

  const visible = useMemo(() => {
    if (!rows) return [];
    const order = new Map(sections.map((s, i) => [s.id, i]));
    return rows
      .filter((r) => tab === "all" || r.section_id === tab)
      .filter((r) => !filters.has("starred") || r.is_starred)
      .filter((r) => !filters.has("theory") || r.is_theory)
      .filter((r) => !filters.has("unanswered") || !r.has_answer)
      .sort(
        (a, b) =>
          (order.get(a.section_id) ?? 0) - (order.get(b.section_id) ?? 0) || compareQuestionNumbers(a.number, b.number),
      );
  }, [rows, tab, filters, sections]);

  const thumbs = useSignedUrls("crops", visible.map((r) => r.thumbnail_path));

  async function toggle(q: QuestionOverview, field: "is_starred" | "is_theory") {
    const value = !q[field];
    setRows((rs) => rs?.map((r) => (r.question_id === q.question_id ? { ...r, [field]: value } : r)) ?? null);
    const { error } = await supabase().from("questions").update({ [field]: value }).eq("id", q.question_id);
    if (error) {
      setError(error.message);
      setRows((rs) => rs?.map((r) => (r.question_id === q.question_id ? { ...r, [field]: !value } : r)) ?? null);
    }
  }

  async function addSection() {
    const name = window.prompt("New section name (e.g. Exercise 2)")?.trim();
    if (!name) return;
    const { data, error } = await supabase()
      .from("sections")
      .insert({ chapter_id: chapterId, name, position: nextPosition(sections) })
      .select("id")
      .single();
    if (error) return setError(friendlyDbError(error, name));
    invalidateHierarchy();
    await load();
    setTab(data.id as string);
  }

  async function renameSection() {
    if (!activeSection) return;
    const name = window.prompt("Rename section", activeSection.name)?.trim();
    if (!name || name === activeSection.name) return;
    const { error } = await supabase().from("sections").update({ name }).eq("id", activeSection.id);
    if (error) return setError(friendlyDbError(error, name));
    invalidateHierarchy();
    setMenuOpen(false);
    await load();
  }

  async function deleteSection() {
    if (!activeSection) return;
    const n = rows?.filter((r) => r.section_id === activeSection.id).length ?? 0;
    if (!window.confirm(`Delete ${activeSection.name}? This removes its ${n} questions, answers and page photos.`)) return;
    try {
      await deleteWithFiles({ sectionId: activeSection.id });
      setTab("all");
      setMenuOpen(false);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const toggleFilter = (f: Filter) =>
    setFilters((s) => {
      const n = new Set(s);
      if (n.has(f)) n.delete(f);
      else n.add(f);
      return n;
    });

  const uploadHref = `/upload?subject=${subjectId}&chapter=${chapterId}${activeSection ? `&section=${activeSection.id}` : ""}`;

  return (
    <>
      <TopBar
        title={chapter?.name ?? "Chapter"}
        subtitle={subject?.name}
        back={`/library/${subjectId}`}
        right={
          <div className="flex gap-1">
            <Link href={`/library/${subjectId}/${chapterId}/answers`} className="btn-icon" aria-label="Answer key matching">
              <KeyRound size={22} aria-hidden />
            </Link>
            <Link href={uploadHref} className="btn-icon" aria-label="Add pages to this chapter">
              <Camera size={22} aria-hidden />
            </Link>
          </div>
        }
      />
      <div
        className="sticky z-10 space-y-2 border-b border-line bg-bg/95 px-4 py-2 backdrop-blur"
        style={{ top: "calc(3.5rem + env(safe-area-inset-top, 0px))" }}
      >
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1" role="tablist" aria-label="Sections">
          {[{ id: "all", name: "All" }, ...sections].map((s) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={tab === s.id}
              aria-pressed={tab === s.id}
              className="chip shrink-0"
              onClick={() => {
                setTab(s.id);
                setMenuOpen(false);
              }}
            >
              {s.name}
            </button>
          ))}
          <button type="button" className="chip shrink-0" onClick={addSection} aria-label="Add section">
            <Plus size={16} aria-hidden /> Section
          </button>
        </div>
        <div className="relative">
          <Search size={18} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" aria-hidden />
          <input
            type="search"
            className="field pl-10"
            placeholder="Search question text"
            aria-label="Search question text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="flex items-center gap-2">
          {(
            [
              ["starred", "Starred"],
              ["theory", "Theory"],
              ["unanswered", "No answer"],
            ] as [Filter, string][]
          ).map(([f, label]) => (
            <button key={f} type="button" className="chip" aria-pressed={filters.has(f)} onClick={() => toggleFilter(f)}>
              {label}
            </button>
          ))}
          {activeSection && (
            <button
              type="button"
              className="btn-icon ml-auto"
              aria-label={`Options for ${activeSection.name}`}
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((o) => !o)}
            >
              <MoreHorizontal size={20} aria-hidden />
            </button>
          )}
        </div>
        {menuOpen && activeSection && (
          <div className="flex gap-2 pb-1">
            <button type="button" className="btn-secondary flex-1" onClick={renameSection}>
              Rename {activeSection.name}
            </button>
            <button type="button" className="btn-danger flex-1" onClick={deleteSection}>
              Delete section
            </button>
          </div>
        )}
      </div>

      <main className="space-y-3 px-4 py-4">
        {error && <ErrorNote>{error}</ErrorNote>}
        {!rows ? (
          !error && <Loading />
        ) : visible.length === 0 ? (
          search || filters.size ? (
            <Empty title="No questions match">Clear the search or filters to see everything in this chapter.</Empty>
          ) : (
            <Empty title="No questions here yet">
              <p>Photograph a page from this chapter and mark its questions.</p>
              <Link href={uploadHref} className="btn-primary mt-4 w-full">
                <Camera size={18} aria-hidden /> Add pages
              </Link>
            </Empty>
          )
        ) : (
          <>
            <p className="text-sm text-muted">{visible.length} questions</p>
            {visible.map((q) => (
              <QuestionCard key={q.question_id} q={q} thumbUrl={thumbs[q.thumbnail_path]} onToggle={(f) => toggle(q, f)} />
            ))}
          </>
        )}
      </main>
    </>
  );
}
