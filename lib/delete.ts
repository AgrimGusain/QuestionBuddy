import { rematch } from "./answer-key/client";
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

/** Solution crops from answer keys: owned by their key entry, not by the question they answer. */
const isKeyImage = (path: string) => path.split("/")[1] === "keys";

/**
 * Delete rows and their Storage files. Postgres cascades remove child rows,
 * but not files, so collect file paths first, delete the row, then the files.
 * If file removal fails the files are orphaned (harmless, just storage).
 *
 * Answer keys: a key page is deleted by delete_answer_key_page() (one
 * transaction: removes the answers it wrote that weren't edited since, keeps
 * hand-edited ones, re-matches the chapter, returns the solution images no
 * longer used). Deleting a question or section leaves key entries (and their
 * images) in place, since the key page still exists; the chapter is then
 * matched again so those entries show as unmatched.
 */
export async function deleteWithFiles(scope: DeleteScope): Promise<void> {
  const db = supabase();
  const crops: string[] = [];
  const pages: string[] = [];

  if ("pageId" in scope) {
    const { data, error } = await db.from("pages").select("kind, original_path, processed_path").eq("id", scope.pageId).maybeSingle();
    if (error) throw new Error(error.message);
    if (data) {
      pages.push(data.original_path as string);
      if (data.processed_path) pages.push(data.processed_path as string);
    }
    if (data?.kind === "answer_key") {
      const rpc = await db.rpc("delete_answer_key_page", { p_page_id: scope.pageId });
      if (rpc.error) throw new Error(rpc.error.message);
      crops.push(...((rpc.data as string[] | null) ?? []));
    } else {
      const del = await db.from("pages").delete().eq("id", scope.pageId);
      if (del.error) throw new Error(del.error.message);
    }
    await removeObjects("crops", crops);
    await removeObjects("pages", pages);
    return;
  }

  // Questions in scope
  const col = "subjectId" in scope ? "subject_id"
    : "chapterId" in scope ? "chapter_id"
    : "sectionId" in scope ? "section_id"
    : "question_id";
  const id = Object.values(scope)[0] as string;
  const questions = await fetchAll<{ question_id: string; chapter_id: string; image_paths: string[] }>((from, to) =>
    db.from("question_overview").select("question_id, chapter_id, image_paths").eq(col, id).range(from, to),
  );
  for (const q of questions) crops.push(...q.image_paths);

  // Whole chapters going away take their answer keys (pages, entries, solution images) with them.
  let chapterIds: string[] = [];
  if ("subjectId" in scope) {
    const { data, error } = await db.from("chapters").select("id").eq("subject_id", scope.subjectId);
    if (error) throw new Error(error.message);
    chapterIds = (data ?? []).map((c) => c.id as string);
  } else if ("chapterId" in scope) {
    chapterIds = [scope.chapterId];
  }
  const keysGo = chapterIds.length > 0;

  const answerImages = await inChunks(questions.map((q) => q.question_id), async (chunk) => {
    const { data, error } = await db.from("answers").select("answer_image_path").in("question_id", chunk).not("answer_image_path", "is", null);
    if (error) throw new Error(error.message);
    return (data ?? []).map((a) => a.answer_image_path as string);
  });
  crops.push(...(keysGo ? answerImages : answerImages.filter((p) => !isKeyImage(p))));

  if (keysGo) {
    const entryImages = await inChunks(chapterIds, async (chunk) => {
      const { data, error } = await db.from("answer_key_entries").select("image_path").in("chapter_id", chunk).not("image_path", "is", null);
      if (error) throw new Error(error.message);
      return (data ?? []).map((e) => e.image_path as string);
    });
    crops.push(...entryImages);
  }

  // Page photos in scope (not for a single question)
  if (!("questionId" in scope)) {
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

  // The chapter whose answer-key entries may lose their question.
  let rematchChapter: string | null = null;
  if ("questionId" in scope) rematchChapter = questions[0]?.chapter_id ?? null;
  if ("sectionId" in scope) {
    const { data, error } = await db.from("sections").select("chapter_id").eq("id", scope.sectionId).maybeSingle();
    if (error) throw new Error(error.message);
    rematchChapter = (data?.chapter_id as string | undefined) ?? null;
  }

  const table = "subjectId" in scope ? "subjects"
    : "chapterId" in scope ? "chapters"
    : "sectionId" in scope ? "sections"
    : "questions";
  const del = await db.from(table).delete().eq("id", id);
  if (del.error) throw new Error(del.error.message);
  if (table !== "questions") invalidateHierarchy();

  if (rematchChapter) await rematch(rematchChapter);
  await removeObjects("crops", [...new Set(crops)]);
  await removeObjects("pages", pages);
}
