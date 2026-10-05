-- =====================================================================
-- Snap Question Bank — Phase 2: AI segmentation queue
-- Depends on 20261004000000_phase1_core.sql, 20261004000100_save_page_questions.sql.
-- =====================================================================

-- ---------- pages: AI segmentation result + backoff bookkeeping ------
-- ai_result shape (see lib/segment/schema.ts for the Zod type):
--   { "model": text, "columns": 1|2,
--     "questions": [{ "number": text|null, "bboxRaw": [x0,y0,x1,y1],
--       "bboxSnapped": [x0,y0,x1,y1], "column": 1|2,
--       "type_guess": question_type, "text": text, "options": text[]|null,
--       "has_diagram": bool, "continues_from_previous": bool,
--       "continues_to_next": bool,
--       "flags": { "duplicate_number": bool, "sequence_gap": bool } }] }
alter table pages
  add column ai_result       jsonb,
  add column ai_model        text,
  add column ai_processed_at timestamptz,
  -- Consecutive rate-limit hits for this page, used to compute exponential
  -- backoff (10s * 2^retry_count, capped at 5min) when Groq sends no
  -- retry-after header. Reset to 0 on a fresh queue entry or a manual retry.
  add column retry_count     smallint not null default 0;

-- ---------- save_page_questions: accept OCR text/options on insert ---
-- p_questions items gain two optional fields, read ONLY on insert
-- (append never touches ocr_text/options — it only ever does
-- image_paths = image_paths || v_paths — so hand-typed text on an
-- existing question is never overwritten):
--   "ocr_text": text | absent     -> questions.ocr_text (default '')
--   "options":  text[] | absent   -> questions.options, forced null
--               unless type in ('mcq','msq'), matching the table CHECK.
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

  update pages set status = 'saved', error = null where id = p_page_id;
end $$;

-- ---------- Rollback (manual) ------------------------------------------
-- create or replace function save_page_questions(p_page_id uuid, p_questions jsonb)
--   returns setof uuid language plpgsql security invoker set search_path = public as $$
--   <restore the Phase 1 body from 20261004000100_save_page_questions.sql>
-- $$;
-- alter table pages drop column ai_result, drop column ai_model,
--                    drop column ai_processed_at, drop column retry_count;
