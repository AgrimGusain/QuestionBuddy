/**
 * Browser-side calls into the answer-key SQL functions. They run as the
 * signed-in user (RLS applies), like every other client query.
 */
import { supabase } from "../supabase/client";
import type { AnswerKeyEntry } from "../types";
import { parseAnswer, type ParsedAnswer } from "./parse";

/** Re-run matching for a chapter: after anything that changes what entries match. */
export async function rematch(chapterId: string): Promise<void> {
  const { error } = await supabase().rpc("match_answer_key_entries", { p_chapter_id: chapterId });
  if (error) throw new Error(error.message);
}

/** "Use key answer": replace the current answer with the key's. */
export async function applyKeyEntry(entryId: string): Promise<void> {
  const { error } = await supabase().rpc("apply_answer_key_entry", { p_entry_id: entryId });
  if (error) throw new Error(error.message);
}

/** Set an entry's status by hand (kept_mine / ignored, or back to unmatched to undo), then re-match. */
export async function setEntryStatus(entry: AnswerKeyEntry, status: "kept_mine" | "ignored" | "unmatched"): Promise<void> {
  const patch =
    status === "kept_mine"
      ? { status, conflict_reason: entry.conflict_reason } // keeps why, for the summary
      : { status, conflict_reason: null };
  const { error } = await supabase().from("answer_key_entries").update(patch).eq("id", entry.id);
  if (error) throw new Error(error.message);
  await rematch(entry.chapter_id);
}

/** Change an entry's number, section and (short entries) answer text; re-parses the answer, then re-matches. */
export async function editEntry(entry: AnswerKeyEntry, edit: { number: string; sectionId: string | null; raw?: string }): Promise<void> {
  const patch: Record<string, unknown> = {
    number: edit.number.trim(),
    section_id: edit.sectionId,
    status: "unmatched",
    conflict_reason: null,
  };
  if (entry.kind === "short" && edit.raw !== undefined) {
    const p = parseAnswer(edit.raw);
    Object.assign(patch, {
      raw_text: edit.raw,
      correct_options: p.options,
      numeric_min: p.numericMin,
      numeric_max: p.numericMax,
      answer_text: p.text,
      parse_flags: p.flags,
    });
  }
  const { error } = await supabase().from("answer_key_entries").update(patch).eq("id", entry.id);
  if (error) throw new Error(error.message);
  await rematch(entry.chapter_id);
}

/** What a stored short entry was parsed as, for display. */
export function storedParse(e: AnswerKeyEntry): ParsedAnswer {
  const num = (v: number | string | null) => (v === null ? null : Number(v));
  return {
    options: e.correct_options,
    numericMin: num(e.numeric_min),
    numericMax: num(e.numeric_max),
    text: e.answer_text,
    flags: e.parse_flags as ParsedAnswer["flags"],
  };
}
