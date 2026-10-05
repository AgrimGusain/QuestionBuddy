/**
 * POST /api/pages/:pageId/save-key
 *
 * Saves a reviewed answer-key page: crops each worked solution from the page
 * photo (the flattened copy when there is one, since that's what the boxes
 * were drawn on) with sharp (+2% padding), stitching a solution's parts into
 * one image; uploads the crops; parses every short answer with
 * lib/answer-key/parse.ts (the client's parse is only a preview); then calls
 * save_answer_key_page(), which stores the entries, matches them to
 * questions and marks the page saved in one transaction.
 *
 * Runs as the signed-in user (cookie session) so RLS applies to every read
 * and write. Replays are safe: the RPC row-locks the page and refuses a page
 * that is already saved; crops from a failed or losing attempt are removed.
 */
import { NextResponse } from "next/server";
import sharp from "sharp";
import { z } from "zod";
import { parseAnswer } from "@/lib/answer-key/parse";
import { log } from "@/lib/log";
import { serverSupabase } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 60;

const PADDING = 0.02; // fraction of page width/height added on each side, as for question crops

const Box = z
  .object({
    x0: z.number().min(0).max(1),
    y0: z.number().min(0).max(1),
    x1: z.number().min(0).max(1),
    y1: z.number().min(0).max(1),
  })
  .refine((b) => b.x1 - b.x0 >= 0.01 && b.y1 - b.y0 >= 0.005, "box_too_small");

const Entry = z.object({
  id: z.uuid(),
  kind: z.enum(["short", "worked"]),
  number: z.string().trim().min(1).max(20),
  sectionId: z.uuid().nullable(),
  /** Short: the answer as read or edited. Worked: the solution text. */
  raw: z.string().max(8000),
  ignored: z.boolean().default(false),
  /** Worked: the solution's parts in reading order (one image is stitched from them). */
  boxes: z.array(Box).max(8).default([]),
  /** Short: the table the entry was read from, for reference. */
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable().default(null),
});

const Body = z.object({ entries: z.array(Entry).min(1).max(500) });

type ErrorCode =
  | "invalid_body" | "unauthorized" | "page_not_found" | "page_not_answer_key" | "page_already_saved"
  | "section_required" | "invalid_section" | "original_unreadable" | "crop_upload_failed" | "save_failed";

function fail(status: number, code: ErrorCode, reqId: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error: code, requestId: reqId, ...extra }, { status });
}

/** Stack crops top to bottom on white, left-aligned, as one JPEG. */
async function stitch(parts: Buffer[]): Promise<Buffer> {
  if (parts.length === 1) return parts[0];
  const metas = await Promise.all(parts.map((p) => sharp(p).metadata()));
  const width = Math.max(...metas.map((m) => m.width ?? 0));
  const height = metas.reduce((sum, m) => sum + (m.height ?? 0), 0);
  let top = 0;
  const layers = parts.map((input, i) => {
    const layer = { input, left: 0, top };
    top += metas[i].height ?? 0;
    return layer;
  });
  return sharp({ create: { width, height, channels: 3, background: "white" } })
    .composite(layers)
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer();
}

export async function POST(request: Request, ctx: { params: Promise<{ pageId: string }> }) {
  const reqId = crypto.randomUUID();
  const started = Date.now();
  const { pageId } = await ctx.params;

  if (!z.uuid().safeParse(pageId).success) return fail(404, "page_not_found", reqId);

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail(400, "invalid_body", reqId, { issues: parsed.error.issues.slice(0, 5) });
  const { entries } = parsed.data;

  // Matching needs a section; an entry the user wants kept must have one.
  const unassigned = entries.filter((e) => !e.ignored && !e.sectionId).map((e) => e.number);
  if (unassigned.length) return fail(400, "section_required", reqId, { numbers: unassigned });

  const db = await serverSupabase();
  const { data: auth } = await db.auth.getUser();
  const userId = auth.user?.id;
  if (!userId) return fail(401, "unauthorized", reqId);

  const page = await db
    .from("pages")
    .select("id, kind, status, chapter_id, original_path, processed_path")
    .eq("id", pageId)
    .maybeSingle();
  if (page.error) {
    log("key_save_failed", { reqId, pageId, stage: "load_page", error: page.error.message });
    return fail(500, "save_failed", reqId);
  }
  if (!page.data) return fail(404, "page_not_found", reqId);
  if (page.data.kind !== "answer_key") return fail(400, "page_not_answer_key", reqId);
  if (page.data.status === "saved") return fail(409, "page_already_saved", reqId);

  const sections = await db.from("sections").select("id").eq("chapter_id", page.data.chapter_id);
  if (sections.error) {
    log("key_save_failed", { reqId, pageId, stage: "load_sections", error: sections.error.message });
    return fail(500, "save_failed", reqId);
  }
  const known = new Set((sections.data ?? []).map((s) => s.id as string));
  const badSection = entries.filter((e) => e.sectionId && !known.has(e.sectionId)).map((e) => e.number);
  if (badSection.length) return fail(400, "invalid_section", reqId, { numbers: badSection });

  // Crop worked solutions (not ignored ones: those keep no image).
  const toCrop = entries.filter((e) => e.kind === "worked" && !e.ignored && e.boxes.length);
  const imagePath = new Map<string, string>();
  const uploaded: string[] = [];
  const cleanup = async () => {
    if (uploaded.length) {
      const { error } = await db.storage.from("crops").remove(uploaded);
      if (error) log("crop_cleanup_failed", { reqId, pageId, count: uploaded.length, error: error.message });
    }
  };

  if (toCrop.length) {
    const sourcePath = (page.data.processed_path as string | null) ?? (page.data.original_path as string);
    const original = await db.storage.from("pages").download(sourcePath);
    if (original.error || !original.data) {
      log("key_save_failed", { reqId, pageId, stage: "download", error: original.error?.message });
      return fail(502, "original_unreadable", reqId);
    }
    let image: Buffer;
    let width: number;
    let height: number;
    try {
      const out = await sharp(Buffer.from(await original.data.arrayBuffer())).rotate().toBuffer({ resolveWithObject: true });
      image = out.data;
      width = out.info.width;
      height = out.info.height;
    } catch (e) {
      log("key_save_failed", { reqId, pageId, stage: "decode", error: (e as Error).message });
      return fail(422, "original_unreadable", reqId);
    }

    try {
      for (const e of toCrop) {
        const parts = await Promise.all(
          e.boxes.map((box) => {
            const left = Math.max(0, Math.floor((box.x0 - PADDING) * width));
            const top = Math.max(0, Math.floor((box.y0 - PADDING) * height));
            const right = Math.min(width, Math.ceil((box.x1 + PADDING) * width));
            const bottom = Math.min(height, Math.ceil((box.y1 + PADDING) * height));
            return sharp(image).extract({ left, top, width: right - left, height: bottom - top }).jpeg({ quality: 85, mozjpeg: true }).toBuffer();
          }),
        );
        const path = `${userId}/keys/${pageId}/${e.id}.jpg`;
        const { error } = await db.storage.from("crops").upload(path, await stitch(parts), { contentType: "image/jpeg", upsert: false });
        if (error) throw new Error(error.message);
        uploaded.push(path);
        imagePath.set(e.id, path);
      }
    } catch (e) {
      log("key_save_failed", { reqId, pageId, stage: "crop_upload", error: (e as Error).message });
      await cleanup();
      return fail(502, "crop_upload_failed", reqId);
    }
  }

  const payload = entries.map((e) => {
    const unionBox = e.boxes.length
      ? [
          Math.min(...e.boxes.map((b) => b.x0)),
          Math.min(...e.boxes.map((b) => b.y0)),
          Math.max(...e.boxes.map((b) => b.x1)),
          Math.max(...e.boxes.map((b) => b.y1)),
        ]
      : e.bbox;
    if (e.kind === "worked") {
      return {
        id: e.id,
        kind: "worked",
        number: e.number,
        section_id: e.sectionId,
        raw_text: e.raw,
        answer_text: e.raw.trim() || null,
        parse_flags: [],
        image_path: imagePath.get(e.id) ?? null,
        bbox: unionBox,
        ignored: e.ignored,
      };
    }
    const p = parseAnswer(e.raw);
    return {
      id: e.id,
      kind: "short",
      number: e.number,
      section_id: e.sectionId,
      raw_text: e.raw,
      correct_options: p.options,
      numeric_min: p.numericMin,
      numeric_max: p.numericMax,
      answer_text: p.text,
      parse_flags: p.flags,
      bbox: unionBox,
      ignored: e.ignored,
    };
  });

  const rpc = await db.rpc("save_answer_key_page", { p_page_id: pageId, p_entries: payload });
  if (rpc.error) {
    await cleanup();
    const msg = rpc.error.message;
    log("key_save_failed", { reqId, pageId, stage: "rpc", code: rpc.error.code, error: msg });
    if (msg === "page_already_saved") return fail(409, "page_already_saved", reqId);
    if (msg === "page_not_answer_key") return fail(400, "page_not_answer_key", reqId);
    if (rpc.error.code === "23503") return fail(400, "invalid_section", reqId, { numbers: [] });
    return fail(500, "save_failed", reqId);
  }

  log("key_page_saved", { reqId, pageId, entries: entries.length, crops: uploaded.length, ms: Date.now() - started });
  return NextResponse.json({ saved: entries.length, chapterId: page.data.chapter_id });
}
