-- =====================================================================
-- Phase 2 follow-up: two-stage AI pipeline progress + save fix.
-- Depends on 20261005000000_phase2_ai_queue.sql.
-- =====================================================================

-- ---------- pages.ai_progress: resumable AI pipeline state -----------
-- The segment route now locates questions (Gemini) and then reads each one
-- (Groq) separately. When a rate limit or the request's time budget stops
-- it part-way, the located boxes and the questions read so far are kept
-- here, so the next attempt resumes instead of starting over. Shape: see
-- AiProgress in lib/segment/schema.ts. Null except while a page is
-- part-way through; ai_result stays the only thing the review screen reads.
alter table pages add column ai_progress jsonb;

-- ---------- save_page_questions: clear retry_after when saving -------
-- A rate-limited page can be boxed and saved by hand while it waits for
-- its retry. pages CHECK ((status = 'rate_limited') = (retry_after is not
-- null)) then rejected the final status = 'saved' update, because
-- retry_after was left set. Body is otherwise identical to the Phase 2 one.
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

  update pages set status = 'saved', error = null, retry_after = null where id = p_page_id;
end $$;

-- ---------- Rollback (manual) ------------------------------------------
-- Re-run the save_page_questions definition from
-- 20261005000000_phase2_ai_queue.sql, then:
-- alter table pages drop column ai_progress;
