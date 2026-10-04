"use client";

import { useCallback, useEffect, useState } from "react";
import { friendlyDbError, NamedList } from "@/components/NamedList";
import { ErrorNote, Loading } from "@/components/Status";
import { TopBar } from "@/components/TopBar";
import { deleteWithFiles } from "@/lib/delete";
import { fetchAll } from "@/lib/fetch-all";
import { invalidateHierarchy, loadHierarchy, type Hierarchy } from "@/lib/hierarchy";
import { supabase } from "@/lib/supabase/client";

export default function LibraryPage() {
  const [h, setH] = useState<Hierarchy | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [hier, rows] = await Promise.all([
        loadHierarchy(),
        fetchAll<{ subject_id: string }>((from, to) =>
          supabase().from("question_overview").select("subject_id").range(from, to),
        ),
      ]);
      const c: Record<string, number> = {};
      for (const r of rows) c[r.subject_id] = (c[r.subject_id] ?? 0) + 1;
      setH(hier);
      setCounts(c);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = async () => {
    invalidateHierarchy();
    await load();
  };

  return (
    <>
      <TopBar title="Library" />
      <main className="px-4 py-4">
        {error && <ErrorNote>{error}</ErrorNote>}
        {!h ? (
          !error && <Loading />
        ) : (
          <NamedList
            noun="subject"
            items={h.subjects.map((s) => ({
              id: s.id,
              name: s.name,
              href: `/library/${s.id}`,
              meta: `${counts[s.id] ?? 0} questions`,
            }))}
            onAdd={async (name) => {
              const { error } = await supabase().from("subjects").insert({ name });
              if (!error) await refresh();
              return friendlyDbError(error, name);
            }}
            onRename={async (id, name) => {
              const { error } = await supabase().from("subjects").update({ name }).eq("id", id);
              if (!error) await refresh();
              return friendlyDbError(error, name);
            }}
            onDelete={async (id) => {
              try {
                await deleteWithFiles({ subjectId: id });
                await refresh();
                return null;
              } catch (e) {
                return (e as Error).message;
              }
            }}
            deleteWarning={(s) =>
              `Delete ${s.name}? This removes its ${counts[s.id] ?? 0} questions, answers, practice history and page photos.`
            }
          />
        )}
      </main>
    </>
  );
}
