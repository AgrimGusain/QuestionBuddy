-- =====================================================================
-- Theory-type questions are tagged theory by default.
-- Depends on 20261004000000_phase1_core.sql.
--
-- "Type = theory" (the answer format) and the theory tag (is_theory, the
-- book icon) are separate: Theory revision and the "Theory" filters in the
-- library and Practice only look at the tag. A question saved or changed to
-- type theory was therefore missing from all of them until tagged by hand.
-- Now becoming type theory sets the tag too; it can still be removed
-- afterwards, and other types can still be tagged.
-- =====================================================================

create function tag_theory_type() returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.type = 'theory' and (tg_op = 'INSERT' or old.type is distinct from 'theory') then
    new.is_theory := true;
  end if;
  return new;
end $$;

create trigger questions_tag_theory_type before insert or update of type on questions
  for each row execute function tag_theory_type();

-- Backfill questions already saved as type theory.
update questions set is_theory = true where type = 'theory' and not is_theory;

-- ---------- Rollback (manual) ------------------------------------------
-- drop trigger questions_tag_theory_type on questions;
-- drop function tag_theory_type();
-- (The backfilled tags stay; untag by hand if needed.)
