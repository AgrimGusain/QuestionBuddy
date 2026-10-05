"use client";

import { Camera, LogOut, NotebookPen, Settings, Target } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Empty, ErrorNote, Loading } from "@/components/Status";
import { TopBar } from "@/components/TopBar";
import { fetchAll } from "@/lib/fetch-all";
import { loadHierarchy, pathLabel, type Hierarchy } from "@/lib/hierarchy";
import { supabase } from "@/lib/supabase/client";
import type { PageRow, QuestionOverview } from "@/lib/types";

type Row = Pick<QuestionOverview, "subject_id" | "is_starred" | "attempt_count">;

export default function HomePage() {
  const router = useRouter();
  const [h, setH] = useState<Hierarchy | null>(null);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [pending, setPending] = useState<PageRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const db = supabase();
    Promise.all([
      loadHierarchy(),
      fetchAll<Row>((from, to) =>
        db.from("question_overview").select("subject_id, is_starred, attempt_count").range(from, to),
      ),
      db
        .from("pages")
        .select("*")
        .in("status", ["uploaded", "needs_review"])
        .order("created_at")
        .limit(20),
    ])
      .then(([hier, qs, pages]) => {
        if (pages.error) throw new Error(pages.error.message);
        setH(hier);
        setRows(qs);
        setPending(pages.data as PageRow[]);
      })
      .catch((e) => setError(e.message));
  }, []);

  async function signOut() {
    await supabase().auth.signOut();
    router.replace("/login");
    router.refresh();
  }

  const headerActions = (
    <div className="flex gap-1">
      <Link href="/settings" className="btn-icon" aria-label="Settings">
        <Settings size={20} aria-hidden />
      </Link>
      <button type="button" className="btn-icon" aria-label="Sign out" onClick={signOut}>
        <LogOut size={20} aria-hidden />
      </button>
    </div>
  );

  return (
    <>
      <TopBar title="Snap Question Bank" right={headerActions} />
      <main className="space-y-6 px-4 py-4">
        {error && <ErrorNote>{error}</ErrorNote>}
        {!h || !rows ? (
          !error && <Loading />
        ) : (
          <>
            {pending.length > 0 && (
              <section className="space-y-2">
                <h2 className="font-bold">Pages waiting for review</h2>
                <ul className="card divide-y divide-line">
                  {pending.map((p) => (
                    <li key={p.id}>
                      <Link
                        href={p.kind === "answer_key" ? `/upload/key/${p.id}` : `/upload/${p.id}`}
                        className="flex items-center justify-between gap-3 px-4 py-3"
                      >
                        <span className="min-w-0 truncate">
                          {pathLabel(h, p.chapter_id, p.section_id)}
                          {p.kind === "answer_key" && <span className="text-muted"> · answer key</span>}
                        </span>
                        <span className="shrink-0 text-sm font-bold text-accent">{p.kind === "answer_key" ? "Review answers" : "Mark boxes"}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {rows.length === 0 ? (
              <Empty title="Your question bank is empty">
                <p>Photograph a textbook page and mark each question on it.</p>
                <Link href="/upload" className="btn-primary mt-4 w-full">
                  <Camera size={18} aria-hidden /> Add pages
                </Link>
              </Empty>
            ) : (
              <>
                <section className="grid grid-cols-2 gap-3">
                  <Link href="/practice" className="card flex flex-col gap-3 p-4 active:bg-sunken">
                    <Target size={28} className="text-accent" aria-hidden />
                    <span>
                      <span className="block text-lg font-bold">Practice</span>
                      <span className="text-sm text-muted">MCQ, MSQ and numericals</span>
                    </span>
                  </Link>
                  <Link href="/theory" className="card flex flex-col gap-3 p-4 active:bg-sunken">
                    <NotebookPen size={28} className="text-accent" aria-hidden />
                    <span>
                      <span className="block text-lg font-bold">Theory revision</span>
                      <span className="text-sm text-muted">Questions tagged theory</span>
                    </span>
                  </Link>
                </section>

                <section className="space-y-2">
                  <h2 className="font-bold">Your subjects</h2>
                  <ul className="card divide-y divide-line">
                    {h.subjects.map((s) => {
                      const mine = rows.filter((r) => r.subject_id === s.id);
                      const attempted = mine.filter((r) => r.attempt_count > 0).length;
                      return (
                        <li key={s.id}>
                          <Link href={`/library/${s.id}`} className="flex items-baseline justify-between gap-3 px-4 py-3">
                            <span className="font-bold">{s.name}</span>
                            <span className="text-sm text-muted">
                              {mine.length} questions, {attempted} tried
                            </span>
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              </>
            )}
          </>
        )}
      </main>
    </>
  );
}
