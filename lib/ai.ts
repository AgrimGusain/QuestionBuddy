/**
 * The one module that talks to AI providers. Nothing else in the app calls
 * Gemini or Groq (no SDKs either — both are plain fetches).
 *
 * - locateQuestions(): Gemini finds where each question is on the page.
 * - readQuestion(): Groq's Qwen transcribes one cropped question.
 * See lib/prompts/segment.ts for why the work is split this way.
 */
import type { z } from "zod";
import { log } from "./log";
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
  stage: "layout" | "read",
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

async function layoutOnce(model: string, image: Buffer, retryIssue?: string): Promise<CallOutcome<Layout>> {
  const text = retryIssue
    ? `Locate the questions on this page. Your previous response was invalid: ${retryIssue}. Return valid JSON matching the schema exactly.`
    : "Locate the questions on this page.";
  let res: Response;
  try {
    res = await fetch(`${GEMINI_ENDPOINT}/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY ?? "" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: LAYOUT_SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts: [{ inlineData: { mimeType: "image/jpeg", data: image.toString("base64") } }, { text }] }],
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
  const usage = {
    promptTokens: body?.usageMetadata?.promptTokenCount ?? 0,
    completionTokens: body?.usageMetadata?.candidatesTokenCount ?? 0,
  };
  const outcome = validate(parts.map((p) => p.text ?? "").join(""), LayoutResponseSchema, usage);
  if (outcome.kind !== "ok") return outcome;

  return {
    kind: "ok",
    usage,
    data: {
      columns: outcome.data.columns,
      questions: outcome.data.questions.map(({ box_2d: [ymin, xmin, ymax, xmax], ...q }) => ({
        ...q,
        bbox: [xmin / 1000, ymin / 1000, xmax / 1000, ymax / 1000],
      })),
    },
  };
}

/** Where each question is on the page (no text). `image` is the downscaled page JPEG. */
export async function locateQuestions(image: Buffer): Promise<AiResult<Layout>> {
  const model = layoutModelName();
  return withRetries("layout", model, (retryIssue) => layoutOnce(model, image, retryIssue));
}

async function readOnce(
  model: string,
  crop: Buffer,
  hint: { number: string | null; optionCount: number },
  retryIssue?: string,
): Promise<CallOutcome<ReadResponse>> {
  const ask = readUserPrompt(hint.number, hint.optionCount);
  const text = retryIssue ? `${ask} Your previous response was invalid: ${retryIssue}. Return valid JSON matching the schema exactly.` : ask;
  let res: Response;
  try {
    res = await fetch(GROQ_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: READ_SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              { type: "text", text },
              { type: "image_url", image_url: { url: `data:image/jpeg;base64,${crop.toString("base64")}` } },
            ],
          },
        ],
        response_format: { type: "json_object" },
        temperature: 0,
        max_completion_tokens: READ_MAX_TOKENS,
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
  return validate(choice?.message?.content, ReadResponseSchema, {
    promptTokens: body?.usage?.prompt_tokens ?? 0,
    completionTokens: body?.usage?.completion_tokens ?? 0,
  });
}

/** The text and options of one question. `crop` is a JPEG of just that question's region. */
export async function readQuestion(
  crop: Buffer,
  hint: { number: string | null; optionCount: number },
): Promise<AiResult<ReadResponse>> {
  const model = readModelName();
  return withRetries("read", model, (retryIssue) => readOnce(model, crop, hint, retryIssue));
}
