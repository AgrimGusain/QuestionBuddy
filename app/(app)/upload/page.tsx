"use client";

import { Camera, CheckCircle2, ImagePlus, LoaderCircle, Pencil, RotateCw, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { CornerAdjust } from "@/components/CornerAdjust";
import { HierarchyPicker, type Picked } from "@/components/HierarchyPicker";
import { ErrorNote, Loading } from "@/components/Status";
import { TopBar } from "@/components/TopBar";
import { ensureGeneralSection, loadHierarchy, pathLabel, type Hierarchy } from "@/lib/hierarchy";
import { prepareJpeg } from "@/lib/image";
import { wakeQueueRunner } from "@/lib/queue/runner";
import { useCountdown } from "@/lib/queue/useCountdown";
import { currentUserId, supabase } from "@/lib/supabase/client";
import type { PageKind, PageRow } from "@/lib/types";
import { uuid } from "@/lib/uuid";

const LAST_PICK = "sqb:last-pick";
const PENDING_STATUSES = ["uploaded", "needs_review", "queued", "processing", "rate_limited", "failed"] as const;
const POLL_MS = 4000;

interface Item {
  key: string;
  name: string;
  state: "waiting" | "preparing" | "uploading" | "done" | "error";
  pageId?: string;
  error?: string;
}

function readLastPick(): Picked {
  try {
    return { subjectId: "", chapterId: "", sectionId: "", ...JSON.parse(localStorage.getItem(LAST_PICK) ?? "{}") };
  } catch {
    return { subjectId: "", chapterId: "", sectionId: "" };
  }
}

function formatCountdown(ms: number): string {
  const s = Math.ceil(ms / 1000);
  return s >= 60 ? `${Math.ceil(s / 60)}m` : `${s}s`;
}

function PendingRow({ page, label, onRetry }: { page: PageRow; label: string; onRetry: (pageId: string) => void }) {
  const remaining = useCountdown(page.status === "rate_limited" ? page.retry_after : null);

  if (page.status === "queued" || page.status === "processing") {
    return (
      <div className="flex items-center gap-3 px-4 py-3">
        <LoaderCircle size={20} className="shrink-0 animate-spin text-muted" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className="shrink-0 text-sm text-muted">Reading…</span>
      </div>
    );
  }

  if (page.status === "rate_limited") {
    return (
      <div className="flex items-center gap-3 px-4 py-3">
        <LoaderCircle size={20} className="shrink-0 animate-spin text-muted" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className="shrink-0 text-sm text-muted">{remaining ? `Retrying in ${formatCountdown(remaining)}` : "Retrying…"}</span>
      </div>
    );
  }

  if (page.status === "failed") {
    return (
      <div className="flex items-center gap-3 px-4 py-3">
        <TriangleAlert size={20} className="shrink-0 text-bad" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block truncate">{label}</span>
          <span className="block text-sm text-bad">{page.error ?? "Couldn't read this page."}</span>
        </span>
        <button type="button" className="btn-icon shrink-0" aria-label="Retry" onClick={() => onRetry(page.id)}>
          <RotateCw size={18} aria-hidden />
        </button>
        <Link href={`/upload/${page.id}`} className="btn-icon shrink-0" aria-label="Draw manually">
          <Pencil size={18} aria-hidden />
        </Link>
      </div>
    );
  }

  return (
    <Link href={`/upload/${page.id}`} className="flex items-center justify-between gap-3 px-4 py-3">
      <span className="min-w-0 truncate">{label}</span>
      <span className="shrink-0 text-sm font-bold text-accent">Mark boxes</span>
    </Link>
  );
}

function UploadInner() {
  const params = useSearchParams();
  const [picked, setPicked] = useState<Picked>({ subjectId: "", chapterId: "", sectionId: "" });
  const [kind, setKind] = useState<PageKind>("questions");
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PageRow[]>([]);
  const [h, setH] = useState<Hierarchy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingAdjust, setPendingAdjust] = useState<{
    bitmap: ImageBitmap;
    onFlatten: (blob: Blob) => void;
    onSkip: () => void;
  } | null>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);

  // Prefill from the library (?subject=&chapter=&section=) or the last upload.
  useEffect(() => {
    const fromUrl = params.get("chapter");
    setPicked(
      fromUrl
        ? { subjectId: params.get("subject") ?? "", chapterId: fromUrl, sectionId: params.get("section") ?? "" }
        : readLastPick(),
    );
  }, [params]);

  const loadPending = useCallback(async () => {
    const [hier, res] = await Promise.all([
      loadHierarchy(),
      supabase()
        .from("pages")
        .select("*")
        .eq("kind", "questions")
        .in("status", PENDING_STATUSES)
        .order("created_at"),
    ]);
    if (res.error) return setError(res.error.message);
    setH(hier);
    setPending(res.data as PageRow[]);
  }, []);

  useEffect(() => {
    loadPending().catch((e) => setError(e.message));
  }, [loadPending]);

  // Statuses change in the background (the AI queue) while this screen is open.
  useEffect(() => {
    const id = setInterval(() => loadPending().catch(() => {}), POLL_MS);
    return () => clearInterval(id);
  }, [loadPending]);

  async function retryPage(pageId: string) {
    await supabase().from("pages").update({ status: "queued", error: null, retry_after: null, retry_count: 0 }).eq("id", pageId);
    wakeQueueRunner();
    await loadPending();
  }

  const patch = (key: string, p: Partial<Item>) =>
    setItems((list) => list.map((i) => (i.key === key ? { ...i, ...p } : i)));

  // Shows the corner-adjust screen and waits for Flatten (-> a Blob) or Skip (-> null).
  // Any decode failure skips straight through: corner-adjust is a nice-to-have, not a blocker.
  async function adjustCorners(file: File): Promise<Blob | null> {
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      return null;
    }
    try {
      return await new Promise<Blob | null>((resolve) => {
        setPendingAdjust({
          bitmap,
          onFlatten: (blob) => {
            setPendingAdjust(null);
            resolve(blob);
          },
          onSkip: () => {
            setPendingAdjust(null);
            resolve(null);
          },
        });
      });
    } finally {
      bitmap.close();
    }
  }

  // Takes a plain array: the input's FileList is emptied when the input is reset.
  async function handleFiles(files: File[]) {
    if (!files.length || !picked.chapterId) return;
    setError(null);
    const batch: Item[] = files.map((f) => ({ key: uuid(), name: f.name || "Photo", state: "waiting" }));
    setItems((list) => [...batch, ...list]);
    setBusy(true);
    localStorage.setItem(LAST_PICK, JSON.stringify(picked));

    let sectionId = picked.sectionId;
    let userId: string;
    try {
      userId = await currentUserId();
      if (!sectionId) {
        sectionId = await ensureGeneralSection(picked.chapterId);
      }
    } catch (e) {
      batch.forEach((b) => patch(b.key, { state: "error", error: (e as Error).message }));
      setBusy(false);
      return;
    }

    // One page at a time: keeps memory low on phones.
    for (const [i, file] of files.entries()) {
      const key = batch[i].key;
      try {
        patch(key, { state: "preparing" });
        const jpeg = await prepareJpeg(file);
        if (process.env.NODE_ENV !== "production") {
          console.log("prepared_jpeg", { name: file.name, originalKb: Math.round(file.size / 1024), savedKb: Math.round(jpeg.size / 1024) });
        }

        patch(key, { state: "uploading" });
        const pageId = uuid();
        const path = `${userId}/${pageId}.jpg`;
        // The photo is stored before anything else happens to it, and is never modified.
        const up = await supabase().storage.from("pages").upload(path, jpeg, { contentType: "image/jpeg", upsert: false });
        if (up.error) throw new Error(`Upload failed: ${up.error.message}`);

        // Corner-adjust before the page enters the AI queue, so segmentation never
        // runs against an unflattened image when the user chose to flatten it.
        let processedPath: string | null = null;
        if (kind === "questions") {
          const flattened = await adjustCorners(file);
          if (flattened) {
            const cleanPath = `${userId}/${pageId}.clean.jpg`;
            const upClean = await supabase().storage.from("pages").upload(cleanPath, flattened, { contentType: "image/jpeg", upsert: false });
            if (!upClean.error) processedPath = cleanPath;
          }
        }

        const row = await supabase().from("pages").insert({
          id: pageId,
          chapter_id: picked.chapterId,
          section_id: sectionId,
          kind,
          status: kind === "questions" ? "queued" : "needs_review",
          original_path: path,
          processed_path: processedPath,
        });
        if (row.error) {
          await supabase().storage.from("pages").remove(processedPath ? [path, processedPath] : [path]);
          throw new Error(row.error.message);
        }
        if (kind === "questions") wakeQueueRunner();
        patch(key, { state: "done", pageId });
      } catch (e) {
        const msg = (e as Error).message;
        patch(key, {
          state: "error",
          error: msg === "unsupported_image" ? "This photo format can't be read. Try a JPEG or a screenshot of it." : msg,
        });
      }
    }
    setBusy(false);
    await loadPending();
  }

  const ready = !!picked.chapterId && kind === "questions";

  return (
    <>
      {pendingAdjust && (
        <div className="fixed inset-0 z-40 overflow-y-auto bg-bg">
          <TopBar title="Adjust page" />
          <CornerAdjust bitmap={pendingAdjust.bitmap} onFlatten={pendingAdjust.onFlatten} onSkip={pendingAdjust.onSkip} />
        </div>
      )}
      <TopBar title="Add pages" />
      <main className="space-y-6 px-4 py-4">
        <HierarchyPicker value={picked} onChange={setPicked} sectionOptional="General (default)" />

        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Page kind">
          <button type="button" role="radio" aria-checked={kind === "questions"} className="chip justify-center" onClick={() => setKind("questions")}>
            Question pages
          </button>
          <button type="button" role="radio" aria-checked={kind === "answer_key"} className="chip justify-center" onClick={() => setKind("answer_key")}>
            Answer key pages
          </button>
        </div>
        {kind === "answer_key" && (
          <p className="text-sm text-muted">
            Reading answer keys arrives in Phase 3. For now, type answers on each question&apos;s page.
          </p>
        )}

        <div className="grid grid-cols-2 gap-3">
          <button type="button" className="btn-primary min-h-20 flex-col" disabled={!ready || busy} onClick={() => cameraRef.current?.click()}>
            <Camera size={26} aria-hidden /> Take photo
          </button>
          <button type="button" className="btn-secondary min-h-20 flex-col" disabled={!ready || busy} onClick={() => galleryRef.current?.click()}>
            <ImagePlus size={26} aria-hidden /> From gallery
          </button>
        </div>
        {!picked.chapterId && <p className="text-sm text-muted">Choose a subject and chapter first.</p>}

        <input
          ref={cameraRef}
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = ""; // lets you pick the same photo again
            void handleFiles(files);
          }}
        />
        <input
          ref={galleryRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = ""; // lets you pick the same photo again
            void handleFiles(files);
          }}
        />

        {error && <ErrorNote>{error}</ErrorNote>}

        {items.length > 0 && (
          <section className="space-y-2" aria-live="polite">
            <h2 className="font-bold">This session</h2>
            <ul className="card divide-y divide-line">
              {items.map((i) => (
                <li key={i.key} className="flex items-center gap-3 px-4 py-3">
                  {i.state === "done" ? (
                    <CheckCircle2 size={20} className="shrink-0 text-ok" aria-hidden />
                  ) : i.state === "error" ? (
                    <TriangleAlert size={20} className="shrink-0 text-bad" aria-hidden />
                  ) : (
                    <LoaderCircle size={20} className="shrink-0 animate-spin text-muted" aria-hidden />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{i.name}</span>
                    <span className={`text-sm ${i.state === "error" ? "text-bad" : "text-muted"}`}>
                      {{ waiting: "Waiting", preparing: "Preparing photo", uploading: "Uploading", done: "Saved", error: i.error }[i.state]}
                    </span>
                  </span>
                  {i.pageId && (
                    <Link href={`/upload/${i.pageId}`} className="shrink-0 text-sm font-bold text-accent">
                      Mark boxes
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        {h && pending.length > 0 && (
          <section className="space-y-2">
            <h2 className="font-bold">Pages</h2>
            <ul className="card divide-y divide-line">
              {pending.map((p) => (
                <PendingRow key={p.id} page={p} label={pathLabel(h, p.chapter_id, p.section_id)} onRetry={retryPage} />
              ))}
            </ul>
          </section>
        )}
      </main>
    </>
  );
}

export default function UploadPage() {
  return (
    <Suspense fallback={<Loading />}>
      <UploadInner />
    </Suspense>
  );
}
