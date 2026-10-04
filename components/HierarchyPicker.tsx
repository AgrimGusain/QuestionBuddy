"use client";

import { useEffect, useState } from "react";
import { invalidateHierarchy, loadHierarchy, nextPosition, type Hierarchy } from "@/lib/hierarchy";
import { supabase } from "@/lib/supabase/client";
import { ErrorNote } from "./Status";

export interface Picked {
  subjectId: string;
  chapterId: string;
  sectionId: string; // "" = use "General"
}

const NEW = "__new";

/** Subject → Chapter → Section selects, each with inline "New …" creation. */
export function HierarchyPicker({
  value,
  onChange,
  sectionOptional,
}: {
  value: Picked;
  onChange: (v: Picked) => void;
  sectionOptional?: string; // label for the empty section option
}) {
  const [h, setH] = useState<Hierarchy | null>(null);
  const [creating, setCreating] = useState<"subject" | "chapter" | "section" | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadHierarchy().then(setH).catch((e) => setError(e.message));
  }, []);

  // Drop a remembered choice that no longer exists (e.g. deleted since).
  useEffect(() => {
    if (!h) return;
    const subjectOk = !value.subjectId || h.subjects.some((s) => s.id === value.subjectId);
    const chapterOk = !value.chapterId || h.chapters.some((c) => c.id === value.chapterId && c.subject_id === value.subjectId);
    const sectionOk = !value.sectionId || h.sections.some((s) => s.id === value.sectionId && s.chapter_id === value.chapterId);
    if (!subjectOk) onChange({ subjectId: "", chapterId: "", sectionId: "" });
    else if (!chapterOk) onChange({ ...value, chapterId: "", sectionId: "" });
    else if (!sectionOk) onChange({ ...value, sectionId: "" });
  }, [h, value, onChange]);

  if (!h) return error ? <ErrorNote>{error}</ErrorNote> : <div className="h-40 animate-pulse rounded-xl bg-sunken" />;

  const chapters = h.chapters.filter((c) => c.subject_id === value.subjectId);
  const sections = h.sections.filter((s) => s.chapter_id === value.chapterId);

  async function create() {
    const n = name.trim();
    if (!n || !creating) return;
    setError(null);
    const db = supabase();
    const res =
      creating === "subject"
        ? await db.from("subjects").insert({ name: n }).select("id").single()
        : creating === "chapter"
          ? await db.from("chapters").insert({ subject_id: value.subjectId, name: n, position: nextPosition(chapters) }).select("id").single()
          : await db.from("sections").insert({ chapter_id: value.chapterId, name: n, position: nextPosition(sections) }).select("id").single();
    if (res.error) {
      setError(res.error.code === "23505" ? `"${n}" already exists here.` : res.error.message);
      return;
    }
    invalidateHierarchy();
    setH(await loadHierarchy());
    const id = res.data.id as string;
    if (creating === "subject") onChange({ subjectId: id, chapterId: "", sectionId: "" });
    if (creating === "chapter") onChange({ ...value, chapterId: id, sectionId: "" });
    if (creating === "section") onChange({ ...value, sectionId: id });
    setCreating(null);
    setName("");
  }

  const row = (
    level: "subject" | "chapter" | "section",
    label: string,
    current: string,
    items: { id: string; name: string }[],
    onPick: (id: string) => void,
    disabled = false,
    emptyLabel?: string,
  ) => (
    <div className="space-y-2">
      <label className="block text-sm font-bold text-muted" htmlFor={`pick-${level}`}>
        {label}
      </label>
      <select
        id={`pick-${level}`}
        className="field"
        disabled={disabled}
        value={creating === level ? NEW : current}
        onChange={(e) => {
          if (e.target.value === NEW) {
            setCreating(level);
            setName("");
          } else {
            setCreating(null);
            onPick(e.target.value);
          }
        }}
      >
        <option value="">{emptyLabel ?? `Choose ${label.toLowerCase()}`}</option>
        {items.map((i) => (
          <option key={i.id} value={i.id}>
            {i.name}
          </option>
        ))}
        <option value={NEW}>+ New {label.toLowerCase()}…</option>
      </select>
      {creating === level && (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <input
            autoFocus
            className="field"
            placeholder={level === "section" ? "e.g. Exercise 1" : `New ${label.toLowerCase()} name`}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button className="btn-primary shrink-0" disabled={!name.trim()}>
            Add
          </button>
        </form>
      )}
    </div>
  );

  return (
    <div className="space-y-4">
      {row("subject", "Subject", value.subjectId, h.subjects, (id) => onChange({ subjectId: id, chapterId: "", sectionId: "" }))}
      {row("chapter", "Chapter", value.chapterId, chapters, (id) => onChange({ ...value, chapterId: id, sectionId: "" }), !value.subjectId)}
      {row("section", "Section", value.sectionId, sections, (id) => onChange({ ...value, sectionId: id }), !value.chapterId, sectionOptional)}
      {error && <ErrorNote>{error}</ErrorNote>}
    </div>
  );
}
