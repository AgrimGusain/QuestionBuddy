import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiProgress, LocatedQuestion } from "@/lib/segment/schema";

const { getUser, locateQuestions, readQuestion, serviceClientRef } = vi.hoisted(() => ({
  getUser: vi.fn(),
  locateQuestions: vi.fn(),
  readQuestion: vi.fn(),
  serviceClientRef: { current: null as unknown as ReturnType<typeof makeClient> },
}));

vi.mock("@/lib/supabase/server", () => ({ serverSupabase: async () => ({ auth: { getUser } }) }));
vi.mock("@/lib/ai", () => ({ locateQuestions, readQuestion, readModelName: () => "qwen-test" }));
vi.mock("@/lib/supabase/service", () => ({ serviceSupabase: () => serviceClientRef.current }));

import { POST } from "./route";

const PAGE_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";

type Calls = { or?: string; updates: Record<string, unknown>[] };

function builder(result: unknown, calls: Calls) {
  const b: Record<string, unknown> = {
    update: (payload: Record<string, unknown>) => {
      calls.updates.push(payload);
      return b;
    },
    select: () => b,
    eq: () => b,
    or: (s: string) => {
      calls.or = s;
      return b;
    },
    maybeSingle: () => Promise.resolve(result),
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(result).then(resolve, reject),
  };
  return b;
}

function makeClient(results: unknown[], downloadBuffer?: Buffer) {
  let i = 0;
  const calls: Calls = { updates: [] };
  return {
    from: () => builder(results[i++] ?? { error: null }, calls),
    storage: {
      from: () => ({
        download: () =>
          Promise.resolve(
            downloadBuffer ? { data: new Blob([new Uint8Array(downloadBuffer)]), error: null } : { data: null, error: { message: "not_found" } },
          ),
      }),
    },
    _calls: calls,
  };
}

/** The last update that wasn't the claim. */
function lastFinish(client: ReturnType<typeof makeClient>) {
  return client._calls.updates.filter((u) => u.status !== "processing").at(-1);
}

function request() {
  return new Request("http://localhost/api/pages/x/segment", { method: "POST" });
}

function ctx() {
  return { params: Promise.resolve({ pageId: PAGE_ID }) };
}

async function tinyImage(): Promise<Buffer> {
  return sharp({ create: { width: 40, height: 40, channels: 3, background: "white" } })
    .jpeg()
    .toBuffer();
}

function located(partial: Partial<LocatedQuestion>): LocatedQuestion {
  return {
    number: "1",
    bbox: [0.1, 0.1, 0.9, 0.3],
    column: 1,
    type_guess: "mcq",
    option_count: 4,
    has_diagram: false,
    continues_from_previous: false,
    continues_to_next: false,
    ...partial,
  };
}

function layoutOk(questions: LocatedQuestion[]) {
  return { ok: true, model: "gemini-test", usage: { promptTokens: 1, completionTokens: 1 }, latencyMs: 5, data: { columns: 1, questions } };
}

function readOk(text: string, options: string[] | null) {
  return { ok: true, model: "qwen-test", usage: { promptTokens: 1, completionTokens: 1 }, latencyMs: 5, data: { text, options } };
}

async function claimedClient(ai_progress: AiProgress | null = null) {
  return makeClient(
    [{ data: { id: PAGE_ID, original_path: "u/p.jpg", processed_path: null, retry_count: 1, ai_progress }, error: null }],
    await tinyImage(),
  );
}

describe("POST /api/pages/[pageId]/segment", () => {
  beforeEach(() => {
    getUser.mockReset().mockResolvedValue({ data: { user: { id: USER_ID } } });
    locateQuestions.mockReset();
    readQuestion.mockReset();
  });

  it("returns 401 when the caller isn't signed in", async () => {
    getUser.mockResolvedValue({ data: { user: null } });
    serviceClientRef.current = makeClient([]);
    const res = await POST(request(), ctx());
    expect(res.status).toBe(401);
  });

  it("returns 404 when the page doesn't belong to the caller (or doesn't exist)", async () => {
    serviceClientRef.current = makeClient([
      { data: null, error: null }, // claim: no match
      { data: null, error: null }, // fallback lookup, filtered by user_id: nothing
    ]);
    const res = await POST(request(), ctx());
    expect(res.status).toBe(404);
  });

  it("returns 409 not_claimable when the page is already needs_review", async () => {
    serviceClientRef.current = makeClient([
      { data: null, error: null },
      { data: { status: "needs_review", kind: "questions" }, error: null },
    ]);
    const res = await POST(request(), ctx());
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "not_claimable", status: "needs_review" });
  });

  it("builds a claim filter covering queued, elapsed rate_limited, and stale processing, and clears retry_after", async () => {
    const client = makeClient([
      { data: null, error: null },
      { data: { status: "queued", kind: "questions" }, error: null },
    ]);
    serviceClientRef.current = client;
    await POST(request(), ctx());
    const filter = client._calls.or ?? "";
    expect(filter).toContain("status.eq.queued");
    expect(filter).toContain("status.eq.rate_limited,retry_after.lte.");
    expect(filter).toContain("status.eq.processing,updated_at.lt.");
    expect(client._calls.updates[0]).toEqual({ status: "processing", retry_after: null });
  });

  it("marks the page rate_limited when the layout model is rate limited", async () => {
    locateQuestions.mockResolvedValue({ ok: false, kind: "rate_limited", retryAfterMs: 30_000 });
    const client = await claimedClient();
    serviceClientRef.current = client;
    const res = await POST(request(), ctx());
    expect(await res.json()).toEqual({ status: "rate_limited" });
    expect(lastFinish(client)).toMatchObject({ status: "rate_limited", ai_progress: null, retry_count: 2 });
    expect(readQuestion).not.toHaveBeenCalled();
  });

  it("marks the page failed when the layout model fails", async () => {
    locateQuestions.mockResolvedValue({ ok: false, kind: "failed", error: "boom" });
    const client = await claimedClient();
    serviceClientRef.current = client;
    const res = await POST(request(), ctx());
    expect(await res.json()).toEqual({ status: "failed", error: "boom" });
    expect(lastFinish(client)).toMatchObject({ status: "failed", error: "boom" });
  });

  it("reads every question and stores ai_result with raw and snapped boxes, clearing ai_progress", async () => {
    locateQuestions.mockResolvedValue(layoutOk([located({ number: "1" }), located({ number: "2", bbox: [0.1, 0.5, 0.9, 0.7], type_guess: "numerical", option_count: 0 })]));
    readQuestion.mockResolvedValueOnce(readOk("First?", ["a", "b", "c", "d"])).mockResolvedValueOnce(readOk("Second?", ["stray"]));
    const client = await claimedClient();
    serviceClientRef.current = client;

    const res = await POST(request(), ctx());
    expect(await res.json()).toEqual({ status: "needs_review" });
    const done = lastFinish(client)!;
    expect(done).toMatchObject({ status: "needs_review", ai_progress: null, ai_model: "gemini-test + qwen-test" });
    const questions = (done.ai_result as { questions: { text: string; options: string[] | null; bboxRaw: number[]; bboxSnapped: number[]; flags: object }[] }).questions;
    expect(questions.map((q) => q.text)).toEqual(["First?", "Second?"]);
    expect(questions[0].options).toEqual(["a", "b", "c", "d"]);
    expect(questions[1].options).toBeNull(); // numerical: options dropped
    expect(questions[0].bboxRaw).toEqual([0.1, 0.1, 0.9, 0.3]);
    expect(questions[0].bboxSnapped).toBeDefined();
    expect(questions[0].flags).not.toHaveProperty("options_mismatch");
    expect(readQuestion.mock.calls[0][1]).toEqual({ number: "1", optionCount: 4 });
  });

  it("saves progress and backs off when reading is rate limited part-way", async () => {
    locateQuestions.mockResolvedValue(layoutOk([located({ number: "1" }), located({ number: "2", bbox: [0.1, 0.5, 0.9, 0.7] })]));
    readQuestion.mockResolvedValueOnce(readOk("First?", ["a", "b", "c", "d"])).mockResolvedValueOnce({ ok: false, kind: "rate_limited", retryAfterMs: 20_000 });
    const client = await claimedClient();
    serviceClientRef.current = client;

    const res = await POST(request(), ctx());
    expect(await res.json()).toEqual({ status: "rate_limited" });
    const saved = lastFinish(client)!;
    expect(saved.status).toBe("rate_limited");
    expect(saved).not.toHaveProperty("ai_result");
    const progress = saved.ai_progress as AiProgress;
    expect(progress.layoutModel).toBe("gemini-test");
    expect(progress.questions.map((q) => q.text)).toEqual(["First?", null]);
  });

  it("resumes from ai_progress without calling the layout model again", async () => {
    const progress: AiProgress = {
      layoutModel: "gemini-test",
      columns: 1,
      questions: [
        { ...located({ number: "1" }), text: "First?", options: ["a"], bboxRaw: [0.1, 0.1, 0.9, 0.3], bboxSnapped: [0.1, 0.1, 0.9, 0.3], flags: { duplicate_number: false, sequence_gap: false } },
        { ...located({ number: "2" }), text: null, options: null, bboxRaw: [0.1, 0.5, 0.9, 0.7], bboxSnapped: [0.1, 0.5, 0.9, 0.7], flags: { duplicate_number: false, sequence_gap: false } },
      ],
    };
    readQuestion.mockResolvedValue(readOk("Second?", ["a", "b", "c", "d"]));
    const client = await claimedClient(progress);
    serviceClientRef.current = client;

    const res = await POST(request(), ctx());
    expect(await res.json()).toEqual({ status: "needs_review" });
    expect(locateQuestions).not.toHaveBeenCalled();
    expect(readQuestion).toHaveBeenCalledTimes(1);
    const questions = (lastFinish(client)!.ai_result as { questions: { text: string }[] }).questions;
    expect(questions.map((q) => q.text)).toEqual(["First?", "Second?"]);
  });

  it("keeps a question it can't read, flagged unread, and flags an option-count mismatch", async () => {
    locateQuestions.mockResolvedValue(layoutOk([located({ number: "1" }), located({ number: "2", bbox: [0.1, 0.5, 0.9, 0.7] })]));
    readQuestion.mockResolvedValueOnce({ ok: false, kind: "failed", error: "invalid_json_after_retry" }).mockResolvedValueOnce(readOk("Second?", ["a"]));
    const client = await claimedClient();
    serviceClientRef.current = client;

    const res = await POST(request(), ctx());
    expect(await res.json()).toEqual({ status: "needs_review" });
    const questions = (lastFinish(client)!.ai_result as { questions: { text: string; flags: Record<string, boolean> }[] }).questions;
    expect(questions[0]).toMatchObject({ text: "", flags: { unread: true } });
    expect(questions[1].flags.options_mismatch).toBe(true);
  });
});
