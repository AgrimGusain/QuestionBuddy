# Snap Question Bank — Phases 1–2

Photograph textbook pages, box each question, and build a searchable bank you can practise from.

Phase 1 covers: email sign-in, subjects/chapters/sections, photo upload with manual question boxes,
library with search and filters, star and theory tags, typed answers (MCQ, MSQ, numerical, theory),
practice and theory revision with auto-checking or self-marking, session summaries, and share/copy.

Phase 2 adds auto-snipping: flatten the photo, let Gemini find every question, snap the boxes to clean
edges, let a Groq vision model read each question's text and options from its crop, then review and fix
them before saving. Drawing
boxes by hand still works on every page. Answer-key pages keep the Phase 1 manual flow for now.

## Setup

1. **Create a Supabase project** (free tier is fine).

2. **Run the migrations**, in order, in the Supabase SQL editor (or `supabase db push` with the CLI):
   - `supabase/migrations/20261004000000_phase1_core.sql`
   - `supabase/migrations/20261004000100_save_page_questions.sql`
   - `supabase/migrations/20261005000000_phase2_ai_queue.sql`
   - `supabase/migrations/20261005000100_ai_progress.sql`
   - `supabase/migrations/20261005000200_theory_type_tags.sql`

3. **Create your account.** Authentication → Users → Add user → enter email and password,
   tick "Auto confirm user". Then Authentication → Sign In / Providers → turn off
   "Allow new users to sign up", so nobody else can create an account.

4. **Environment.** Copy `.env.example` to `.env.local` and fill in:
   - `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` — Project Settings → API.
   - `SUPABASE_SERVICE_ROLE_KEY` — Project Settings → API → `service_role`. Server-side only.
   - `GEMINI_API_KEY` — create one at [aistudio.google.com](https://aistudio.google.com) → Get API key
     (free tier is fine). Server-side only.
   - `GEMINI_LAYOUT_MODEL` — defaults to `gemini-3.5-flash`. Gemini only locates questions: it refuses
     to transcribe copyrighted book text (`finishReason: RECITATION`), so it is never asked for text.
   - `GROQ_API_KEY` — create one at [console.groq.com](https://console.groq.com) → API Keys. Server-side only.
   - `GROQ_VISION_MODEL` — defaults to `qwen/qwen3.8-27b` (Groq's current vision model). To switch,
     change it here; `meta-llama/llama-4-scout-17b-16e-instruct` also reads images.

   Never prefix the service-role, Gemini or Groq keys with `NEXT_PUBLIC_`: that would ship them to the
   browser. Settings (gear icon on Home) shows both models in use and has a "Test Groq connection" button.

5. **Run it.**
   ```bash
   npm install
   npm run dev        # http://localhost:3000
   npm test           # unit tests (Gemini and Groq are mocked; no keys needed)
   ```

## Testing on your phone

Share and clipboard features, and `crypto.randomUUID`, only work on HTTPS (or localhost).
The simplest route is a free Vercel deploy: import the repo, add all the env vars from step 4,
deploy, and open the URL on the phone. Plain `http://<your-laptop-ip>:3000` works for everything
except "Share image" and "Copy text".

Reading a page can take a while, so the AI route asks for up to 60 seconds (`maxDuration`); make sure
your host allows that.

## Phase 1 test checklist

- Sign in; signing out returns you to the login screen.
- Upload: create a subject, chapter and section inline; take a photo and pick several from the gallery.
  Each shows "Saved", and appears under "Pages" (also on Home once it's ready to review).
- Mark boxes: add boxes, drag and resize them, set numbers and types. Give two boxes the same number
  and check they save as one question with two images. Leave the screen and come back: boxes are kept.
- Save twice quickly: only one set of questions is created.
- Save a page with a number that already exists in the section: you get a clear message. Tick
  "Continues from an earlier page" to add the crop to the existing question instead.
- Library: sections as tabs, search by typed question text, filters, star and theory toggles.
- Question page: edit number/type/text, enter answers for each type, share image, copy text, delete.
- Practice: filters and live count, MCQ/MSQ/numerical checking (single value ±1%, or a range),
  self-marking when no answer is saved, overrides, end-of-session summary, "Star all".
- Theory: only theory-tagged questions; reveal the model answer and mark yourself.

## Phase 2 test checklist

- **Settings:** both model IDs show; "Test Groq connection" says Connected. Break `GROQ_API_KEY`
  on purpose and check you get a readable error.
- **Corner adjust:** take a photo of a page on a desk. The corners land on the page edges (or on the
  photo's corners if detection fails). Drag each corner: the magnifier follows your finger and the page
  doesn't scroll. "Flatten" gives a straight, sharper page; "Skip" keeps the photo as it was.
  In Supabase Storage, the page has `<id>.jpg` (original, unchanged) and, if flattened, `<id>.clean.jpg`.
- **Queue:** pick 10 pages from the gallery (Skip or Flatten each) and leave the phone alone. Under
  "Pages" each shows "Reading…", then "Mark boxes", one at a time, oldest first.
- **Resume:** close the app mid-queue, reopen it: unfinished pages carry on by themselves.
- **Rate limit:** upload pages quickly until Groq rate-limits you (the free tier allows only 1,000
  output tokens a minute, so a few pages is enough). The page shows "Retrying in …" with a countdown,
  then carries on from the next unread question without you doing anything. A Gemini "high demand"
  503 is treated the same way.
- **Reading warnings:** a question whose text couldn't be read, or whose options don't match the count
  Gemini saw, is marked ⚠ with an explanation; editing its text or options clears the warning.
- **Failure:** with a broken key, a page ends as failed with a reason. "Retry" re-queues it; "Draw
  manually" opens the review screen with no boxes, exactly like Phase 1.
- **Review:** each question has a numbered, coloured box; the list under the page shows each crop with
  its text. Tap a box to fix its number, type, text and options. Move/resize, add, delete, split (drag
  the red line), and merge (give two boxes the same number) all work. Pinch to zoom; dragging a selected
  box doesn't scroll the page.
- **Warnings:** a duplicate number, a skipped number, or a block at the top of the page with no number
  is marked ⚠ with an explanation. For the last one, if the previous page in the section ended mid-
  question, its number is filled in and "Continues from an earlier page" is ticked.
- **Two columns:** an unnumbered block at the top of the right column joins the last question of the
  left column (same number, part 2), not an earlier page.
- **Save:** questions get the model's text and options (check in the library). Continuing an existing
  question never replaces text you typed on it. Leave mid-review and come back: edits are kept.
- **Snapping:** open a page with `?debug` on the review URL and tick "Show the model's raw boxes" to
  compare raw (dashed) and snapped boxes. Turning snapping off in Settings makes newly opened pages start
  from the raw boxes.
- **Answer-key pages** still upload straight to "needs review" and never go through the AI queue.

## How things fit together

- **Photos never get lost.** The resized original (JPEG, long edge ≤ 2400px, quality 0.85) is uploaded
  to the private `pages` bucket first and never modified. A flattened copy, if you made one, goes next
  to it as `<page>.clean.jpg` (`pages.processed_path`). Only then is the page row created, as `queued`.
- **The AI queue.** While the app is open, `lib/queue/runner.ts` (mounted once in the app layout)
  takes the oldest unfinished page — `queued`, `rate_limited` past its `retry_after`, or stuck in
  `processing` for over 3 minutes — and calls `POST /api/pages/:id/segment`, one page at a time.
  The route claims the page with a single conditional `UPDATE`, so two tabs can't process the same page.
  On a 429 (or Gemini's 503 "high demand") it sets `rate_limited` with `retry_after` from the provider,
  or 10s doubling per attempt up to 5 min (`pages.retry_count`); it never sleeps inside the request.
- **Two AI stages.** Only `lib/ai.ts` talks to AI providers. `locateQuestions(page)` asks Gemini where
  each question is (boxes, numbers, types, option counts — no text); the boxes are cleaned up
  (`lib/segment/cleanup.ts`), snapped to whitespace and tiled so each runs to the next question in its
  column (`lib/snap.ts`). Then `readQuestion(crop)` asks Groq for each question's text and options from
  its own crop. Groq's own boxes were guesses, and Gemini won't transcribe book text, hence the split.
  Prompts are in `lib/prompts/segment.ts`; replies are validated with Zod (`lib/segment/schema.ts`) and
  retried once with the error if invalid. A question that still can't be read keeps its box with empty
  text and an `unread` flag.
- **Resuming.** Between the two stages, progress lives in `pages.ai_progress` (boxes plus the questions
  read so far). A rate limit or the route's 40s read budget saves it and stops; the next attempt skips
  straight to the next unread question. `pages.ai_result` (raw and snapped boxes, text, flags) is
  written only when every question is read, since the review screen shows whatever is there.
- **Saving a page** (`app/api/pages/[pageId]/save/route.ts`) crops each box with sharp (+2% padding)
  from the flattened copy when there is one (that's what the boxes were drawn on), uploads crops to
  `crops/<user>/<question>/…`, then calls `save_page_questions()`, which inserts all questions (with
  their text and options) and marks the page saved in one transaction. Appending to an existing
  question only adds crops; its text is never touched. If anything fails, uploaded crops are removed.
- **Security.** Every table has row-level security, and server code acts as the signed-in user —
  except the segment route, which uses the service-role key (`lib/supabase/service.ts`). It first
  checks who's calling with the normal session, then filters every query by that `user_id` itself,
  since the service role bypasses RLS. Any new service-role code must do the same.
- **Question numbers** are matched on `number_normalized` ("Q58", "58." and "58" are all "58"), defined
  in SQL and mirrored in `lib/number.ts`. Keep the two in sync; `lib/number.test.ts` uses the same cases.
- **Deleting** a subject, chapter, section, question or page removes its Storage files too
  (`lib/delete.ts`), since database cascades don't reach Storage.
