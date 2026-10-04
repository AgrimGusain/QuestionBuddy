-- =====================================================================
-- save_page_questions: atomically turn a reviewed question page into
-- question rows and mark the page saved.
--
-- Called by POST /api/pages/[pageId]/save after the crops are uploaded.
-- Runs as the caller (security invoker), so RLS and auth.uid() apply.
--
-- p_questions: [{ "id": uuid, "number": text, "type": question_type,
--                 "image_paths": [text, ...], "append": bool }]
--   append = false  -> insert a new question with this id
--   append = true   -> add the crops to the existing question with the
--                      same normalized number in this section (a question
--                      continued from an earlier page)
--
-- Errors (message, SQLSTATE P0001): page_not_found, page_not_question_page,
-- page_already_saved, append_target_missing:<number>.
-- A duplicate number raises unique_violation (23505).
-- =====================================================================
create function save_page_questions(p_page_id uuid, p_questions jsonb)
returns setof uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_page  pages%rowtype;
  v_q     jsonb;
  v_paths text[];
  v_id    uuid;
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
      insert into questions (id, section_id, page_id, number, type, image_paths)
      values ((v_q ->> 'id')::uuid, v_page.section_id, v_page.id,
              v_q ->> 'number', (v_q ->> 'type')::question_type, v_paths)
      returning id into v_id;
    end if;

    return next v_id;
    v_id := null;
  end loop;

  update pages set status = 'saved', error = null where id = p_page_id;
end $$;

-- Rollback: drop function save_page_questions(uuid, jsonb);
