-- =====================================================================
-- Snap Question Bank — Phase 1 core schema
-- Target: Supabase (Postgres 15+). Runs on an empty database.
-- =====================================================================
-- Conventions
--   * Every table carries user_id (default auth.uid()) and is RLS-protected.
--     Server code using the service role must set user_id explicitly:
--     auth.uid() is null there, so a forgotten user_id fails NOT NULL loudly.
--   * Parent references are composite FKs (parent_id, user_id) so a row can
--     never point at another user's data, even though FK checks bypass RLS.
--   * Image columns store Storage object paths ("<user_id>/..."), never
--     public URLs. Buckets are private; the app uses signed URLs.
--   * A question's chapter/subject are derived via section -> chapter.
--     See view question_overview.
-- =====================================================================

-- ---------- Enums ----------------------------------------------------
create type page_kind       as enum ('questions', 'answer_key');
-- Page lifecycle, including the Phase 2 AI queue states:
--   uploaded -> queued -> processing -> needs_review -> saved
--   processing -> rate_limited (retry_after set) -> queued;  any -> failed
create type page_status     as enum ('uploaded', 'queued', 'processing', 'rate_limited',
                                     'needs_review', 'saved', 'failed');
create type question_type   as enum ('mcq', 'msq', 'numerical', 'theory');
create type verdict         as enum ('correct', 'partial', 'wrong');
create type verdict_source  as enum ('auto', 'ai', 'self');  -- auto = exact/range check
create type practice_mode   as enum ('practice', 'theory');

-- ---------- Helpers --------------------------------------------------
create function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- "Q58", "Q.58", "58.", "(58)", " 58 " -> "58";  "12(a)" -> "12a";  "1.2" stays "1.2".
-- Mirrored in lib/number.ts; keep the two in sync.
create function normalize_question_number(n text) returns text
language sql immutable strict parallel safe as $$
  select regexp_replace(
           regexp_replace(
             regexp_replace(
               regexp_replace(lower(n), '\s+', '', 'g'),
             '^(question|ques|q|no)\.?(?=[0-9])', ''),
           '[()\[\]]', '', 'g'),
         '^[.:#]+|[.:]+$', '', 'g')
$$;

-- A set of MCQ/MSQ options: non-empty, each a-e, no duplicates.
create function is_option_set(opts text[]) returns boolean
language sql immutable strict parallel safe as $$
  select cardinality(opts) >= 1
     and array_position(opts, null) is null
     and opts <@ array['a', 'b', 'c', 'd', 'e']
     and cardinality(opts) = (select count(distinct o) from unnest(opts) o)
$$;

-- ---------- subjects -------------------------------------------------
create table subjects (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name        text not null check (length(btrim(name)) > 0),
  created_at  timestamptz not null default now(),
  unique (user_id, name),
  unique (id, user_id)
);

-- ---------- chapters -------------------------------------------------
create table chapters (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid(),
  subject_id  uuid not null,
  name        text not null check (length(btrim(name)) > 0),
  position    integer not null default 0,
  created_at  timestamptz not null default now(),
  foreign key (subject_id, user_id) references subjects (id, user_id) on delete cascade,
  unique (subject_id, name),
  unique (id, user_id)
);
create index chapters_subject_position_idx on chapters (subject_id, position);

-- ---------- sections -------------------------------------------------
-- Question numbers restart per section, so (section, normalized number)
-- is the natural key used for answer-key matching.
create table sections (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid(),
  chapter_id  uuid not null,
  name        text not null check (length(btrim(name)) > 0),
  position    integer not null default 0,
  created_at  timestamptz not null default now(),
  foreign key (chapter_id, user_id) references chapters (id, user_id) on delete cascade,
  unique (chapter_id, name),
  unique (id, user_id),
  unique (id, chapter_id, user_id)        -- lets pages prove section belongs to chapter
);
create index sections_chapter_position_idx on sections (chapter_id, position);

-- ---------- pages ----------------------------------------------------
-- A row is created the moment the original photo lands in Storage,
-- before any processing, so a photo is never lost.
-- Question pages belong to one section; answer-key pages belong to a
-- chapter and may span several sections (section_id optional).
create table pages (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null default auth.uid(),
  chapter_id      uuid not null,
  section_id      uuid,
  kind            page_kind not null,
  status          page_status not null default 'uploaded',
  original_path   text not null,          -- bucket "pages"
  processed_path  text,                   -- perspective-corrected copy (Phase 2)
  retry_after     timestamptz,            -- when a rate-limited page may be retried
  error           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  foreign key (chapter_id, user_id) references chapters (id, user_id) on delete cascade,
  -- Skipped when section_id is null; otherwise the section must be in this chapter.
  foreign key (section_id, chapter_id, user_id)
    references sections (id, chapter_id, user_id) on delete cascade,
  check (kind = 'answer_key' or section_id is not null),
  check ((status = 'rate_limited') = (retry_after is not null)),
  check (status = 'failed' or error is null),
  unique (id, user_id)
);
create index pages_chapter_created_idx on pages (chapter_id, created_at);
create index pages_section_idx on pages (section_id) where section_id is not null;
-- The upload queue: oldest unfinished page first.
create index pages_pending_idx on pages (user_id, created_at)
  where status in ('uploaded', 'queued', 'processing', 'rate_limited', 'needs_review');
create trigger pages_updated_at before update on pages
  for each row execute function set_updated_at();

-- ---------- questions ------------------------------------------------
create table questions (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null default auth.uid(),
  section_id         uuid not null,
  page_id            uuid,                -- page the first crop came from; null if deleted
  number             text not null check (length(btrim(number)) > 0),   -- as printed
  number_normalized  text generated always as (normalize_question_number(number)) stored,
  type               question_type not null default 'mcq',
  -- One or more crops shown in order (bucket "crops"); [1] is the thumbnail.
  image_paths        text[] not null check (cardinality(image_paths) >= 1
                                            and array_position(image_paths, null) is null),
  options            text[],              -- option texts when known (AI, Phase 2)
  ocr_text           text not null default '',  -- typed by hand in Phase 1, from the model in Phase 2
  is_starred         boolean not null default false,
  is_theory          boolean not null default false,
  explanation        text,                -- cached Markdown from /api/explain (Phase 4)
  explained_at       timestamptz,
  search             tsvector generated always as
                       (to_tsvector('english', number || ' ' || ocr_text)) stored,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  foreign key (section_id, user_id) references sections (id, user_id) on delete cascade,
  foreign key (page_id, user_id) references pages (id, user_id) on delete set null (page_id),
  check (length(number_normalized) > 0),
  check (options is null or type in ('mcq', 'msq')),
  check ((explanation is null) = (explained_at is null)),
  unique (section_id, number_normalized),
  unique (id, user_id)
);
create index questions_page_idx    on questions (page_id) where page_id is not null;
create index questions_search_idx  on questions using gin (search);
create index questions_starred_idx on questions (user_id) where is_starred;
create index questions_theory_idx  on questions (user_id) where is_theory;
create trigger questions_updated_at before update on questions
  for each row execute function set_updated_at();

-- ---------- answers --------------------------------------------------
-- At most one answer per question. source_page_id null = entered by hand.
-- Numerical: a single value is stored as numeric_min = numeric_max.
create table answers (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null default auth.uid(),
  question_id        uuid not null,
  answer_text        text,
  answer_image_path  text,                -- bucket "crops" (worked solutions, Phase 3)
  correct_options    text[] check (correct_options is null or is_option_set(correct_options)),
  numeric_min        numeric,
  numeric_max        numeric,
  source_page_id     uuid,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  foreign key (question_id, user_id) references questions (id, user_id) on delete cascade,
  foreign key (source_page_id, user_id) references pages (id, user_id) on delete set null (source_page_id),
  check ((numeric_min is null) = (numeric_max is null)),
  check (numeric_min is null or numeric_min <= numeric_max),
  check (num_nonnulls(answer_text, answer_image_path, correct_options, numeric_min) > 0),
  unique (question_id)
);
create index answers_source_page_idx on answers (source_page_id) where source_page_id is not null;
create trigger answers_updated_at before update on answers
  for each row execute function set_updated_at();

-- ---------- practice_sessions ----------------------------------------
create table practice_sessions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  mode          practice_mode not null default 'practice',
  filters       jsonb not null default '{}'::jsonb,  -- source selector; the queue is rebuilt from it
  target_count  integer check (target_count > 0),    -- null = endless
  started_at    timestamptz not null default now(),
  ended_at      timestamptz,
  check (ended_at is null or ended_at >= started_at),
  unique (id, user_id)
);
create index practice_sessions_user_started_idx on practice_sessions (user_id, started_at desc);

-- ---------- attempts -------------------------------------------------
-- Inserted once per answer. The only later change is an override, which
-- sets verdict_source = 'self' and keeps the machine verdict in original_verdict.
create table attempts (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null default auth.uid(),
  question_id       uuid not null,
  session_id        uuid,
  user_answer       text not null,
  verdict           verdict not null,
  verdict_source    verdict_source not null,
  original_verdict  verdict,
  ai_feedback       text,
  created_at        timestamptz not null default now(),
  foreign key (question_id, user_id) references questions (id, user_id) on delete cascade,
  foreign key (session_id, user_id) references practice_sessions (id, user_id) on delete set null (session_id),
  check (original_verdict is null or verdict_source = 'self')
);
create index attempts_question_created_idx on attempts (question_id, created_at desc);
create index attempts_session_idx on attempts (session_id, created_at) where session_id is not null;

-- ---------- question_overview (library cards + practice filters) ------
-- security_invoker makes the view respect the caller's RLS.
create view question_overview with (security_invoker = true) as
select
  q.id                          as question_id,
  q.user_id,
  q.section_id,
  s.chapter_id,
  c.subject_id,
  q.number,
  q.number_normalized,
  q.type,
  q.is_starred,
  q.is_theory,
  q.ocr_text,
  q.search,
  q.created_at,
  q.image_paths,
  q.image_paths[1]              as thumbnail_path,
  (a.id is not null)            as has_answer,
  coalesce(st.attempt_count, 0) as attempt_count,
  coalesce(st.wrong_count, 0)   as wrong_count,
  la.verdict                    as last_verdict,
  la.created_at                 as last_attempted_at
from questions q
join sections s on s.id = q.section_id
join chapters c on c.id = s.chapter_id
left join answers a on a.question_id = q.id
left join lateral (
  select (count(*))::int                                    as attempt_count,
         (count(*) filter (where t.verdict = 'wrong'))::int as wrong_count
  from attempts t where t.question_id = q.id
) st on true
left join lateral (
  select t.verdict, t.created_at
  from attempts t where t.question_id = q.id
  order by t.created_at desc limit 1
) la on true;

-- ---------- Row Level Security ---------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'subjects', 'chapters', 'sections', 'pages', 'questions',
    'answers', 'practice_sessions', 'attempts'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format(
      $p$create policy owner_all on %I for all to authenticated
         using (user_id = (select auth.uid()))
         with check (user_id = (select auth.uid()))$p$, t);
  end loop;
end $$;

-- ---------- Storage --------------------------------------------------
-- Paths: pages/<user_id>/<page_id>.jpg            (original photo)
--        pages/<user_id>/<page_id>.clean.jpg      (Phase 2 corrected copy)
--        crops/<user_id>/<question_id>/<random>.jpg
insert into storage.buckets (id, name, public)
values ('pages', 'pages', false), ('crops', 'crops', false)
on conflict (id) do nothing;

create policy "own objects in app buckets" on storage.objects
  for all to authenticated
  using (
    bucket_id in ('pages', 'crops')
    and (storage.foldername(name))[1] = (select auth.uid())::text
  )
  with check (
    bucket_id in ('pages', 'crops')
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- ---------- Rollback (manual) ----------------------------------------
-- drop policy "own objects in app buckets" on storage.objects;
-- delete from storage.buckets where id in ('pages', 'crops');  -- only once emptied
-- drop view question_overview;
-- drop table attempts, practice_sessions, answers, questions,
--            pages, sections, chapters, subjects;
-- drop function is_option_set(text[]), normalize_question_number(text), set_updated_at();
-- drop type practice_mode, verdict_source, verdict, question_type, page_status, page_kind;
