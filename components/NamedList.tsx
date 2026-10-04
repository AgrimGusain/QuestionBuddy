"use client";

import { MoreHorizontal } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { ErrorNote } from "./Status";

export interface NamedItem {
  id: string;
  name: string;
  href: string;
  meta?: string;
}

/** A list of subjects or chapters with add, rename and delete. */
export function NamedList({
  items,
  noun,
  onAdd,
  onRename,
  onDelete,
  deleteWarning,
}: {
  items: NamedItem[];
  noun: string; // "subject" | "chapter"
  onAdd: (name: string) => Promise<string | null>; // returns an error message or null
  onRename: (id: string, name: string) => Promise<string | null>;
  onDelete: (id: string) => Promise<string | null>;
  deleteWarning: (item: NamedItem) => string;
}) {
  const [name, setName] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(task: () => Promise<string | null>) {
    setBusy(true);
    setError(null);
    const err = await task();
    setBusy(false);
    if (err) setError(err);
    return !err;
  }

  return (
    <div className="space-y-3">
      {items.length > 0 && (
        <ul className="card divide-y divide-line">
          {items.map((item) => (
            <li key={item.id}>
              <div className="flex items-center">
                <Link href={item.href} className="flex min-w-0 flex-1 items-baseline justify-between gap-3 py-3 pl-4">
                  <span className="truncate font-bold">{item.name}</span>
                  {item.meta && <span className="shrink-0 text-sm text-muted">{item.meta}</span>}
                </Link>
                <button
                  type="button"
                  className="btn-icon mx-1"
                  aria-label={`Options for ${item.name}`}
                  aria-expanded={open === item.id}
                  onClick={() => setOpen(open === item.id ? null : item.id)}
                >
                  <MoreHorizontal size={20} aria-hidden />
                </button>
              </div>
              {open === item.id && (
                <div className="flex gap-2 px-4 pb-3">
                  <button
                    type="button"
                    className="btn-secondary flex-1"
                    disabled={busy}
                    onClick={async () => {
                      const next = window.prompt(`Rename ${noun}`, item.name)?.trim();
                      if (next && next !== item.name && (await run(() => onRename(item.id, next)))) setOpen(null);
                    }}
                  >
                    Rename
                  </button>
                  <button
                    type="button"
                    className="btn-danger flex-1"
                    disabled={busy}
                    onClick={async () => {
                      if (window.confirm(deleteWarning(item)) && (await run(() => onDelete(item.id)))) setOpen(null);
                    }}
                  >
                    Delete
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          const n = name.trim();
          if (n && (await run(() => onAdd(n)))) setName("");
        }}
      >
        <input
          className="field"
          placeholder={`New ${noun}`}
          aria-label={`New ${noun} name`}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button className="btn-primary shrink-0" disabled={busy || !name.trim()}>
          Add
        </button>
      </form>
      {error && <ErrorNote>{error}</ErrorNote>}
    </div>
  );
}

/** Turn a Supabase error into a sentence for the user. */
export function friendlyDbError(err: { code?: string; message: string } | null, name?: string): string | null {
  if (!err) return null;
  if (err.code === "23505") return name ? `"${name}" already exists here.` : "That name already exists here.";
  return err.message;
}
