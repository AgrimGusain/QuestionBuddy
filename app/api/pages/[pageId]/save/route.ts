/**
 * POST /api/pages/:pageId/save
 *
 * Turns the reviewed boxes on a question page into question rows:
 * crops each box from the page photo (the flattened copy when there is
 * one, since that's what the boxes were drawn on) with sharp (+2% padding),
 * uploads the crops, then calls save_page_questions() which inserts the
 * questions and marks the page saved in one transaction.
 *
 * Runs as the signed-in user (cookie session) so RLS applies to every read
 * and write. Replays are safe: the RPC row-locks the page and refuses a
 * page that is already saved; crops from a failed or losing attempt are
 * removed again.
 */
import { NextResponse } from "next/server";
import sharp from "sharp";
import { z } from "zod";
import { log } from "@/lib/log";
import { normalizeQuestionNumber } from "@/lib/number";
import { serverSupabase } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 60;

const PADDING = 0.02; // fraction of page width/height added on each side
const UPLOAD_CONCURRENCY = 6;

const Box = z
  .object({
    x0: z.number().min(0).max(1),
    y0: z.number().min(0).max(1),
    x1: z.number().min(0).max(1),
    y1: z.number().min(0).max(1),
  })
  .refine((b) => b.x1 - b.x0 >= 0.01 && b.y1 - b.y0 >= 0.005, "box_too_small");

const Body = z.object({
  questions: z
    .array(
      z.object({
        number: z.string().trim().min(1).max(20),
        type: z.enum(["mcq", "msq", "numerical", "theory"]),
        append: z.boolean().default(false),
        boxes: z.array(Box).min(1).max(8), // parts in reading order
        text: z.string().max(4000).optional(),
        options: z.array(z.string().max(500)).max(8).nullable().optional(),
      }),
    )
    .min(1)
    .max(80),
});

type ErrorCode =
  | "invalid_body" | "unauthorized" | "page_not_found" | "page_not_question_page"
  | "page_already_saved" | "duplicate_in_page" | "number_exists" | "append_target_missing"
  | "original_unreadable" | "crop_upload_failed" | "save_failed";

function fail(status: number, code: ErrorCode, reqId: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error: code, requestId: reqId, ...extra }, { status });
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

export async function POST(request: Request, ctx: { params: Promise<{ pageId: string }> }) {
  const reqId = crypto.randomUUID();
  const started = Date.now();
  const { pageId } = await ctx.params;

  if (!z.uuid().safeParse(pageId).success) return fail(404, "page_not_found", reqId);

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return fail(400, "invalid_body", reqId, { issues: parsed.error.issues.slice(0, 5) });
  }
  const { questions } = parsed.data;

  const db = await serverSupabase();
  const { data: auth } = await db.auth.getUser();
  const userId = auth.user?.id;
  if (!userId) return fail(401, "unauthorized", reqId);

  const page = await db
    .from("pages")
    .select("id, kind, status, section_id, original_path, processed_path")
    .eq("id", pageId)
    .maybeSingle();
  if (page.error) {
    log("page_save_failed", { reqId, pageId, stage: "load_page", error: page.error.message });
    return fail(500, "save_failed", reqId);
  }
  if (!page.data) return fail(404, "page_not_found", reqId);
  if (page.data.kind !== "questions" || !page.data.section_id) return fail(400, "page_not_question_page", reqId);
  if (page.data.status === "saved") return fail(409, "page_already_saved", reqId);
  const sectionId = page.data.section_id as string;

  // Numbers must be unique within this page…
  const normalized = questions.map((q) => normalizeQuestionNumber(q.number));
  const dupes = normalized.filter((n, i) => n === "" || normalized.indexOf(n) !== i);
  if (dupes.length) return fail(400, "duplicate_in_page", reqId, { numbers: [...new Set(dupes)] });

  // …and new ones must not exist in the section yet; appended ones must.
  const existing = await db
    .from("questions")
    .select("id, number_normalized")
    .eq("section_id", sectionId)
    .in("number_normalized", normalized);
  if (existing.error) {
    log("page_save_failed", { reqId, pageId, stage: "check_numbers", error: existing.error.message });
    return fail(500, "save_failed", reqId);
  }
  const existingId = new Map(existing.data.map((r) => [r.number_normalized as string, r.id as string]));
  const clashes = questions.filter((q, i) => !q.append && existingId.has(normalized[i])).map((q) => q.number);
  if (clashes.length) return fail(409, "number_exists", reqId, { numbers: clashes });
  const missing = questions.filter((q, i) => q.append && !existingId.has(normalized[i])).map((q) => q.number);
  if (missing.length) return fail(409, "append_target_missing", reqId, { numbers: missing });

  // Crop from the image the boxes were drawn on: the flattened copy when there is one.
  const sourcePath = (page.data.processed_path as string | null) ?? (page.data.original_path as string);
  const original = await db.storage.from("pages").download(sourcePath);
  if (original.error || !original.data) {
    log("page_save_failed", { reqId, pageId, stage: "download", error: original.error?.message });
    return fail(502, "original_unreadable", reqId);
  }
  let image: Buffer;
  let width: number;
  let height: number;
  try {
    const out = await sharp(Buffer.from(await original.data.arrayBuffer()))
      .rotate() // apply EXIF orientation, if any survived
      .toBuffer({ resolveWithObject: true });
    image = out.data;
    width = out.info.width;
    height = out.info.height;
  } catch (e) {
    log("page_save_failed", { reqId, pageId, stage: "decode", error: (e as Error).message });
    return fail(422, "original_unreadable", reqId);
  }

  // Plan every crop: question id (new or existing) + storage path.
  const plan = questions.map((q, i) => ({
    id: q.append ? existingId.get(normalized[i])! : crypto.randomUUID(),
    ...q,
  }));
  const jobs = plan.flatMap((q) =>
    q.boxes.map((box) => ({ box, path: `${userId}/${q.id}/${crypto.randomUUID()}.jpg` })),
  );

  const uploaded: string[] = [];
  const cleanup = async () => {
    if (uploaded.length) {
      const { error } = await db.storage.from("crops").remove(uploaded);
      if (error) log("crop_cleanup_failed", { reqId, pageId, count: uploaded.length, error: error.message });
    }
  };

  try {
    await mapLimit(jobs, UPLOAD_CONCURRENCY, async ({ box, path }) => {
      const left = Math.max(0, Math.floor((box.x0 - PADDING) * width));
      const top = Math.max(0, Math.floor((box.y0 - PADDING) * height));
      const right = Math.min(width, Math.ceil((box.x1 + PADDING) * width));
      const bottom = Math.min(height, Math.ceil((box.y1 + PADDING) * height));
      const crop = await sharp(image)
        .extract({ left, top, width: right - left, height: bottom - top })
        .jpeg({ quality: 85, mozjpeg: true })
        .toBuffer();
      const { error } = await db.storage.from("crops").upload(path, crop, { contentType: "image/jpeg", upsert: false });
      if (error) throw new Error(error.message);
      uploaded.push(path);
    });
  } catch (e) {
    log("page_save_failed", { reqId, pageId, stage: "crop_upload", error: (e as Error).message });
    await cleanup();
    return fail(502, "crop_upload_failed", reqId);
  }

  const pathsByQuestion = new Map<string, string[]>();
  for (const q of plan) pathsByQuestion.set(q.id, []);
  let j = 0;
  for (const q of plan) for (let k = 0; k < q.boxes.length; k++) pathsByQuestion.get(q.id)!.push(jobs[j++].path);

  const rpc = await db.rpc("save_page_questions", {
    p_page_id: pageId,
    p_questions: plan.map((q) => ({
      id: q.id,
      number: q.number,
      type: q.type,
      append: q.append,
      image_paths: pathsByQuestion.get(q.id),
      // Read by the RPC on insert only; an appended (existing) question's text is never touched.
      ocr_text: q.text ?? "",
      options: q.type === "mcq" || q.type === "msq" ? (q.options ?? null) : null,
    })),
  });

  if (rpc.error) {
    await cleanup();
    const msg = rpc.error.message;
    log("page_save_failed", { reqId, pageId, stage: "rpc", code: rpc.error.code, error: msg });
    if (msg === "page_already_saved") return fail(409, "page_already_saved", reqId);
    if (rpc.error.code === "23505") return fail(409, "number_exists", reqId, { numbers: [] });
    if (msg.startsWith("append_target_missing")) {
      return fail(409, "append_target_missing", reqId, { numbers: [msg.split(":")[1]] });
    }
    return fail(500, "save_failed", reqId);
  }

  log("page_saved", {
    reqId, pageId, questions: plan.length, crops: jobs.length, ms: Date.now() - started,
  });
  return NextResponse.json({ saved: plan.length, sectionId });
}
