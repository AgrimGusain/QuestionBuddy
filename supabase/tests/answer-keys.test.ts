/**
 * Answer-key matching, saving and deleting, run against the real migrations
 * on PGlite, as a signed-in user (RLS applies). Each test makes its own user,
 * so tests share one database without seeing each other's rows.
 */
import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { parseAnswer } from "@/lib/answer-key/parse";
import { actAs, freshDb } from "./pglite";

let db: PGlite;
beforeAll(async () => {
  db = await freshDb();
}, 60_000);

type Row = Record<string, unknown>;
const rows = async (sql: string, params?: unknown[]) => (await db.query<Row>(sql, params)).rows;
const one = async (sql: string, params?: unknown[]) => (await rows(sql, params))[0];

interface World {
  user: string;
  chapter: string;
  s1: string;
  s2: string;
}

async function world(): Promise<World> {
  const user = crypto.randomUUID();
  await actAs(db, user);
  const subject = await one(`insert into subjects (name) values ('Subject') returning id`);
  const chapter = await one(`insert into chapters (subject_id, name) values ($1, 'Arrays') returning id`, [subject.id]);
  const s1 = await one(`insert into sections (chapter_id, name) values ($1, 'Exercise 1') returning id`, [chapter.id]);
  const s2 = await one(`insert into sections (chapter_id, name) values ($1, 'Exercise 2') returning id`, [chapter.id]);
  return { user, chapter: chapter.id as string, s1: s1.id as string, s2: s2.id as string };
}

/** Save a question page; returns question ids by number. */
async function saveQuestions(w: World, section: string, qs: { number: string; type: string }[]) {
  const page = await one(
    `insert into pages (chapter_id, section_id, kind, status, original_path) values ($1, $2, 'questions', 'needs_review', 'q.jpg') returning id`,
    [w.chapter, section],
  );
  const payload = qs.map((q) => ({ id: crypto.randomUUID(), number: q.number, type: q.type, append: false, image_paths: [`${w.user}/x/${q.number}.jpg`] }));
  await db.query(`select * from save_page_questions($1, $2)`, [page.id, JSON.stringify(payload)]);
  return Object.fromEntries(payload.map((p) => [p.number, p.id])) as Record<string, string>;
}

interface KeyEntryInput {
  number: string;
  raw?: string;
  kind?: "short" | "worked";
  section?: string | null;
  ignored?: boolean;
  image?: string;
  text?: string;
}

/** Save an answer-key page, parsing short answers with the real parser; returns { page, ids by number+kind }. */
async function saveKey(w: World, entries: KeyEntryInput[], defaultSection: string | null = w.s1) {
  const page = await one(
    `insert into pages (chapter_id, kind, status, original_path) values ($1, 'answer_key', 'needs_review', 'k.jpg') returning id`,
    [w.chapter],
  );
  const payload = entries.map((e) => {
    const kind = e.kind ?? "short";
    const p = kind === "short" ? parseAnswer(e.raw ?? "") : null;
    return {
      id: crypto.randomUUID(),
      kind,
      number: e.number,
      section_id: e.section === undefined ? defaultSection : e.section,
      raw_text: e.raw ?? e.text ?? "",
      correct_options: p?.options ?? null,
      numeric_min: p?.numericMin ?? null,
      numeric_max: p?.numericMax ?? null,
      answer_text: kind === "worked" ? (e.text ?? null) : (p?.text ?? null),
      parse_flags: p?.flags ?? [],
      image_path: e.image ?? null,
      bbox: [0.1, 0.1, 0.9, 0.2],
      ignored: e.ignored ?? false,
    };
  });
  await db.query(`select * from save_answer_key_page($1, $2)`, [page.id, JSON.stringify(payload)]);
  const ids: Record<string, string> = {};
  for (const p of payload) ids[`${p.number}${p.kind === "worked" ? "w" : ""}`] = p.id;
  return { page: page.id as string, ids };
}

const answerOf = (questionId: string) => one(`select * from answers where question_id = $1`, [questionId]);
const entry = (id: string) => one(`select * from answer_key_entries where id = $1`, [id]);
const match = (chapter: string) => one(`select * from match_answer_key_entries($1)`, [chapter]);
const nums = (a: Row | undefined) => (a ? [Number(a.numeric_min), Number(a.numeric_max)] : null);

describe("match_answer_key_entries", () => {
  it("matches a key saved after its questions and writes key answers", async () => {
    const w = await world();
    const q = await saveQuestions(w, w.s1, [
      { number: "1", type: "mcq" },
      { number: "2", type: "numerical" },
      { number: "3", type: "msq" },
    ]);
    const key = await saveKey(w, [{ number: "1", raw: "(d)" }, { number: "2", raw: "(5)" }, { number: "3", raw: "(a; c)" }]);

    expect((await answerOf(q["1"])).correct_options).toEqual(["d"]);
    expect(nums(await answerOf(q["2"]))).toEqual([5, 5]);
    expect((await answerOf(q["3"])).correct_options).toEqual(["a", "c"]);
    expect((await answerOf(q["1"])).source_page_id).toBe(key.page);
    for (const id of Object.values(key.ids)) {
      expect(await entry(id)).toMatchObject({ status: "matched", conflict_reason: null });
    }
    expect((await entry(key.ids["1"])).question_id).toBe(q["1"]);
  });

  it("keeps entries unmatched until their questions are saved, then matches them in save_page_questions", async () => {
    const w = await world();
    const key = await saveKey(w, [{ number: "58", raw: "(c)" }]);
    expect(await entry(key.ids["58"])).toMatchObject({ status: "unmatched", question_id: null });

    const q = await saveQuestions(w, w.s1, [{ number: "Q58", type: "mcq" }]);
    expect(await entry(key.ids["58"])).toMatchObject({ status: "matched", question_id: q["Q58"] });
    expect((await answerOf(q["Q58"])).correct_options).toEqual(["c"]);
  });

  it("never overwrites a hand answer: a different one is a conflict, the same one matches unchanged", async () => {
    const w = await world();
    const q = await saveQuestions(w, w.s1, [
      { number: "1", type: "mcq" },
      { number: "2", type: "mcq" },
    ]);
    await db.query(`insert into answers (question_id, correct_options) values ($1, '{b}'), ($2, '{d}')`, [q["1"], q["2"]]);
    const before = await answerOf(q["2"]);

    const key = await saveKey(w, [{ number: "1", raw: "(d)" }, { number: "2", raw: "(d)" }]);

    expect(await entry(key.ids["1"])).toMatchObject({ status: "conflict", conflict_reason: "differs_from_your_answer", question_id: q["1"] });
    expect((await answerOf(q["1"])).correct_options).toEqual(["b"]);
    expect((await answerOf(q["1"])).source_page_id).toBeNull();
    expect(await entry(key.ids["2"])).toMatchObject({ status: "matched" });
    expect(await answerOf(q["2"])).toEqual(before);
  });

  it("adds a worked solution's image to a hand answer that has none, without touching the rest", async () => {
    const w = await world();
    const q = await saveQuestions(w, w.s1, [{ number: "1", type: "mcq" }]);
    await db.query(`insert into answers (question_id, correct_options, answer_text) values ($1, '{b}', 'my note')`, [q["1"]]);
    const key = await saveKey(w, [{ number: "1", kind: "worked", image: `${w.user}/keys/p/1.jpg`, text: "Because…" }]);

    expect(await answerOf(q["1"])).toMatchObject({
      correct_options: ["b"],
      answer_text: "my note",
      answer_image_path: `${w.user}/keys/p/1.jpg`,
      source_page_id: null,
    });
    expect(await entry(key.ids["1w"])).toMatchObject({ status: "matched" });
  });

  it("turns type mismatches into conflicts with a reason and writes no answer", async () => {
    const w = await world();
    const q = await saveQuestions(w, w.s1, [
      { number: "1", type: "numerical" },
      { number: "2", type: "mcq" },
      { number: "3", type: "mcq" },
      { number: "4", type: "theory" },
      { number: "5", type: "mcq" },
      { number: "6", type: "mcq" },
    ]);
    const key = await saveKey(w, [
      { number: "1", raw: "(c)" },
      { number: "2", raw: "4.5" },
      { number: "3", raw: "(a, c)" },
      { number: "4", raw: "(b)" },
      { number: "5", raw: "Bonus" },
      { number: "6", raw: "12 m/s" },
    ]);
    const reasons = await Promise.all(["1", "2", "3", "4", "5", "6"].map(async (n) => (await entry(key.ids[n])).conflict_reason));
    expect(reasons).toEqual([
      "option_on_numerical",
      "number_on_mcq",
      "multiple_options_on_mcq",
      "option_on_theory",
      "key_no_answer",
      "unreadable_answer",
    ]);
    for (const n of ["1", "2", "3", "4", "5", "6"]) expect(await answerOf(q[n])).toBeUndefined();
  });

  it("reads a digit answer as an option or a number depending on the question type", async () => {
    const w = await world();
    const q = await saveQuestions(w, w.s1, [
      { number: "1", type: "mcq" },
      { number: "2", type: "numerical" },
    ]);
    const key = await saveKey(w, [{ number: "1", raw: "(3)" }, { number: "2", raw: "(3)" }]);
    expect((await answerOf(q["1"])).correct_options).toEqual(["c"]);
    expect(nums(await answerOf(q["2"]))).toEqual([3, 3]);
    expect((await entry(key.ids["1"])).parse_flags).toEqual(["digit_option"]);
  });

  it("resolves a several-options conflict once the question is changed to MSQ", async () => {
    const w = await world();
    const q = await saveQuestions(w, w.s1, [{ number: "31", type: "mcq" }]);
    const key = await saveKey(w, [{ number: "31", raw: "(a; c)" }]);
    expect((await entry(key.ids["31"])).conflict_reason).toBe("multiple_options_on_mcq");

    await db.query(`update questions set type = 'msq' where id = $1`, [q["31"]]);
    await match(w.chapter);
    expect(await entry(key.ids["31"])).toMatchObject({ status: "matched" });
    expect((await answerOf(q["31"])).correct_options).toEqual(["a", "c"]);
  });

  it("flags the same number twice in one section on one page and matches neither", async () => {
    const w = await world();
    const q = await saveQuestions(w, w.s1, [{ number: "5", type: "mcq" }]);
    const page = await one(
      `insert into pages (chapter_id, kind, status, original_path) values ($1, 'answer_key', 'needs_review', 'k.jpg') returning id`,
      [w.chapter],
    );
    const mk = (raw: string) => ({ id: crypto.randomUUID(), kind: "short", number: "5", section_id: w.s1, raw_text: raw, correct_options: parseAnswer(raw).options, parse_flags: [] });
    const a = mk("(a)");
    const b = mk("(b)");
    await db.query(`select * from save_answer_key_page($1, $2)`, [page.id, JSON.stringify([a, b])]);

    expect(await entry(a.id)).toMatchObject({ status: "conflict", conflict_reason: "duplicate_number" });
    expect(await entry(b.id)).toMatchObject({ status: "conflict", conflict_reason: "duplicate_number" });
    expect(await answerOf(q["5"])).toBeUndefined();
  });

  it("does not treat a short and a worked entry with the same number as duplicates; together they make one answer", async () => {
    const w = await world();
    const q = await saveQuestions(w, w.s1, [{ number: "12", type: "mcq" }]);
    const key = await saveKey(w, [
      { number: "12", raw: "(a)" },
      { number: "12", kind: "worked", image: `${w.user}/keys/p/12.jpg`, text: "a[0][2] = 8 …" },
    ]);
    expect(await entry(key.ids["12"])).toMatchObject({ status: "matched" });
    expect(await entry(key.ids["12w"])).toMatchObject({ status: "matched" });
    expect(await answerOf(q["12"])).toMatchObject({
      correct_options: ["a"],
      answer_image_path: `${w.user}/keys/p/12.jpg`,
      answer_text: "a[0][2] = 8 …",
      source_page_id: key.page,
    });
  });

  it("matches entries from two sections on one page to their own section's questions", async () => {
    const w = await world();
    const q1 = await saveQuestions(w, w.s1, [{ number: "1", type: "mcq" }]);
    const q2 = await saveQuestions(w, w.s2, [{ number: "1", type: "mcq" }]);
    await saveKey(w, [
      { number: "1", raw: "(a)", section: w.s1 },
      { number: "1", raw: "(b)", section: w.s2 },
    ]);
    expect((await answerOf(q1["1"])).correct_options).toEqual(["a"]);
    expect((await answerOf(q2["1"])).correct_options).toEqual(["b"]);
  });

  it("leaves entries with no section unmatched", async () => {
    const w = await world();
    await saveQuestions(w, w.s1, [{ number: "1", type: "mcq" }]);
    const key = await saveKey(w, [{ number: "1", raw: "(a)", section: null }]);
    expect(await entry(key.ids["1"])).toMatchObject({ status: "unmatched", question_id: null });
  });

  it("keeps a kept_mine decision across re-matching, and can undo it", async () => {
    const w = await world();
    const q = await saveQuestions(w, w.s1, [{ number: "1", type: "mcq" }]);
    await db.query(`insert into answers (question_id, correct_options) values ($1, '{b}')`, [q["1"]]);
    const key = await saveKey(w, [{ number: "1", raw: "(d)" }]);

    await db.query(`update answer_key_entries set status = 'kept_mine' where id = $1`, [key.ids["1"]]);
    await match(w.chapter);
    await match(w.chapter);
    expect(await entry(key.ids["1"])).toMatchObject({ status: "kept_mine", conflict_reason: "differs_from_your_answer" });
    expect((await answerOf(q["1"])).correct_options).toEqual(["b"]);

    await db.query(`update answer_key_entries set status = 'unmatched', conflict_reason = null where id = $1`, [key.ids["1"]]);
    await match(w.chapter);
    expect(await entry(key.ids["1"])).toMatchObject({ status: "conflict", conflict_reason: "differs_from_your_answer" });
  });

  it("leaves ignored entries alone", async () => {
    const w = await world();
    const q = await saveQuestions(w, w.s1, [{ number: "1", type: "mcq" }]);
    const key = await saveKey(w, [{ number: "1", raw: "(a)", ignored: true }]);
    await match(w.chapter);
    expect(await entry(key.ids["1"])).toMatchObject({ status: "ignored", question_id: null });
    expect(await answerOf(q["1"])).toBeUndefined();
  });

  it("replaces the current answer only on the explicit apply_answer_key_entry choice", async () => {
    const w = await world();
    const q = await saveQuestions(w, w.s1, [{ number: "1", type: "mcq" }]);
    await db.query(`insert into answers (question_id, correct_options) values ($1, '{b}')`, [q["1"]]);
    const key = await saveKey(w, [{ number: "1", raw: "(d)" }]);
    expect((await answerOf(q["1"])).correct_options).toEqual(["b"]);

    await db.query(`select apply_answer_key_entry($1)`, [key.ids["1"]]);
    expect(await answerOf(q["1"])).toMatchObject({ correct_options: ["d"], source_page_id: key.page });
    expect(await entry(key.ids["1"])).toMatchObject({ status: "matched" });
  });

  it("reports a conflict when two key pages disagree", async () => {
    const w = await world();
    const q = await saveQuestions(w, w.s1, [{ number: "1", type: "mcq" }]);
    const k1 = await saveKey(w, [{ number: "1", raw: "(a)" }]);
    const k2 = await saveKey(w, [{ number: "1", raw: "(b)" }]);
    expect(await entry(k1.ids["1"])).toMatchObject({ status: "conflict", conflict_reason: "key_pages_disagree" });
    expect(await entry(k2.ids["1"])).toMatchObject({ status: "conflict", conflict_reason: "key_pages_disagree" });
    // The first page's answer stays; nothing new is written while they disagree.
    expect(await answerOf(q["1"])).toMatchObject({ correct_options: ["a"], source_page_id: k1.page });
  });
});

describe("stale key answers (renumbering and retyping)", () => {
  it("renumbering a question removes its old key answer and matches the new number", async () => {
    const w = await world();
    const q = await saveQuestions(w, w.s1, [{ number: "58", type: "mcq" }]);
    const key = await saveKey(w, [{ number: "58", raw: "(a)" }, { number: "60", raw: "(b)" }]);
    expect((await answerOf(q["58"])).correct_options).toEqual(["a"]);

    await db.query(`update questions set number = '60' where id = $1`, [q["58"]]);
    await match(w.chapter);
    expect(await answerOf(q["58"])).toMatchObject({ correct_options: ["b"], source_page_id: key.page });
    expect(await entry(key.ids["58"])).toMatchObject({ status: "unmatched", question_id: null });
    expect(await entry(key.ids["60"])).toMatchObject({ status: "matched", question_id: q["58"] });
  });

  it("renumbering to a number the key doesn't have deletes the stale key answer", async () => {
    const w = await world();
    const q = await saveQuestions(w, w.s1, [{ number: "58", type: "mcq" }]);
    await saveKey(w, [{ number: "58", raw: "(a)" }]);
    await db.query(`update questions set number = '99' where id = $1`, [q["58"]]);
    await match(w.chapter);
    expect(await answerOf(q["58"])).toBeUndefined();
  });

  it("never deletes a key answer that was edited by hand", async () => {
    const w = await world();
    const q = await saveQuestions(w, w.s1, [{ number: "58", type: "mcq" }]);
    await saveKey(w, [{ number: "58", raw: "(a)" }]);
    // What AnswerEditor does on a hand save: the answer becomes the user's.
    await db.query(`update answers set correct_options = '{c}', source_page_id = null where question_id = $1`, [q["58"]]);
    await db.query(`update questions set number = '99' where id = $1`, [q["58"]]);
    await match(w.chapter);
    expect(await answerOf(q["58"])).toMatchObject({ correct_options: ["c"], source_page_id: null });
  });

  it("retyping MCQ → numerical re-reads a digit key answer as a number", async () => {
    const w = await world();
    const q = await saveQuestions(w, w.s1, [{ number: "7", type: "mcq" }]);
    const key = await saveKey(w, [{ number: "7", raw: "(3)" }]);
    expect((await answerOf(q["7"])).correct_options).toEqual(["c"]);

    await db.query(`update questions set type = 'numerical' where id = $1`, [q["7"]]);
    await match(w.chapter);
    const a = await answerOf(q["7"]);
    expect(a.correct_options).toBeNull();
    expect(nums(a)).toEqual([3, 3]);
    expect(a.source_page_id).toBe(key.page);
  });

  it("retyping to a type the key can't answer deletes the key answer and reports why", async () => {
    const w = await world();
    const q = await saveQuestions(w, w.s1, [{ number: "8", type: "mcq" }]);
    const key = await saveKey(w, [{ number: "8", raw: "(c)" }]);
    await db.query(`update questions set type = 'numerical' where id = $1`, [q["8"]]);
    await match(w.chapter);
    expect(await answerOf(q["8"])).toBeUndefined();
    expect(await entry(key.ids["8"])).toMatchObject({ status: "conflict", conflict_reason: "option_on_numerical" });
  });

  it("retyping keeps a worked solution's image and text when the short answer no longer fits", async () => {
    const w = await world();
    const q = await saveQuestions(w, w.s1, [{ number: "9", type: "mcq" }]);
    await saveKey(w, [
      { number: "9", raw: "(c)" },
      { number: "9", kind: "worked", image: `${w.user}/keys/p/9.jpg`, text: "Working" },
    ]);
    await db.query(`update questions set type = 'numerical' where id = $1`, [q["9"]]);
    await match(w.chapter);
    expect(await answerOf(q["9"])).toMatchObject({ correct_options: null, numeric_min: null, answer_image_path: `${w.user}/keys/p/9.jpg`, answer_text: "Working" });
  });
});

describe("idempotence and the insert-conflict path", () => {
  async function snapshot(chapter: string) {
    const entries = await rows(
      `select id, status, question_id, conflict_reason, section_id, number from answer_key_entries where chapter_id = $1 order by id`,
      [chapter],
    );
    const answers = await rows(
      `select a.id, a.question_id, a.correct_options, a.numeric_min, a.numeric_max, a.answer_text, a.answer_image_path, a.source_page_id
         from answers a join questions q on q.id = a.question_id join sections s on s.id = q.section_id
        where s.chapter_id = $1 order by a.id`,
      [chapter],
    );
    return { entries, answers };
  }

  it("running matching twice in a row changes nothing the second time", async () => {
    const w = await world();
    const q = await saveQuestions(w, w.s1, [
      { number: "1", type: "mcq" },
      { number: "2", type: "numerical" },
      { number: "3", type: "mcq" },
      { number: "4", type: "mcq" },
    ]);
    await db.query(`insert into answers (question_id, correct_options) values ($1, '{b}')`, [q["3"]]);
    const key = await saveKey(w, [
      { number: "1", raw: "(d)" },
      { number: "1", kind: "worked", image: `${w.user}/keys/p/1.jpg`, text: "…" },
      { number: "2", raw: "4.4 to 4.6" },
      { number: "3", raw: "(a)" }, // conflicts with the hand answer
      { number: "4", raw: "(a, b)" }, // several options on an MCQ
      { number: "77", raw: "(c)" }, // no question
    ]);
    await db.query(`update answer_key_entries set status = 'kept_mine' where id = $1`, [key.ids["3"]]);

    await match(w.chapter);
    const first = await snapshot(w.chapter);
    const counts = await match(w.chapter);
    const second = await snapshot(w.chapter);

    expect(second).toEqual(first);
    expect(counts).toEqual({ matched: 3, conflicts: 1, unmatched: 1 });
  });

  it("an answer already exists when matching inserts one: the insert does nothing and the save succeeds", async () => {
    const w = await world();
    const q = await saveQuestions(w, w.s1, [
      { number: "1", type: "mcq" },
      { number: "2", type: "mcq" },
    ]);
    await db.query(`insert into answers (question_id, correct_options) values ($1, '{a}'), ($2, '{b}')`, [q["1"], q["2"]]);

    // Both answers exist before the key's insert runs; neither may raise a unique violation.
    const key = await saveKey(w, [{ number: "1", raw: "(a)" }, { number: "2", raw: "(c)" }]);

    expect((await one(`select status from pages where id = $1`, [key.page])).status).toBe("saved");
    expect(await entry(key.ids["1"])).toMatchObject({ status: "matched" });
    expect(await entry(key.ids["2"])).toMatchObject({ status: "conflict", conflict_reason: "differs_from_your_answer" });
    expect((await one(`select count(*)::int as n from answers where question_id in ($1, $2)`, [q["1"], q["2"]])).n).toBe(2);
  });

  it("a key page and a question page saved one after the other into the same chapter both succeed", async () => {
    const w = await world();
    const key = await saveKey(w, [{ number: "1", raw: "(b)" }]);
    const q = await saveQuestions(w, w.s1, [{ number: "1", type: "mcq" }]);
    expect((await one(`select status from pages where id = $1`, [key.page])).status).toBe("saved");
    expect((await answerOf(q["1"])).correct_options).toEqual(["b"]);
  });

  it("refuses to save a key page twice", async () => {
    const w = await world();
    const key = await saveKey(w, [{ number: "1", raw: "(b)" }]);
    await expect(db.query(`select * from save_answer_key_page($1, '[]')`, [key.page])).rejects.toThrow(/page_already_saved/);
  });
});

describe("deleting", () => {
  it("deleting a key page removes its unedited answers, keeps hand-edited ones, and returns unused images", async () => {
    const w = await world();
    const q = await saveQuestions(w, w.s1, [
      { number: "1", type: "mcq" },
      { number: "2", type: "mcq" },
    ]);
    const img1 = `${w.user}/keys/p/1.jpg`;
    const img2 = `${w.user}/keys/p/2.jpg`;
    const key = await saveKey(w, [
      { number: "1", raw: "(d)" },
      { number: "1", kind: "worked", image: img1, text: "one" },
      { number: "2", raw: "(a)" },
      { number: "2", kind: "worked", image: img2, text: "two" },
    ]);
    // Q2's answer is then edited by hand (it keeps the solution image).
    await db.query(`update answers set correct_options = '{c}', source_page_id = null where question_id = $1`, [q["2"]]);

    const removed = (await one(`select delete_answer_key_page($1) as paths`, [key.page])).paths;

    expect(await answerOf(q["1"])).toBeUndefined();
    expect(await answerOf(q["2"])).toMatchObject({ correct_options: ["c"], answer_image_path: img2, source_page_id: null });
    expect(removed).toEqual([img1]);
    expect(await rows(`select id from answer_key_entries where page_id = $1`, [key.page])).toEqual([]);
    expect(await rows(`select id from pages where id = $1`, [key.page])).toEqual([]);
  });

  it("after deleting a key page, another key page fills the gap", async () => {
    const w = await world();
    const q = await saveQuestions(w, w.s1, [{ number: "1", type: "mcq" }]);
    const k1 = await saveKey(w, [{ number: "1", raw: "(d)" }]);
    const k2 = await saveKey(w, [{ number: "1", raw: "(d)" }]);
    expect((await answerOf(q["1"])).source_page_id).toBe(k1.page);

    await db.query(`select delete_answer_key_page($1)`, [k1.page]);
    expect(await answerOf(q["1"])).toMatchObject({ correct_options: ["d"], source_page_id: k2.page });
  });

  it("deleting a question frees its entry, which re-matching marks unmatched", async () => {
    const w = await world();
    const q = await saveQuestions(w, w.s1, [{ number: "1", type: "mcq" }]);
    const key = await saveKey(w, [{ number: "1", raw: "(d)" }]);
    await db.query(`delete from questions where id = $1`, [q["1"]]);
    await match(w.chapter);
    expect(await entry(key.ids["1"])).toMatchObject({ status: "unmatched", question_id: null });
  });

  it("deleting a section keeps its entries, with no section", async () => {
    const w = await world();
    await saveQuestions(w, w.s2, [{ number: "1", type: "mcq" }]);
    const key = await saveKey(w, [{ number: "1", raw: "(d)", section: w.s2 }]);
    await db.query(`delete from sections where id = $1`, [w.s2]);
    await match(w.chapter);
    expect(await entry(key.ids["1"])).toMatchObject({ status: "unmatched", section_id: null, question_id: null });
  });
});

describe("row-level security", () => {
  it("another user can't see, change, match or save someone else's answer-key data", async () => {
    const a = await world();
    const q = await saveQuestions(a, a.s1, [{ number: "1", type: "mcq" }]);
    const key = await saveKey(a, [{ number: "1", raw: "(d)" }]);
    const page = await one(
      `insert into pages (chapter_id, kind, status, original_path) values ($1, 'answer_key', 'needs_review', 'k.jpg') returning id`,
      [a.chapter],
    );

    const b = crypto.randomUUID();
    await actAs(db, b);
    expect(await rows(`select * from answer_key_entries`)).toEqual([]);
    expect(await rows(`update answer_key_entries set status = 'ignored' where id = $1 returning id`, [key.ids["1"]])).toEqual([]);
    expect(await match(a.chapter)).toEqual({ matched: 0, conflicts: 0, unmatched: 0 });
    await expect(db.query(`select * from save_answer_key_page($1, '[]')`, [page.id])).rejects.toThrow(/page_not_found/);
    await expect(
      db.query(
        `insert into answer_key_entries (page_id, chapter_id, number, kind) values ($1, $2, '1', 'short')`,
        [key.page, a.chapter],
      ),
    ).rejects.toThrow();

    await actAs(db, a.user);
    expect(await entry(key.ids["1"])).toMatchObject({ status: "matched" });
    expect((await answerOf(q["1"])).correct_options).toEqual(["d"]);
  });
});
