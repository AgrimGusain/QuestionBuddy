/**
 * The one module that talks to AI providers. Nothing else in the app calls
 * Gemini or Groq (no SDKs either — both are plain fetches).
 *
 * - locateQuestions(): Gemini finds where each question is on the page.
 * - readQuestion(): Groq's Qwen transcribes one cropped question.
 * - locateAnswerKey(), readKeyEntries(), readWorkedSolution(): the same
 *   split for answer-key pages (see lib/prompts/answer-key.ts).
 * See lib/prompts/segment.ts for why the work is split this way.
 */
import type { z } from "zod";
import {
  KeyEntriesResponseSchema,
  KeyLayoutResponseSchema,
  WorkedReadResponseSchema,
  type KeyEntryRead,
  type KeyLayout,
} from "./answer-key/schema";
import { log } from "./log";
import {
  KEY_LAYOUT_SYSTEM_PROMPT,
  KEY_READ_SYSTEM_PROMPT,
  WORKED_READ_SYSTEM_PROMPT,
  keyReadUserPrompt,
  workedReadUserPrompt,
} from "./prompts/answer-key";
import { LAYOUT_SYSTEM_PROMPT, READ_SYSTEM_PROMPT, readUserPrompt } from "./prompts/segment";
import {
  LayoutResponseSchema,
  ReadResponseSchema,
  type LocatedQuestion,
  type ReadResponse,
} from "./segment/schema";

export const DEFAULT_LAYOUT_MODEL = "gemini-3.5-flash";
export const DEFAULT_READ_MODEL = "qwen/qwen3.8-27b";
/** Model IDs in use, from the environment (server-side only). */
export const layoutModelName = () => process.env.GEMINI_LAYOUT_MODEL || DEFAULT_LAYOUT_MODEL;
export const readModelName = () => process.env.GROQ_VISION_MODEL || DEFAULT_READ_MODEL;

const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
const MAX_OTHER_ERROR_RETRIES = 2;
const OTHER_ERROR_DELAYS_MS = [500, 1500];
// Groq checks a request's max output against the per-minute output budget
// (1,000/min on the free tier), so keep it to what one question needs.
const READ_MAX_TOKENS = 700;
// Answer-key reads size their cap per call; a reply cut off at it is retried once with these.
const KEY_RETRY_MAX_TOKENS = 900;
const WORKED_RETRY_MAX_TOKENS = 700;

type Usage = { promptTokens: number; completionTokens: number };

export type AiResult<T> =
  | { ok: true; data: T; model: string; usage: Usage; latencyMs: number }
  // retryAfterMs is null when the provider gave no delay; the caller (the
  // segment route) then computes its own exponential backoff from
  // pages.retry_count, since this module never sleeps beyond quick retries.
  | { ok: false; kind: "rate_limited"; retryAfterMs: number | null }
  | { ok: false; kind: "failed"; error: string };

export type Layout = { columns: 1 | 2; questions: LocatedQuestion[] };

type CallOutcome<T> =
  | { kind: "ok"; data: T; usage: Usage }
  | { kind: "invalid"; issue: string }
  | { kind: "rate_limited"; retryAfterMs: number | null }
  | { kind: "http_error"; detail: string };

type Box = [number, number, number, number];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parse JSON text and validate it, as a CallOutcome. */
function validate<T>(content: unknown, schema: z.ZodType<T>, usage: Usage): CallOutcome<T> {
  if (typeof content !== "string" || !content) return { kind: "invalid", issue: "no message content" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { kind: "invalid", issue: "response was not valid JSON" };
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    return { kind: "invalid", issue: result.error.issues.slice(0, 5).map((i) => i.message).join("; ") };
  }
  return { kind: "ok", data: result.data, usage };
}

/** Quick retries for network/5xx errors, then one retry (told what was wrong) for an invalid response. */
async function withRetries<T>(
  stage: "layout" | "read" | "key_layout" | "key_read" | "worked_read",
  model: string,
  callOnce: (retryIssue?: string) => Promise<CallOutcome<T>>,
): Promise<AiResult<T>> {
  const started = Date.now();
  let outcome = await callOnce();
  for (let attempt = 0; outcome.kind === "http_error" && attempt < MAX_OTHER_ERROR_RETRIES; attempt++) {
    await sleep(OTHER_ERROR_DELAYS_MS[attempt] ?? 1500);
    outcome = await callOnce();
  }

  if (outcome.kind === "invalid") {
    const issue = outcome.issue;
    outcome = await callOnce(issue);
    if (outcome.kind === "invalid") {
      log("ai_call", { stage, model, latencyMs: Date.now() - started, result: "failed", error: outcome.issue });
      return { ok: false, kind: "failed", error: `invalid_json_after_retry: ${outcome.issue}` };
    }
  }

  const latencyMs = Date.now() - started;
  if (outcome.kind === "ok") {
    log("ai_call", { stage, model, latencyMs, result: "ok", ...outcome.usage });
    return { ok: true, data: outcome.data, model, usage: outcome.usage, latencyMs };
  }
  if (outcome.kind === "rate_limited") {
    log("ai_call", { stage, model, latencyMs, result: "rate_limited" });
    return { ok: false, kind: "rate_limited", retryAfterMs: outcome.retryAfterMs };
  }

  // Only http_error can reach here: any "invalid" outcome already returned above.
  log("ai_call", { stage, model, latencyMs, result: "failed", error: outcome.detail });
  return { ok: false, kind: "failed", error: outcome.detail };
}

/** Gemini puts the wait in error.details[].retryDelay, e.g. "31s". */
function geminiRetryDelayMs(body: unknown): number | null {
  const details = (body as { error?: { details?: { retryDelay?: string }[] } } | null)?.error?.details ?? [];
  for (const d of details) {
    const m = /^(\d+(?:\.\d+)?)s$/.exec(d.retryDelay ?? "");
    if (m) return Math.ceil(Number(m[1]) * 1000);
  }
  return null;
}

const invalidRetryText = (ask: string, retryIssue?: string) =>
  retryIssue ? `${ask} Your previous response was invalid: ${retryIssue}. Return valid JSON matching the schema exactly.` : ask;

/** One Gemini generateContent call on one image, JSON output validated against `schema`. */
async function geminiOnce<T>(
  model: string,
  system: string,
  ask: string,
  image: Buffer,
  schema: z.ZodType<T>,
  retryIssue?: string,
): Promise<CallOutcome<T>> {
  let res: Response;
  try {
    res = await fetch(`${GEMINI_ENDPOINT}/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY ?? "" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [
          {
            role: "user",
            parts: [{ inlineData: { mimeType: "image/jpeg", data: image.toString("base64") } }, { text: invalidRetryText(ask, retryIssue) }],
          },
        ],
        generationConfig: { responseMimeType: "application/json", temperature: 0 },
      }),
    });
  } catch (e) {
    return { kind: "http_error", detail: (e as Error).message };
  }

  const body = await res.json().catch(() => null);
  if (res.status === 429) return { kind: "rate_limited", retryAfterMs: geminiRetryDelayMs(body) };
  // "This model is currently experiencing high demand": on the free tier this
  // lasts minutes, not seconds, so back off like a rate limit instead of
  // burning the quick retries.
  if (res.status === 503) return { kind: "rate_limited", retryAfterMs: null };
  if (!res.ok) return { kind: "http_error", detail: `gemini_http_${res.status}` };

  const candidate = body?.candidates?.[0];
  const parts: { text?: string }[] | undefined = candidate?.content?.parts;
  if (!parts) return { kind: "invalid", issue: `no content (finishReason ${candidate?.finishReason ?? "none"})` };
  return validate(parts.map((p) => p.text ?? "").join(""), schema, {
    promptTokens: body?.usageMetadata?.promptTokenCount ?? 0,
    completionTokens: body?.usageMetadata?.candidatesTokenCount ?? 0,
  });
}

/** One Groq chat-completions call on one image, JSON output validated against `schema`. */
async function groqOnce<T>(
  model: string,
  system: string,
  ask: string,
  image: Buffer,
  schema: z.ZodType<T>,
  maxTokens: number,
  retryIssue?: string,
): Promise<CallOutcome<T>> {
  let res: Response;
  try {
    res = await fetch(GROQ_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          {
            role: "user",
            content: [
              { type: "text", text: invalidRetryText(ask, retryIssue) },
              { type: "image_url", image_url: { url: `data:image/jpeg;base64,${image.toString("base64")}` } },
            ],
          },
        ],
        response_format: { type: "json_object" },
        temperature: 0,
        max_completion_tokens: maxTokens,
      }),
    });
  } catch (e) {
    return { kind: "http_error", detail: (e as Error).message };
  }

  if (res.status === 429) {
    const seconds = Number(res.headers.get("retry-after") ?? NaN);
    return { kind: "rate_limited", retryAfterMs: Number.isFinite(seconds) ? seconds * 1000 : null };
  }
  if (!res.ok) return { kind: "http_error", detail: `groq_http_${res.status}` };

  const body = await res.json().catch(() => null);
  const choice = body?.choices?.[0];
  if (choice?.finish_reason === "length") return { kind: "invalid", issue: "response was cut off; keep it shorter" };
  return validate(choice?.message?.content, schema, {
    promptTokens: body?.usage?.prompt_tokens ?? 0,
    completionTokens: body?.usage?.completion_tokens ?? 0,
  });
}

/** Gemini's [ymin, xmin, ymax, xmax] 0-1000 → our [x0, y0, x1, y1] 0-1. */
const toBbox = ([ymin, xmin, ymax, xmax]: Box): Box => [xmin / 1000, ymin / 1000, xmax / 1000, ymax / 1000];

/** Where each question is on the page (no text). `image` is the downscaled page JPEG. */
export async function locateQuestions(image: Buffer): Promise<AiResult<Layout>> {
  const model = layoutModelName();
  const result = await withRetries("layout", model, (retryIssue) =>
    geminiOnce(model, LAYOUT_SYSTEM_PROMPT, "Locate the questions on this page.", image, LayoutResponseSchema, retryIssue),
  );
  if (!result.ok) return result;
  return {
    ...result,
    data: {
      columns: result.data.columns,
      questions: result.data.questions.map(({ box_2d, ...q }) => ({ ...q, bbox: toBbox(box_2d) })),
    },
  };
}

/** The text and options of one question. `crop` is a JPEG of just that question's region. */
export async function readQuestion(
  crop: Buffer,
  hint: { number: string | null; optionCount: number },
): Promise<AiResult<ReadResponse>> {
  const model = readModelName();
  const ask = readUserPrompt(hint.number, hint.optionCount);
  return withRetries("read", model, (retryIssue) =>
    groqOnce(model, READ_SYSTEM_PROMPT, ask, crop, ReadResponseSchema, READ_MAX_TOKENS, retryIssue),
  );
}

/** Headings, short-answer tables and worked solutions on an answer-key page: positions only. */
export async function locateAnswerKey(image: Buffer): Promise<AiResult<KeyLayout>> {
  const model = layoutModelName();
  const result = await withRetries("key_layout", model, (retryIssue) =>
    geminiOnce(model, KEY_LAYOUT_SYSTEM_PROMPT, "Locate the answer-key parts of this page.", image, KeyLayoutResponseSchema, retryIssue),
  );
  if (!result.ok) return result;
  const d = result.data;
  return {
    ...result,
    data: {
      columns: d.columns,
      headings: d.headings.map((h) => ({ text: h.text, bbox: toBbox(h.box_2d) })),
      regions: d.key_regions.map((r) => ({
        bbox: toBbox(r.box_2d),
        rows: r.rows,
        columns: r.columns,
        first: r.first_number,
        last: r.last_number,
      })),
      solutions: d.solutions.map((s) => ({ number: s.number, column: s.column, bbox: toBbox(s.box_2d) })),
    },
  };
}

/**
 * Entries of one crop of a short-answer table. `maxTokens` should be sized
 * to the crop: Groq appears to count the cap against the per-minute output
 * budget before answering, so an oversized cap costs waiting time. A reply
 * cut off at the cap is retried once with a larger one.
 */
export async function readKeyEntries(
  crop: Buffer,
  hint: { rows: number; columns: number; first: string; last: string; only?: string[] },
  maxTokens: number,
): Promise<AiResult<KeyEntryRead[]>> {
  const model = readModelName();
  const ask = keyReadUserPrompt(hint);
  const result = await withRetries("key_read", model, (retryIssue) =>
    groqOnce(
      model,
      KEY_READ_SYSTEM_PROMPT,
      ask,
      crop,
      KeyEntriesResponseSchema,
      retryIssue ? Math.max(maxTokens, KEY_RETRY_MAX_TOKENS) : maxTokens,
      retryIssue,
    ),
  );
  return result.ok ? { ...result, data: result.data.entries } : result;
}

/** The text of one worked solution, and its stated final answer if it gives one. */
export async function readWorkedSolution(
  crop: Buffer,
  number: string,
  maxTokens: number,
): Promise<AiResult<{ text: string; statedAnswer: string | null }>> {
  const model = readModelName();
  const result = await withRetries("worked_read", model, (retryIssue) =>
    groqOnce(
      model,
      WORKED_READ_SYSTEM_PROMPT,
      workedReadUserPrompt(number),
      crop,
      WorkedReadResponseSchema,
      retryIssue ? Math.max(maxTokens, WORKED_RETRY_MAX_TOKENS) : maxTokens,
      retryIssue,
    ),
  );
  return result.ok ? { ...result, data: { text: result.data.text, statedAnswer: result.data.stated_answer ?? null } } : result;
}
