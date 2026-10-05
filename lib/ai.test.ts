import { afterEach, describe, expect, it, vi } from "vitest";
import { locateAnswerKey, locateQuestions, readKeyEntries, readQuestion, readWorkedSolution } from "./ai";

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

describe("locateAnswerKey (Gemini)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("converts every box and keeps numbers as text", async () => {
    const layout = {
      columns: 2,
      headings: [{ text: "ANSWERS", box_2d: [418, 396, 466, 512] }],
      key_regions: [{ box_2d: [487, 135, 715, 765], rows: 4, columns: 10, first_number: 1, last_number: "36" }],
      solutions: [{ number: 5, column: 2, box_2d: [52, 605, 120, 976] }],
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(geminiBody(layout))));
    const result = await locateAnswerKey(Buffer.from("img"));
    expect(result.ok && result.data).toEqual({
      columns: 2,
      headings: [{ text: "ANSWERS", bbox: [0.396, 0.418, 0.512, 0.466] }],
      regions: [{ bbox: [0.135, 0.487, 0.765, 0.715], rows: 4, columns: 10, first: "1", last: "36" }],
      solutions: [{ number: "5", column: 2, bbox: [0.605, 0.052, 0.976, 0.12] }],
    });
  });

  it("accepts a page with no key parts", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(geminiBody({ columns: 1 }))));
    const result = await locateAnswerKey(Buffer.from("img"));
    expect(result.ok && result.data).toEqual({ columns: 1, headings: [], regions: [], solutions: [] });
  });
});

describe("readKeyEntries / readWorkedSolution (Groq)", () => {
  afterEach(() => vi.unstubAllGlobals());
  const tableHint = { rows: 4, columns: 10, first: "1", last: "36" };

  it("sends the sized cap and the table hint, and returns the entries", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(groqBody(JSON.stringify({ entries: [{ number: 1, answer: "(d)" }] }))));
    vi.stubGlobal("fetch", fetchMock);
    const result = await readKeyEntries(Buffer.from("img"), tableHint, 300);
    expect(result.ok && result.data).toEqual([{ number: "1", answer: "(d)" }]);
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent.max_completion_tokens).toBe(300);
    expect(sent.messages[1].content[0].text).toContain("numbered 1 to 36");
  });

  it("asks for only the missing numbers on a targeted re-read", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(groqBody(JSON.stringify({ entries: [] }))));
    vi.stubGlobal("fetch", fetchMock);
    await readKeyEntries(Buffer.from("img"), { ...tableHint, only: ["7", "14"] }, 120);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).messages[1].content[0].text).toContain("only these entries of the answer key in this crop: 7, 14");
  });

  it("retries a cut-off reply once with a larger cap", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(groqBody('{"entries": [', "length")))
      .mockResolvedValueOnce(jsonResponse(groqBody(JSON.stringify({ entries: [] }))));
    vi.stubGlobal("fetch", fetchMock);
    expect((await readKeyEntries(Buffer.from("img"), tableHint, 200)).ok).toBe(true);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).max_completion_tokens).toBe(900);
  });

  it("returns a worked solution's text, with a null stated answer when it gives none", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(groqBody(JSON.stringify({ text: "int x;" }))));
    vi.stubGlobal("fetch", fetchMock);
    const result = await readWorkedSolution(Buffer.from("img"), "3", 250);
    expect(result.ok && result.data).toEqual({ text: "int x;", statedAnswer: null });
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent.max_completion_tokens).toBe(250);
    expect(sent.messages[1].content[0].text).toBe("Transcribe solution 3.");
  });
});
