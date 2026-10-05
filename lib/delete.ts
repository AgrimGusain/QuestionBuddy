import { fetchAll, inChunks } from "./fetch-all";
import { invalidateHierarchy } from "./hierarchy";
import { removeObjects } from "./storage";
import { supabase } from "./supabase/client";

export type DeleteScope =
  | { subjectId: string }
  | { chapterId: string }
  | { sectionId: string }
  | { questionId: string }
  | { pageId: string };

/**
 * Delete rows and their Storage files. Postgres cascades remove child rows,
 * but not files, so collect file paths first, delete the row, then the files.
 * If file removal fails the files are orphaned (harmless, just storage).
 */
export async function deleteWithFiles(scope: DeleteScope): Promise<void> {
  const db = supabase();
  const crops: string[] = [];
  const pages: string[] = [];

  if ("pageId" in scope) {
    const { data, error } = await db.from("pages").select("original_path, processed_path").eq("id", scope.pageId).maybeSingle();
    if (error) throw new Error(error.message);
    if (data) {
      pages.push(data.original_path as string);
      if (data.processed_path) pages.push(data.processed_path as string);
    }
    const del = await db.from("pages").delete().eq("id", scope.pageId);
    if (del.error) throw new Error(del.error.message);
    await removeObjects("pages", pages);
    return;
  }

  // Questions in scope
  const col = "subjectId" in scope ? "subject_id"
    : "chapterId" in scope ? "chapter_id"
    : "sectionId" in scope ? "section_id"
    : "question_id";
  const id = Object.values(scope)[0] as string;
  const questions = await fetchAll<{ question_id: string; image_paths: string[] }>((from, to) =>
    db.from("question_overview").select("question_id, image_paths").eq(col, id).range(from, to),
  );
  for (const q of questions) crops.push(...q.image_paths);

  const answerImages = await inChunks(questions.map((q) => q.question_id), async (chunk) => {
    const { data, error } = await db.from("answers").select("answer_image_path").in("question_id", chunk).not("answer_image_path", "is", null);
    if (error) throw new Error(error.message);
    return (data ?? []).map((a) => a.answer_image_path as string);
  });
  crops.push(...answerImages);

  // Page photos in scope (not for a single question)
  if (!("questionId" in scope)) {
    let chapterIds: string[] = [];
    if ("subjectId" in scope) {
      const { data, error } = await db.from("chapters").select("id").eq("subject_id", scope.subjectId);
      if (error) throw new Error(error.message);
      chapterIds = (data ?? []).map((c) => c.id as string);
    }
    const rows = await fetchAll<{ original_path: string; processed_path: string | null }>((from, to) => {
      const q = db.from("pages").select("original_path, processed_path").range(from, to);
      if ("sectionId" in scope) return q.eq("section_id", scope.sectionId);
      if ("chapterId" in scope) return q.eq("chapter_id", scope.chapterId);
      return q.in("chapter_id", chapterIds.length ? chapterIds : ["00000000-0000-0000-0000-000000000000"]);
    });
    for (const r of rows) {
      pages.push(r.original_path);
      if (r.processed_path) pages.push(r.processed_path);
    }
  }

  const table = "subjectId" in scope ? "subjects"
    : "chapterId" in scope ? "chapters"
    : "sectionId" in scope ? "sections"
    : "questions";
  const del = await db.from(table).delete().eq("id", id);
  if (del.error) throw new Error(del.error.message);
  if (table !== "questions") invalidateHierarchy();

  await removeObjects("crops", crops);
  await removeObjects("pages", pages);
}
