-- =====================================================================
-- Snap Question Bank — Phase 3: answer keys
-- Depends on every earlier migration (20261004000000 … 20261005000200).
--
-- Answer-key pages are read into answer_key_entries first and matched to
-- questions second, by (section, normalized number). Matching runs in SQL
-- (match_answer_key_entries) after a key page is saved, after questions are
-- saved, and whenever the app changes something matching depends on.
--
-- Ownership of answers:
--   answers.source_page_id = a key page  -> written by matching, never edited
--                                           by hand since; matching may update
--                                           or delete it.
--   answers.source_page_id is null       -> typed (or edited) by hand; matching
--                                           never overwrites it, only fills
--                                           empty fields such as the solution
--                                           image.
-- Files: solution crops live at crops/<user>/keys/<page>/<entry>.jpg and are
-- owned by their entry; they're removed when the key page goes.
-- =====================================================================

create type answer_entry_kind   as enum ('short', 'worked');
-- unmatched / matched / conflict are recomputed by every matching run;
-- ignored and kept_mine are the user's decisions and are never touched by it.
create type answer_entry_status as enum ('unmatched', 'matched', 'conflict', 'ignored', 'kept_mine');

-- Lets an entry prove its chapter is its page's chapter.
alter table pages add constraint pages_id_chapter_user_key unique (id, chapter_id, user_id);

-- ---------- answer_key_entries ----------------------------------------
create table answer_key_entries (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null default auth.uid(),
  page_id           uuid not null,
  chapter_id        uuid not null,
  section_id        uuid,                          -- null = not assigned yet
  number            text not null check (length(btrim(number)) > 0),
  number_normalized text generated always as (normalize_question_number(number)) stored,
  kind              answer_entry_kind not null,
  raw_text          text not null default '',      -- exactly as read, or as edited in review
  -- Parsed by lib/answer-key/parse.ts (never by the model). A "(1)"-style
  -- answer carries both readings (option a and number 1, flag digit_option);
  -- the question's type picks one when matching.
  correct_options   text[] check (correct_options is null or is_option_set(correct_options)),
  numeric_min       numeric,
  numeric_max       numeric,
  answer_text       text,                          -- unparsed short answer, or worked solution text
  parse_flags       text[] not null default '{}',  -- digit_option, no_answer, unparsed, …
  image_path        text,                          -- bucket "crops", worked solutions only
  bbox              real[] check (bbox is null or cardinality(bbox) = 4),  -- [x0, y0, x1, y1], 0-1
  status            answer_entry_status not null default 'unmatched',
  question_id       uuid,
  conflict_reason   text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  foreign key (page_id, chapter_id, user_id) references pages (id, chapter_id, user_id) on delete cascade,
  -- Deleting a section keeps the entry (it was read from a page that still
  -- exists); it just needs a section again.
  foreign key (section_id, chapter_id, user_id)
    references sections (id, chapter_id, user_id) on delete set null (section_id),
  foreign key (question_id, user_id) references questions (id, user_id) on delete set null (question_id),
  check (length(number_normalized) > 0),
  check ((numeric_min is null) = (numeric_max is null)),
  check (numeric_min is null or numeric_min <= numeric_max),
  check (kind = 'worked' or image_path is null),
  check (status <> 'conflict' or conflict_reason is not null),
  -- No "matched implies question_id" check: deleting a question sets
  -- question_id to null on its entries, which stay 'matched' until the
  -- app re-runs matching for the chapter (it does, right after deleting).
  unique (id, user_id)
);
create index answer_key_entries_match_idx on answer_key_entries (chapter_id, section_id, number_normalized)
  where status not in ('ignored', 'kept_mine');
create index answer_key_entries_page_idx on answer_key_entries (page_id);
create index answer_key_entries_question_idx on answer_key_entries (question_id) where question_id is not null;
create trigger answer_key_entries_updated_at before update on answer_key_entries
  for each row execute function set_updated_at();

alter table answer_key_entries enable row level security;
create policy owner_all on answer_key_entries for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- ---------- helpers ----------------------------------------------------
-- What a short entry means for a question of a given type: either a usable
-- answer, or the reason it can't be used.
create function answer_key_interpret(
  p_type question_type, p_options text[], p_min numeric, p_max numeric,
  p_text text, p_raw text, p_flags text[],
  out options text[], out numeric_min numeric, out numeric_max numeric,
  out answer_text text, out reason text)
language plpgsql immutable
set search_path = public
as $$
begin
  if 'no_answer' = any(p_flags) then
    reason := 'key_no_answer';
  elsif p_type = 'numerical' then
    if p_min is not null then
      numeric_min := p_min;
      numeric_max := p_max;
    elsif p_options is not null then
      reason := 'option_on_numerical';
    else
      reason := 'unreadable_answer';
    end if;
  elsif p_type in ('mcq', 'msq') then
    if p_options is not null then
      if p_type = 'mcq' and cardinality(p_options) > 1 then
        reason := 'multiple_options_on_mcq';
      else
        options := p_options;
      end if;
    elsif p_min is not null then
      reason := 'number_on_mcq';
    else
      reason := 'unreadable_answer';
    end if;
  else -- theory
    if p_options is not null and p_min is null then
      reason := 'option_on_theory';
    else
      answer_text := coalesce(nullif(btrim(p_text), ''), nullif(btrim(p_raw), ''));
      if answer_text is null then
        reason := 'unreadable_answer';
      end if;
    end if;
  end if;
end $$;

-- Whether an existing answer already says what the key says (options as a
-- set, or the same number/range). Text never counts as a difference.
create function answer_key_same(p_a answers, p_opts text[], p_min numeric, p_max numeric)
returns boolean
language sql immutable
set search_path = public
as $$
  select case
    when p_opts is not null then
      p_a.correct_options is not null
      and (select array_agg(x order by x) from unnest(p_a.correct_options) x)
        = (select array_agg(x order by x) from unnest(p_opts) x)
    when p_min is not null then
      p_a.numeric_min = p_min and p_a.numeric_max = p_max
    else true
  end
$$;

-- ---------- match_answer_key_entries ----------------------------------
-- Recomputes every entry in a chapter except ignored / kept_mine, and
-- writes key answers. Idempotent: a second run changes no data (only rows
-- whose values actually change are written).
create function match_answer_key_entries(p_chapter_id uuid)
returns table (matched integer, conflicts integer, unmatched integer)
language plpgsql
security invoker
set search_path = public
as $$
declare
  g          record;
  v_q        questions%rowtype;
  v_a        answers%rowtype;
  s          answer_key_entries%rowtype;
  w          answer_key_entries%rowtype;
  v_i        record;
  v_variants integer;
  v_has_w    boolean;
  v_pages    uuid[];
  v_opts     text[];
  v_min      numeric;
  v_max      numeric;
  v_text     text;
  v_image    text;
  v_source   uuid;
  v_reason   text;
  v_status   answer_entry_status;
  v_new_id   uuid;
  v_fill     boolean;
begin
  -- One matching run per chapter at a time: two saves into the same chapter
  -- queue here instead of racing on the same answers.
  perform pg_advisory_xact_lock(hashtextextended(p_chapter_id::text, 0));

  -- 1. Start over, except for what the user decided.
  update answer_key_entries
     set status = 'unmatched', question_id = null, conflict_reason = null
   where chapter_id = p_chapter_id
     and status not in ('ignored', 'kept_mine')
     and (status, question_id, conflict_reason)
         is distinct from ('unmatched'::answer_entry_status, null::uuid, null::text);

  -- 2. Stale key answers: written from a key page that no longer has an
  --    entry for that question (renumbered, moved, ignored). Hand-edited
  --    answers have source_page_id = null and are never touched.
  delete from answers a
   using questions q, sections sc, pages p
   where a.question_id = q.id
     and q.section_id = sc.id
     and sc.chapter_id = p_chapter_id
     and p.id = a.source_page_id
     and p.kind = 'answer_key'
     and not exists (
       select 1 from answer_key_entries e
        where e.page_id = a.source_page_id
          and e.status <> 'ignored'
          and e.section_id = q.section_id
          and e.number_normalized = q.number_normalized);

  -- 3. The same number twice in one section on one page (same kind): match
  --    neither until the user fixes it. A short and a worked entry with the
  --    same number complement each other and are not duplicates.
  update answer_key_entries e
     set status = 'conflict', conflict_reason = 'duplicate_number'
   where e.chapter_id = p_chapter_id
     and e.status = 'unmatched'
     and e.section_id is not null
     and exists (
       select 1 from answer_key_entries d
        where d.id <> e.id
          and d.page_id = e.page_id
          and d.kind = e.kind
          and d.section_id = e.section_id
          and d.number_normalized = e.number_normalized
          and d.status not in ('ignored', 'kept_mine'));

  -- 4. Every question that has entries waiting.
  for g in
    select q.id as question_id
      from answer_key_entries e
      join questions q on q.section_id = e.section_id and q.number_normalized = e.number_normalized
     where e.chapter_id = p_chapter_id
       and e.status = 'unmatched'
     group by q.id
  loop
    select * into v_q from questions where id = g.question_id;
    v_opts := null; v_min := null; v_max := null; v_text := null;
    v_image := null; v_source := null; v_reason := null;

    select array_agg(distinct e.page_id) into v_pages
      from answer_key_entries e
     where e.section_id = v_q.section_id and e.number_normalized = v_q.number_normalized
       and e.status = 'unmatched';

    -- Short entries decide options / numbers.
    select count(distinct jsonb_build_array(e.correct_options, e.numeric_min, e.numeric_max,
                                            e.answer_text, 'no_answer' = any(e.parse_flags)))
      into v_variants
      from answer_key_entries e
     where e.section_id = v_q.section_id and e.number_normalized = v_q.number_normalized
       and e.status = 'unmatched' and e.kind = 'short';

    if v_variants > 1 then
      update answer_key_entries e
         set status = 'conflict', conflict_reason = 'key_pages_disagree', question_id = v_q.id
       where e.section_id = v_q.section_id and e.number_normalized = v_q.number_normalized
         and e.status = 'unmatched' and e.kind = 'short';
    elsif v_variants = 1 then
      select * into s from answer_key_entries e
       where e.section_id = v_q.section_id and e.number_normalized = v_q.number_normalized
         and e.status = 'unmatched' and e.kind = 'short'
       order by e.created_at, e.id
       limit 1;
      select * into v_i from answer_key_interpret(
        v_q.type, s.correct_options, s.numeric_min, s.numeric_max, s.answer_text, s.raw_text, s.parse_flags);
      if v_i.reason is not null then
        v_reason := v_i.reason;
      else
        v_opts := v_i.options;
        v_min := v_i.numeric_min;
        v_max := v_i.numeric_max;
        v_text := v_i.answer_text;
        v_source := s.page_id;
      end if;
    end if;

    -- A worked solution adds its image and text.
    select * into w from answer_key_entries e
     where e.section_id = v_q.section_id and e.number_normalized = v_q.number_normalized
       and e.status = 'unmatched' and e.kind = 'worked'
     order by e.created_at, e.id
     limit 1;
    v_has_w := found;
    if v_has_w then
      v_image := w.image_path;
      v_text := coalesce(v_text, nullif(btrim(w.answer_text), ''));
      v_source := coalesce(v_source, w.page_id);
    end if;

    v_status := case when v_reason is null then 'matched' else 'conflict' end;

    -- 5. Write the answer. Insert first: if an answer already exists (or
    --    another transaction just wrote one) the insert does nothing and the
    --    existing row is reconciled below instead.
    v_new_id := null;
    if v_opts is not null or v_min is not null or v_text is not null or v_image is not null then
      insert into answers (question_id, user_id, correct_options, numeric_min, numeric_max,
                           answer_text, answer_image_path, source_page_id)
      values (v_q.id, v_q.user_id, v_opts, v_min, v_max, v_text, v_image, v_source)
      on conflict (question_id) do nothing
      returning id into v_new_id;
    end if;

    if v_new_id is null then
      select * into v_a from answers where question_id = v_q.id for update;
      if found then
        if v_variants <= 1 and v_a.source_page_id is not null and v_a.source_page_id = any(v_pages) then
          -- This key's own earlier answer: bring it in line with the key.
          -- (Not while key pages disagree: then the answer stays as it is
          -- until the user resolves the disagreement.)
          if v_opts is null and v_min is null and v_text is null and v_image is null then
            delete from answers where id = v_a.id;
          else
            update answers
               set correct_options = v_opts, numeric_min = v_min, numeric_max = v_max,
                   answer_text = v_text, answer_image_path = v_image, source_page_id = v_source
             where id = v_a.id
               and (correct_options, numeric_min, numeric_max, answer_text, answer_image_path, source_page_id)
                   is distinct from (v_opts, v_min, v_max, v_text, v_image, v_source);
          end if;
        else
          -- Typed by hand, or written from another key page: never overwritten.
          if (v_opts is not null or v_min is not null)
             and (v_a.correct_options is not null or v_a.numeric_min is not null)
             and not answer_key_same(v_a, v_opts, v_min, v_max) then
            v_status := 'conflict';
            v_reason := case when v_a.source_page_id is null then 'differs_from_your_answer'
                             else 'differs_from_key_answer' end;
          end if;
          -- Fill only what's empty.
          v_fill := v_status = 'matched' and v_a.correct_options is null and v_a.numeric_min is null;
          update answers
             set correct_options   = case when v_fill then v_opts else correct_options end,
                 numeric_min       = case when v_fill then v_min else numeric_min end,
                 numeric_max       = case when v_fill then v_max else numeric_max end,
                 answer_text       = coalesce(answer_text, v_text),
                 answer_image_path = coalesce(answer_image_path, v_image)
           where id = v_a.id
             and (correct_options, numeric_min, numeric_max, answer_text, answer_image_path)
                 is distinct from (
                   case when v_fill then v_opts else v_a.correct_options end,
                   case when v_fill then v_min else v_a.numeric_min end,
                   case when v_fill then v_max else v_a.numeric_max end,
                   coalesce(v_a.answer_text, v_text),
                   coalesce(v_a.answer_image_path, v_image));
        end if;
      end if;
    end if;

    -- 6. Record the outcome. Worked entries are matched whenever their
    --    question is; the short entry carries any conflict.
    update answer_key_entries e
       set status = case when e.kind = 'short' then v_status else 'matched'::answer_entry_status end,
           conflict_reason = case when e.kind = 'short' then v_reason else null end,
           question_id = v_q.id
     where e.section_id = v_q.section_id and e.number_normalized = v_q.number_normalized
       and e.status = 'unmatched';
  end loop;

  return query
  select (count(*) filter (where e.status = 'matched'))::integer,
         (count(*) filter (where e.status = 'conflict'))::integer,
         (count(*) filter (where e.status = 'unmatched'))::integer
    from answer_key_entries e
   where e.chapter_id = p_chapter_id;
end $$;

-- ---------- save_answer_key_page ---------------------------------------
-- p_entries items: { id, kind, number, section_id|null, raw_text,
--   correct_options|null, numeric_min|null, numeric_max|null, answer_text|null,
--   parse_flags[], image_path|null, bbox|null, ignored }
-- Parsed fields come from lib/answer-key/parse.ts on the server.
create function save_answer_key_page(p_page_id uuid, p_entries jsonb)
returns setof uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_page pages%rowtype;
  v_e    jsonb;
  v_id   uuid;
begin
  -- Row lock: a double-tapped Save waits here, then sees status = 'saved'.
  select * into v_page from pages where id = p_page_id for update;
  if not found then
    raise exception 'page_not_found';
  end if;
  if v_page.kind <> 'answer_key' then
    raise exception 'page_not_answer_key';
  end if;
  if v_page.status = 'saved' then
    raise exception 'page_already_saved';
  end if;

  for v_e in select * from jsonb_array_elements(p_entries) loop
    insert into answer_key_entries (
      id, page_id, chapter_id, section_id, number, kind, raw_text,
      correct_options, numeric_min, numeric_max, answer_text, parse_flags,
      image_path, bbox, status)
    values (
      (v_e ->> 'id')::uuid, v_page.id, v_page.chapter_id, nullif(v_e ->> 'section_id', '')::uuid,
      v_e ->> 'number', (v_e ->> 'kind')::answer_entry_kind, coalesce(v_e ->> 'raw_text', ''),
      case when jsonb_typeof(v_e -> 'correct_options') = 'array'
           then array(select jsonb_array_elements_text(v_e -> 'correct_options')) end,
      (v_e ->> 'numeric_min')::numeric, (v_e ->> 'numeric_max')::numeric,
      nullif(v_e ->> 'answer_text', ''),
      case when jsonb_typeof(v_e -> 'parse_flags') = 'array'
           then array(select jsonb_array_elements_text(v_e -> 'parse_flags')) else '{}' end,
      nullif(v_e ->> 'image_path', ''),
      case when jsonb_typeof(v_e -> 'bbox') = 'array'
           then array(select (jsonb_array_elements_text(v_e -> 'bbox'))::real) end,
      case when coalesce((v_e ->> 'ignored')::boolean, false)
           then 'ignored'::answer_entry_status else 'unmatched'::answer_entry_status end)
    returning id into v_id;
    return next v_id;
  end loop;

  perform match_answer_key_entries(v_page.chapter_id);
  update pages set status = 'saved', error = null, retry_after = null where id = p_page_id;
end $$;

-- ---------- apply_answer_key_entry --------------------------------------
-- "Use key answer": the user's explicit choice to replace the current answer
-- with what the key says. Removes the current answer and re-matches.
create function apply_answer_key_entry(p_entry_id uuid)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_e answer_key_entries%rowtype;
begin
  select * into v_e from answer_key_entries where id = p_entry_id;
  if not found then
    raise exception 'entry_not_found';
  end if;
  if v_e.question_id is null or v_e.status not in ('conflict', 'kept_mine') then
    raise exception 'entry_not_in_conflict';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_e.chapter_id::text, 0));
  delete from answers where question_id = v_e.question_id;
  update answer_key_entries set status = 'unmatched', conflict_reason = null where id = p_entry_id;
  perform match_answer_key_entries(v_e.chapter_id);
end $$;

-- ---------- delete_answer_key_page --------------------------------------
-- Deletes a key page and what it wrote, in one transaction:
--   * answers it wrote and nobody edited since (source_page_id = the page)
--     are deleted;
--   * answers edited by hand (source_page_id null) are kept, image and all;
--   * key answers from other pages that borrowed this page's solution image
--     lose the image (and are deleted if nothing else is left);
--   * the page's entries go with it (cascade), then the chapter is re-matched
--     so other key pages can fill the gaps.
-- Returns the solution image paths nothing refers to any more, for the
-- caller to remove from Storage.
create function delete_answer_key_page(p_page_id uuid)
returns text[]
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_page   pages%rowtype;
  v_images text[];
begin
  select * into v_page from pages where id = p_page_id for update;
  if not found then
    return '{}';
  end if;
  if v_page.kind <> 'answer_key' then
    raise exception 'page_not_answer_key';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_page.chapter_id::text, 0));

  select coalesce(array_agg(image_path), '{}') into v_images
    from answer_key_entries
   where page_id = p_page_id and image_path is not null;

  delete from answers where source_page_id = p_page_id;
  delete from answers
   where answer_image_path = any(v_images)
     and source_page_id is not null
     and num_nonnulls(answer_text, correct_options, numeric_min) = 0;
  update answers set answer_image_path = null
   where answer_image_path = any(v_images) and source_page_id is not null;

  delete from pages where id = p_page_id;
  perform match_answer_key_entries(v_page.chapter_id);

  return array(
    select unnest(v_images)
    except
    select answer_image_path from answers where answer_image_path = any(v_images));
end $$;

-- ---------- save_page_questions: match after saving questions ----------
-- Same body as 20261005000100_ai_progress.sql, plus the matching call, so
-- key entries saved before their questions are matched as soon as the
-- questions exist.
create or replace function save_page_questions(p_page_id uuid, p_questions jsonb)
returns setof uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_page    pages%rowtype;
  v_q       jsonb;
  v_paths   text[];
  v_options text[];
  v_id      uuid;
begin
  -- Row lock: a double-tapped Save waits here, then sees status = 'saved'.
  select * into v_page from pages where id = p_page_id for update;
  if not found then
    raise exception 'page_not_found';
  end if;
  if v_page.kind <> 'questions' or v_page.section_id is null then
    raise exception 'page_not_question_page';
  end if;
  if v_page.status = 'saved' then
    raise exception 'page_already_saved';
  end if;

  for v_q in select * from jsonb_array_elements(p_questions) loop
    v_paths := array(select jsonb_array_elements_text(v_q -> 'image_paths'));

    if coalesce((v_q ->> 'append')::boolean, false) then
      update questions
         set image_paths = image_paths || v_paths
       where section_id = v_page.section_id
         and number_normalized = normalize_question_number(v_q ->> 'number')
      returning id into v_id;
      if v_id is null then
        raise exception 'append_target_missing:%', v_q ->> 'number';
      end if;
    else
      v_options := case
        when (v_q ->> 'type') in ('mcq', 'msq') and jsonb_typeof(v_q -> 'options') = 'array'
          then array(select jsonb_array_elements_text(v_q -> 'options'))
        else null
      end;
      insert into questions (id, section_id, page_id, number, type, image_paths, ocr_text, options)
      values ((v_q ->> 'id')::uuid, v_page.section_id, v_page.id,
              v_q ->> 'number', (v_q ->> 'type')::question_type, v_paths,
              coalesce(v_q ->> 'ocr_text', ''), v_options)
      returning id into v_id;
    end if;

    return next v_id;
    v_id := null;
  end loop;

  perform match_answer_key_entries(v_page.chapter_id);
  update pages set status = 'saved', error = null, retry_after = null where id = p_page_id;
end $$;

-- ---------- Rollback (manual) ------------------------------------------
-- Re-run the save_page_questions definition from
-- 20261005000100_ai_progress.sql, then:
-- drop function delete_answer_key_page(uuid), apply_answer_key_entry(uuid),
--   save_answer_key_page(uuid, jsonb), match_answer_key_entries(uuid),
--   answer_key_same(answers, text[], numeric, numeric),
--   answer_key_interpret(question_type, text[], numeric, numeric, text, text, text[]);
-- drop table answer_key_entries;
-- alter table pages drop constraint pages_id_chapter_user_key;
-- drop type answer_entry_status, answer_entry_kind;
