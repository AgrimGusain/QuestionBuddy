import { afterEach, describe, expect, it, vi } from "vitest";
import { locateQuestions, readQuestion } from "./ai";

function jsonResponse(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
  return new Response(JSON.stringify(body), { status: init?.status ?? 200, headers: init?.headers });
}

function geminiBody(content: unknown, finishReason = "STOP") {
  return {
    candidates: [{ finishReason, content: { parts: [{ text: typeof content === "string" ? content : JSON.stringify(content) }] } }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 },
  };
}

const validLayout = {
  columns: 2,
  questions: [
    {
      number: "4",
      column: 2,
      box_2d: [91, 550, 645, 965],
      type_guess: "mcq",
      option_count: 4,
      has_diagram: false,
      continues_from_previous: false,
      continues_to_next: false,
    },
  ],
};

function groqBody(content: string, finishReason = "stop") {
  return { choices: [{ finish_reason: finishReason, message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 20 } };
}

const hint = { number: "4", optionCount: 4 };

describe("locateQuestions (Gemini)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("converts box_2d [ymin, xmin, ymax, xmax] 0-1000 to bbox [x0, y0, x1, y1] 0-1", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(geminiBody(validLayout))));
    const result = await locateQuestions(Buffer.from("img"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.questions[0].bbox).toEqual([0.55, 0.091, 0.965, 0.645]);
    expect(result.data.questions[0]).not.toHaveProperty("box_2d");
    expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 20 });
  });

  it("retries once, saying why, when the response has no content (e.g. RECITATION)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ candidates: [{ finishReason: "RECITATION" }] }))
      .mockResolvedValueOnce(jsonResponse(geminiBody(validLayout)));
    vi.stubGlobal("fetch", fetchMock);
    const result = await locateQuestions(Buffer.from("img"));
    expect(result.ok).toBe(true);
    const retryText = JSON.parse(fetchMock.mock.calls[1][1].body).contents[0].parts[1].text;
    expect(retryText).toContain("RECITATION");
  });

  it("fails after two invalid responses", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(geminiBody("not json")));
    vi.stubGlobal("fetch", fetchMock);
    const result = await locateQuestions(Buffer.from("img"));
    expect(result.ok === false && result.kind).toBe("failed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reads Gemini's retryDelay on a 429", async () => {
    const body = { error: { code: 429, details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "31s" }] } };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body, { status: 429 })));
    expect(await locateQuestions(Buffer.from("img"))).toEqual({ ok: false, kind: "rate_limited", retryAfterMs: 31_000 });
  });

  it("treats a 503 (model overloaded) as rate limited, without quick retries", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: { code: 503 } }, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await locateQuestions(Buffer.from("img"))).toEqual({ ok: false, kind: "rate_limited", retryAfterMs: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a bounded number of times on other 5xx then fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await locateQuestions(Buffer.from("img"));
    expect(result.ok === false && result.kind).toBe("failed");
    expect(fetchMock).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });
});

describe("readQuestion (Groq)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns text and options, capping output tokens and passing the option hint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(groqBody(JSON.stringify({ text: "Q", options: ["a", "b", "c", "d"] }))));
    vi.stubGlobal("fetch", fetchMock);
    const result = await readQuestion(Buffer.from("img"), hint);
    expect(result.ok && result.data).toEqual({ text: "Q", options: ["a", "b", "c", "d"] });
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent.max_completion_tokens).toBeGreaterThan(0);
    expect(sent.messages[1].content[0].text).toContain("question 4");
    expect(sent.messages[1].content[0].text).toContain("4 answer options");
  });

  it("retries once when the response was cut off at the token cap", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(groqBody('{"text": "Q', "length")))
      .mockResolvedValueOnce(jsonResponse(groqBody(JSON.stringify({ text: "Q", options: null }))));
    vi.stubGlobal("fetch", fetchMock);
    expect((await readQuestion(Buffer.from("img"), hint)).ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns rate_limited from a retry-after header with no extra call", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, { status: 429, headers: { "retry-after": "30" } }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await readQuestion(Buffer.from("img"), hint)).toEqual({ ok: false, kind: "rate_limited", retryAfterMs: 30_000 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns rate_limited with null retryAfterMs when no header is sent", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, { status: 429 })));
    expect(await readQuestion(Buffer.from("img"), hint)).toEqual({ ok: false, kind: "rate_limited", retryAfterMs: null });
  });
});
