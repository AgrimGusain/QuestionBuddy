/**
 * POST /api/pages/:pageId/segment
 *
 * Runs one page through the AI pipeline and stores the result on the page:
 *   1. layout — Gemini locates every question (lib/ai.ts locateQuestions);
 *      the boxes are cleaned up, snapped and tiled (cleanup.ts, snap.ts).
 *   2. reading — Groq's Qwen transcribes each question from its own crop
 *      (lib/ai.ts readQuestion), one at a time.
 * Called by the client queue runner (lib/queue/runner.ts), one page at a time.
 *
 * Progress between the two lives in pages.ai_progress, so a page that hits a
 * rate limit (or this request's time budget) part-way through reading resumes
 * at the next unread question instead of starting over. pages.ai_result is
 * written only once every question has been read: the review screen shows
 * whatever is in ai_result, so it must never hold a half-finished page.
 *
 * Uses the service-role client to read/update the page across the queue,
 * since this isn't always invoked with a fresh user session in mind long
 * term — but every query still filters by user_id explicitly (established
 * via the cookie-scoped serverSupabase() session first), since the service
 * role bypasses RLS entirely and won't do that filtering for us.
 *
 * The atomic claim (step 2) is what actually prevents two overlapping
 * requests — for the same page, from two tabs or a tab plus a manual
 * retry — from double-processing. It also re-checks retry_after, so a
 * rate-limited page can't be re-claimed (and re-billed) before its
 * backoff has actually elapsed.
 */
import { NextResponse } from "next/server";
import sharp from "sharp";
import { z } from "zod";
import { locateQuestions, readModelName, readQuestion } from "@/lib/ai";
import { log } from "@/lib/log";
import { cleanupQuestions } from "@/lib/segment/cleanup";
import { cropForReading } from "@/lib/segment/crop";
import type { AiProgress, AiResult } from "@/lib/segment/schema";
import { snapBoxes } from "@/lib/snap";
import { serverSupabase } from "@/lib/supabase/server";
import { serviceSupabase } from "@/lib/supabase/service";

export const runtime = "nodejs";
export const maxDuration = 60;

const STALE_PROCESSING_MS = 3 * 60_000;
const BASE_BACKOFF_MS = 10_000;
const MAX_BACKOFF_MS = 5 * 60_000;
const LAYOUT_MAX_EDGE = 2000;
// Stop starting new reads after this long, leaving headroom under maxDuration;
// the page goes back to 'queued' and the next request picks up where this stopped.
const READ_BUDGET_MS = 40_000;

type ErrorCode = "page_not_found" | "unauthorized" | "wrong_kind" | "not_claimable" | "segment_crashed";

function fail(status: number, code: ErrorCode, reqId: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error: code, requestId: reqId, ...extra }, { status });
}

export async function POST(request: Request, ctx: { params: Promise<{ pageId: string }> }) {
  const reqId = crypto.randomUUID();
  const started = Date.now();
  const { pageId } = await ctx.params;

  if (!z.uuid().safeParse(pageId).success) return fail(404, "page_not_found", reqId);

  const db = await serverSupabase();
  const { data: auth } = await db.auth.getUser();
  const userId = auth.user?.id;
  if (!userId) return fail(401, "unauthorized", reqId);

  const svc = serviceSupabase();
  const nowIso = new Date().toISOString();
  const staleIso = new Date(Date.now() - STALE_PROCESSING_MS).toISOString();

  const claim = await svc
    .from("pages")
    // pages CHECK: retry_after is set iff status = 'rate_limited'.
    .update({ status: "processing", retry_after: null })
    .eq("id", pageId)
    .eq("user_id", userId)
    .eq("kind", "questions")
    .or(
      `status.eq.queued,` +
        `and(status.eq.rate_limited,retry_after.is.null),` +
        `and(status.eq.rate_limited,retry_after.lte.${nowIso}),` +
        `and(status.eq.processing,updated_at.lt.${staleIso})`,
    )
    .select("id, original_path, processed_path, retry_count, ai_progress")
    .maybeSingle();

  if (claim.error) {
    log("segment_failed", { reqId, pageId, stage: "claim", error: claim.error.message });
    return fail(500, "segment_crashed", reqId);
  }

  if (!claim.data) {
    const current = await svc.from("pages").select("status, kind").eq("id", pageId).eq("user_id", userId).maybeSingle();
    if (!current.data) return fail(404, "page_not_found", reqId);
    if (current.data.kind !== "questions") return fail(400, "wrong_kind", reqId);
    return fail(409, "not_claimable", reqId, { status: current.data.status });
  }

  const page = claim.data;

  // Only move on from 'processing': if the user saved the page by hand in the
  // meantime, a late AI result must not overwrite 'saved'.
  const finish = (patch: Record<string, unknown>) =>
    svc.from("pages").update(patch).eq("id", pageId).eq("user_id", userId).eq("status", "processing");

  const rateLimited = async (retryAfterMs: number | null, progress: AiProgress | null, stage: string) => {
    const delayMs = retryAfterMs ?? Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** page.retry_count);
    await finish({
      status: "rate_limited",
      retry_after: new Date(Date.now() + delayMs).toISOString(),
      retry_count: page.retry_count + 1,
      ai_progress: progress,
    });
    log("segment_done", { reqId, pageId, status: "rate_limited", stage, ms: Date.now() - started });
    return NextResponse.json({ status: "rate_limited" });
  };

  try {
    const path = (page.processed_path as string | null) ?? (page.original_path as string);
    const original = await svc.storage.from("pages").download(path);
    if (original.error || !original.data) throw new Error(`download_failed: ${original.error?.message}`);
    const raw = Buffer.from(await original.data.arrayBuffer());
    const full = await sharp(raw).rotate().toBuffer();

    let progress = page.ai_progress as AiProgress | null;

    if (!progress) {
      const layoutCopy = await sharp(full)
        .resize({ width: LAYOUT_MAX_EDGE, height: LAYOUT_MAX_EDGE, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();
      const layout = await locateQuestions(layoutCopy);
      if (!layout.ok && layout.kind === "rate_limited") return rateLimited(layout.retryAfterMs, null, "layout");
      if (!layout.ok) {
        await finish({ status: "failed", error: layout.error, retry_after: null, ai_progress: null });
        log("segment_done", { reqId, pageId, status: "failed", stage: "layout", error: layout.error, ms: Date.now() - started });
        return NextResponse.json({ status: "failed", error: layout.error });
      }

      const cleaned = cleanupQuestions(layout.data.questions);
      const snappedBoxes = await snapBoxes(
        full,
        cleaned.map((q) => ({ bbox: q.bbox, column: q.column })),
        layout.data.columns,
      );
      progress = {
        layoutModel: layout.model,
        columns: layout.data.columns,
        questions: cleaned.map((q, i) => ({ ...q, text: null, options: null, bboxRaw: q.bbox, bboxSnapped: snappedBoxes[i] })),
      };
    }

    for (const q of progress.questions) {
      if (q.text !== null) continue;
      if (Date.now() - started > READ_BUDGET_MS) {
        await finish({ status: "queued", ai_progress: progress });
        log("segment_done", { reqId, pageId, status: "queued", stage: "read_budget", ms: Date.now() - started });
        return NextResponse.json({ status: "queued" });
      }

      const crop = await cropForReading(full, q.bboxSnapped);
      const read = await readQuestion(crop, { number: q.number, optionCount: q.option_count });
      if (!read.ok && read.kind === "rate_limited") return rateLimited(read.retryAfterMs, progress, "read");

      if (!read.ok) {
        // One unreadable question shouldn't sink the page: its box is still
        // right, so keep it with empty text and let the reviewer see why.
        q.text = "";
        q.options = null;
        q.flags = { ...q.flags, unread: true };
        continue;
      }

      const hasOptions = q.type_guess === "mcq" || q.type_guess === "msq";
      q.text = read.data.text;
      q.options = hasOptions ? read.data.options : null;
      const readCount = q.options?.length ?? 0;
      if (hasOptions && q.option_count > 0 && readCount !== q.option_count) {
        q.flags = { ...q.flags, options_mismatch: true };
      }
    }

    const aiResult: AiResult = {
      model: `${progress.layoutModel} + ${readModelName()}`,
      columns: progress.columns,
      questions: progress.questions.map((q) => ({ ...q, text: q.text ?? "" })),
    };

    await finish({
      status: "needs_review",
      ai_result: aiResult,
      ai_progress: null,
      ai_model: aiResult.model,
      ai_processed_at: new Date().toISOString(),
      error: null,
      retry_after: null,
      retry_count: 0,
    });

    log("segment_done", { reqId, pageId, status: "needs_review", questions: aiResult.questions.length, ms: Date.now() - started });
    return NextResponse.json({ status: "needs_review" });
  } catch (e) {
    const error = (e as Error).message;
    log("segment_failed", { reqId, pageId, stage: "crash", error });
    await finish({ status: "failed", error: "segment_crashed", retry_after: null, ai_progress: null });
    return fail(500, "segment_crashed", reqId);
  }
}
