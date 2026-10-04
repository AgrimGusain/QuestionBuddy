"use client";

import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { friendlyDbError, NamedList } from "@/components/NamedList";
import { ErrorNote, Loading } from "@/components/Status";
import { TopBar } from "@/components/TopBar";
import { deleteWithFiles } from "@/lib/delete";
import { fetchAll } from "@/lib/fetch-all";
import { invalidateHierarchy, loadHierarchy, nextPosition, type Hierarchy } from "@/lib/hierarchy";
import { supabase } from "@/lib/supabase/client";

export default function SubjectPage() {
  const { subjectId } = useParams<{ subjectId: string }>();
  const [h, setH] = useState<Hierarchy | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [hier, rows] = await Promise.all([
        loadHierarchy(),
        fetchAll<{ chapter_id: string }>((from, to) =>
          supabase().from("question_overview").select("chapter_id").eq("subject_id", subjectId).range(from, to),
        ),
      ]);
      const c: Record<string, number> = {};
      for (const r of rows) c[r.chapter_id] = (c[r.chapter_id] ?? 0) + 1;
      setH(hier);
      setCounts(c);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [subjectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = async () => {
    invalidateHierarchy();
    await load();
  };

  const subject = h?.subjects.find((s) => s.id === subjectId);
  const chapters = h?.chapters.filter((c) => c.subject_id === subjectId) ?? [];

  return (
    <>
      <TopBar title={subject?.name ?? "Subject"} back="/library" />
      <main className="px-4 py-4">
        {error && <ErrorNote>{error}</ErrorNote>}
        {!h ? (
          !error && <Loading />
        ) : !subject ? (
          <ErrorNote>This subject no longer exists.</ErrorNote>
        ) : (
          <NamedList
            noun="chapter"
            items={chapters.map((c) => ({
              id: c.id,
              name: c.name,
              href: `/library/${subjectId}/${c.id}`,
              meta: `${counts[c.id] ?? 0} questions`,
            }))}
            onAdd={async (name) => {
              const { error } = await supabase()
                .from("chapters")
                .insert({ subject_id: subjectId, name, position: nextPosition(chapters) });
              if (!error) await refresh();
              return friendlyDbError(error, name);
            }}
            onRename={async (id, name) => {
              const { error } = await supabase().from("chapters").update({ name }).eq("id", id);
              if (!error) await refresh();
              return friendlyDbError(error, name);
            }}
            onDelete={async (id) => {
              try {
                await deleteWithFiles({ chapterId: id });
                await refresh();
                return null;
              } catch (e) {
                return (e as Error).message;
              }
            }}
            deleteWarning={(c) =>
              `Delete ${c.name}? This removes its ${counts[c.id] ?? 0} questions, answers, practice history and page photos.`
            }
          />
        )}
      </main>
    </>
  );
}
