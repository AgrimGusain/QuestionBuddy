# Snap Question Bank — Phase 1

Photograph textbook pages, box each question, and build a searchable bank you can practise from.

Phase 1 covers: email sign-in, subjects/chapters/sections, photo upload with manual question boxes,
library with search and filters, star and theory tags, typed answers (MCQ, MSQ, numerical, theory),
practice and theory revision with auto-checking or self-marking, session summaries, and share/copy.

## Setup

1. **Create a Supabase project** (free tier is fine).

2. **Run the migrations**, in order, in the Supabase SQL editor (or `supabase db push` with the CLI):
   - `supabase/migrations/20261004000000_phase1_core.sql`
   - `supabase/migrations/20261004000100_save_page_questions.sql`

3. **Create your account.** Authentication → Users → Add user → enter email and password,
   tick "Auto confirm user". Then Authentication → Sign In / Providers → turn off
   "Allow new users to sign up", so nobody else can create an account.

4. **Environment.** Copy `.env.example` to `.env.local` and fill in the project URL and the
   publishable (or anon) key from Project Settings → API.

5. **Run it.**
   ```bash
   npm install
   npm run dev        # http://localhost:3000
   npm test           # grading and number-normalisation tests
   ```

## Testing on your phone

Share and clipboard features, and `crypto.randomUUID`, only work on HTTPS (or localhost).
The simplest route is a free Vercel deploy: import the repo, add the two `NEXT_PUBLIC_` env vars,
deploy, and open the URL on the phone. Plain `http://<your-laptop-ip>:3000` works for everything
except "Share image" and "Copy text".

## Phase 1 test checklist

- Sign in; signing out returns you to the login screen.
- Upload: create a subject, chapter and section inline; take a photo and pick several from the gallery.
  Each shows "Saved", and appears under "Waiting for question boxes" (also on Home).
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

## How things fit together

- **Photos never get lost.** The resized original (JPEG, long edge ≤ 3000px) is uploaded to the
  private `pages` bucket before the page row exists, and the row is created before any cropping.
- **Saving a page** (`app/api/pages/[pageId]/save/route.ts`) crops each box with sharp (+2% padding),
  uploads crops to `crops/<user>/<question>/…`, then calls `save_page_questions()`, which inserts all
  questions and marks the page saved in one transaction. If anything fails, uploaded crops are removed.
- **Security.** Every table has row-level security, and server code acts as the signed-in user.
  Any future code using the service-role key must set `user_id` explicitly (auth.uid() is null there).
- **Question numbers** are matched on `number_normalized` ("Q58", "58." and "58" are all "58"), defined
  in SQL and mirrored in `lib/number.ts`. Keep the two in sync; `lib/number.test.ts` uses the same cases.
- **Deleting** a subject, chapter, section, question or page removes its Storage files too
  (`lib/delete.ts`), since database cascades don't reach Storage.
