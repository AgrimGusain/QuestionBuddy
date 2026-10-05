/**
 * The answer-key branch of POST /api/pages/:pageId/segment, with Gemini,
 * Groq and Supabase mocked. Real sharp runs on a synthetic page, so table
 * splitting, snapping and cropping are exercised for real.
 */
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KeyAiProgress, KeyAiResult } from "@/lib/answer-key/schema";

const { getUser, locateAnswerKey, readKeyEntries, readWorkedSolution, serviceClientRef } = vi.hoisted(() => ({
  getUser: vi.fn(),
  locateAnswerKey: vi.fn(),
  readKeyEntries: vi.fn(),
  readWorkedSolution: vi.fn(),
  serviceClientRef: { current: null as unknown as ReturnType<typeof makeClient> },
}));

vi.mock("@/lib/supabase/server", () => ({ serverSupabase: async () => ({ auth: { getUser } }) }));
vi.mock("@/lib/ai", () => ({
  locateQuestions: vi.fn(),
  readQuestion: vi.fn(),
  readModelName: () => "qwen-test",
  locateAnswerKey,
  readKeyEntries,
  readWorkedSolution,
}));
vi.mock("@/lib/supabase/service", () => ({ serviceSupabase: () => serviceClientRef.current }));

import { POST } from "./route";

const PAGE_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const W = 600;
const H = 800;

type Calls = { updates: Record<string, unknown>[] };

function builder(result: unknown, calls: Calls) {
  const b: Record<string, unknown> = {
    update: (payload: Record<string, unknown>) => {
      calls.updates.push(payload);
      return b;
    },
    select: () => b,
    eq: () => b,
    or: () => b,
    maybeSingle: () => Promise.resolve(result),
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(result).then(resolve, reject),
  };
  return b;
}

function makeClient(results: unknown[], page: Buffer) {
  let i = 0;
  const calls: Calls = { updates: [] };
  return {
    from: () => builder(results[i++] ?? { error: null }, calls),
    storage: { from: () => ({ download: () => Promise.resolve({ data: new Blob([new Uint8Array(page)]), error: null }) }) },
    _calls: calls,
  };
}

const lastFinish = (client: ReturnType<typeof makeClient>) => client._calls.updates.filter((u) => u.status !== "processing").at(-1)!;

const request = () => new Request("http://localhost/api/pages/x/segment", { method: "POST" });
const ctx = () => ({ params: Promise.resolve({ pageId: PAGE_ID }) });

/** A white page with `rows` black bars (rows of key entries) from y=200, 20px tall, 12px apart. */
async function keyPage(rows = 4): Promise<Buffer> {
  const bars = Array.from({ length: rows }, (_, i) => ({
    input: { create: { width: 500, height: 20, channels: 3 as const, background: "black" } },
    left: 50,
    top: 200 + i * 32,
  }));
  return sharp({ create: { width: W, height: H, channels: 3, background: "white" } }).composite(bars).jpeg().toBuffer();
}

async function claimed(ai_progress: KeyAiProgress | null = null, rows = 4) {
  return makeClient(
    [{ data: { id: PAGE_ID, kind: "answer_key", original_path: "u/k.jpg", processed_path: null, retry_count: 0, ai_progress }, error: null }],
    await keyPage(rows),
  );
}

const ok = <T>(data: T) => ({ ok: true, model: "m", usage: { promptTokens: 1, completionTokens: 1 }, latencyMs: 1, data });
const entries = (from: number, to: number, skip: number[] = []) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i)
    .filter((n) => !skip.includes(n))
    .map((n) => ({ number: String(n), answer: "(a)" }));

function layout(region: { rows: number; columns: number; first: string; last: string; bbox?: [number, number, number, number] }, solutions: { number: string; bbox: [number, number, number, number] }[] = []) {
  return ok({
    columns: 1,
    headings: [{ text: "ANSWERS", bbox: [0.4, 0.2, 0.6, 0.23] }],
    regions: [{ bbox: region.bbox ?? [0.07, 0.24, 0.93, 0.42], rows: region.rows, columns: region.columns, first: region.first, last: region.last }],
    solutions: solutions.map((s) => ({ ...s, column: 1 })),
  });
}

describe("POST /api/pages/[pageId]/segment — answer-key pages", () => {
  beforeEach(() => {
    getUser.mockReset().mockResolvedValue({ data: { user: { id: USER_ID } } });
    locateAnswerKey.mockReset();
    readKeyEntries.mockReset();
    readWorkedSolution.mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  it("reads a short-key table and a worked solution and stores the result for review", async () => {
    locateAnswerKey.mockResolvedValue(layout({ rows: 4, columns: 10, first: "1", last: "36" }, [{ number: "5", bbox: [0.05, 0.6, 0.95, 0.8] }]));
    readKeyEntries.mockResolvedValue(ok(entries(1, 36)));
    readWorkedSolution.mockResolvedValue(ok({ text: "Because …", statedAnswer: "Ans. (c)" }));
    const client = await claimed();
    serviceClientRef.current = client;

    const res = await POST(request(), ctx());
    expect(await res.json()).toEqual({ status: "needs_review" });
    const done = lastFinish(client);
    expect(done).toMatchObject({ status: "needs_review", ai_progress: null, ai_model: "m + qwen-test" });
    const result = done.ai_result as KeyAiResult;
    expect(result.kind).toBe("answer_key");
    expect(result.entries.filter((e) => e.kind === "short")).toHaveLength(36);
    expect(result.entries.find((e) => e.kind === "worked")).toMatchObject({ number: "5", raw: "Because …", statedAnswer: "Ans. (c)" });
    expect(result.regions[0].missing).toEqual([]);
    expect(result.headings[0].text).toBe("ANSWERS");
    // One call for a 36-entry table, with a cap sized to it (not the 900 maximum).
    expect(readKeyEntries).toHaveBeenCalledTimes(1);
    expect(readKeyEntries.mock.calls[0][2]).toBe(16 * 36 + 80);
  });

  it("saves progress on a rate limit part-way and resumes without repeating finished work", async () => {
    locateAnswerKey.mockResolvedValue(layout({ rows: 4, columns: 10, first: "1", last: "36" }, [{ number: "5", bbox: [0.05, 0.6, 0.95, 0.8] }]));
    readKeyEntries.mockResolvedValue(ok(entries(1, 36)));
    readWorkedSolution.mockResolvedValueOnce({ ok: false, kind: "rate_limited", retryAfterMs: 20_000 });
    const first = await claimed();
    serviceClientRef.current = first;

    expect(await (await POST(request(), ctx())).json()).toEqual({ status: "rate_limited" });
    const paused = lastFinish(first);
    expect(paused.status).toBe("rate_limited");
    expect(paused).not.toHaveProperty("ai_result");
    const progress = paused.ai_progress as KeyAiProgress;
    expect(progress.regions[0].chunks[0].entries).toHaveLength(36);
    expect(progress.solutions[0].text).toBeNull();

    readWorkedSolution.mockResolvedValueOnce(ok({ text: "Because …", statedAnswer: null }));
    const second = await claimed(progress);
    serviceClientRef.current = second;
    expect(await (await POST(request(), ctx())).json()).toEqual({ status: "needs_review" });
    expect(locateAnswerKey).toHaveBeenCalledTimes(1);
    expect(readKeyEntries).toHaveBeenCalledTimes(1);
    expect(readWorkedSolution).toHaveBeenCalledTimes(2);
    expect((lastFinish(second).ai_result as KeyAiResult).entries).toHaveLength(37);
  });

  it("reads a big table in row bands and re-reads missing numbers once", async () => {
    // 9 rows × 10 entries = 90: more than one call should take.
    locateAnswerKey.mockResolvedValue(layout({ rows: 9, columns: 10, first: "1", last: "90", bbox: [0.07, 0.24, 0.93, 0.62] }));
    readKeyEntries
      .mockResolvedValueOnce(ok(entries(1, 30)))
      .mockResolvedValueOnce(ok(entries(31, 60, [44, 47])))
      .mockResolvedValueOnce(ok(entries(61, 90)))
      .mockResolvedValueOnce(ok([{ number: "44", answer: "(b)" }, { number: "12", answer: "(z)" }]));
    const client = await claimed(null, 9);
    serviceClientRef.current = client;

    expect(await (await POST(request(), ctx())).json()).toEqual({ status: "needs_review" });
    expect(readKeyEntries).toHaveBeenCalledTimes(4);
    // Three bands, each capped for its share of the 90 entries, never above 900.
    for (const call of readKeyEntries.mock.calls.slice(0, 3)) {
      expect(call[2]).toBeLessThanOrEqual(900);
      expect(call[2]).toBeLessThan(16 * 90 + 80);
    }
    // The re-read asks only for what's missing, with a small cap.
    expect(readKeyEntries.mock.calls[3][1].only).toEqual(["44", "47"]);
    expect(readKeyEntries.mock.calls[3][2]).toBe(16 * 2 + 80);

    const result = lastFinish(client).ai_result as KeyAiResult;
    const shorts = result.entries.filter((e) => e.kind === "short");
    expect(shorts).toHaveLength(89); // 47 still missing; the stray "12" from the re-read is ignored
    expect(shorts.find((e) => e.number === "44")?.raw).toBe("(b)");
    expect(shorts.find((e) => e.number === "12")?.raw).toBe("(a)");
    expect(result.regions[0].missing).toEqual(["47"]);
  });

  it("widens a tiny worked-solution box before cropping it for reading", async () => {
    locateAnswerKey.mockResolvedValue(ok({ columns: 2, headings: [], regions: [], solutions: [{ number: "6", column: 2, bbox: [0.6, 0.12, 0.68, 0.13] }] }));
    readWorkedSolution.mockResolvedValue(ok({ text: "****", statedAnswer: null }));
    serviceClientRef.current = await claimed();

    expect(await (await POST(request(), ctx())).json()).toEqual({ status: "needs_review" });
    const crop = readWorkedSolution.mock.calls[0][0] as Buffer;
    const meta = await sharp(crop).metadata();
    expect(meta.width).toBeGreaterThanOrEqual(Math.floor(W * 0.3) - 2);
    expect(meta.height).toBeGreaterThanOrEqual(Math.floor(H * 0.035) - 2);
    expect(readWorkedSolution.mock.calls[0][2]).toBeGreaterThanOrEqual(150);
  });

  it("keeps a solution it can't read, flagged, and still finishes the page", async () => {
    locateAnswerKey.mockResolvedValue(ok({ columns: 1, headings: [], regions: [], solutions: [{ number: "3", column: 1, bbox: [0.05, 0.3, 0.95, 0.5] }] }));
    readWorkedSolution.mockResolvedValue({ ok: false, kind: "failed", error: "groq_http_400" });
    const client = await claimed();
    serviceClientRef.current = client;
    expect(await (await POST(request(), ctx())).json()).toEqual({ status: "needs_review" });
    expect((lastFinish(client).ai_result as KeyAiResult).entries[0]).toMatchObject({ number: "3", raw: "", flags: { unread: true } });
  });

  it("stops at the time budget, saves progress and re-queues the page", async () => {
    locateAnswerKey.mockResolvedValue(layout({ rows: 4, columns: 10, first: "1", last: "36" }));
    const t0 = 1_000_000;
    let calls = 0;
    // The first reading of the clock is the request start; every later one is past the 40s budget.
    vi.spyOn(Date, "now").mockImplementation(() => (calls++ === 0 ? t0 : t0 + 41_000));
    const client = await claimed();
    serviceClientRef.current = client;

    expect(await (await POST(request(), ctx())).json()).toEqual({ status: "queued" });
    const saved = lastFinish(client);
    expect(saved.status).toBe("queued");
    expect((saved.ai_progress as KeyAiProgress).regions[0].chunks[0].entries).toBeNull();
    expect(readKeyEntries).not.toHaveBeenCalled();
  });

  it("marks the page failed when the layout call fails, and rate-limited when it's rate-limited", async () => {
    locateAnswerKey.mockResolvedValueOnce({ ok: false, kind: "failed", error: "boom" });
    let client = await claimed();
    serviceClientRef.current = client;
    expect(await (await POST(request(), ctx())).json()).toEqual({ status: "failed", error: "boom" });
    expect(lastFinish(client)).toMatchObject({ status: "failed", ai_progress: null });

    locateAnswerKey.mockResolvedValueOnce({ ok: false, kind: "rate_limited", retryAfterMs: null });
    client = await claimed();
    serviceClientRef.current = client;
    expect(await (await POST(request(), ctx())).json()).toEqual({ status: "rate_limited" });
    expect(lastFinish(client)).toMatchObject({ status: "rate_limited", ai_progress: null, retry_count: 1 });
  });
});
