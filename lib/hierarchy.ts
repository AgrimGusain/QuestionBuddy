import { supabase } from "./supabase/client";
import type { Chapter, Section, Subject } from "./types";

export interface Hierarchy {
  subjects: Subject[];
  chapters: Chapter[];
  sections: Section[];
}

let cached: Promise<Hierarchy> | null = null;

/** All subjects, chapters and sections (small tables), cached until invalidated. */
export function loadHierarchy(): Promise<Hierarchy> {
  cached ??= (async () => {
    const db = supabase();
    const [s, c, x] = await Promise.all([
      db.from("subjects").select("id, name, created_at").order("name"),
      db.from("chapters").select("id, subject_id, name, position").order("position").order("name"),
      db.from("sections").select("id, chapter_id, name, position").order("position").order("name"),
    ]);
    const err = s.error ?? c.error ?? x.error;
    if (err) {
      cached = null;
      throw new Error(err.message);
    }
    return {
      subjects: s.data as Subject[],
      chapters: c.data as Chapter[],
      sections: x.data as Section[],
    };
  })();
  return cached;
}

export function invalidateHierarchy() {
  cached = null;
}

/** "Physics › Kinematics › Exercise 1" */
export function pathLabel(h: Hierarchy, chapterId: string, sectionId?: string | null): string {
  const chapter = h.chapters.find((c) => c.id === chapterId);
  const subject = chapter && h.subjects.find((s) => s.id === chapter.subject_id);
  const section = sectionId ? h.sections.find((s) => s.id === sectionId) : undefined;
  return [subject?.name, chapter?.name, section?.name].filter(Boolean).join(" › ");
}

/** Find or create the section named "General" in a chapter. */
export async function ensureGeneralSection(chapterId: string): Promise<string> {
  const db = supabase();
  const found = await db.from("sections").select("id").eq("chapter_id", chapterId).eq("name", "General").maybeSingle();
  if (found.error) throw new Error(found.error.message);
  if (found.data) return found.data.id as string;
  const created = await db.from("sections").insert({ chapter_id: chapterId, name: "General" }).select("id").single();
  if (created.error) throw new Error(created.error.message);
  invalidateHierarchy();
  return created.data.id as string;
}

/** Next position value for a new chapter/section (appends to the end). */
export function nextPosition(items: { position: number }[]): number {
  return items.reduce((m, i) => Math.max(m, i.position), -1) + 1;
}
