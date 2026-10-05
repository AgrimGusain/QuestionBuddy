"use client";

import { BookOpen, Star, Trash2 } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AnswerEditor } from "@/components/AnswerEditor";
import { ShareButtons } from "@/components/ShareButtons";
import { ErrorNote, Loading } from "@/components/Status";
import { TopBar } from "@/components/TopBar";
import { useSignedUrls } from "@/components/useSignedUrls";
import { deleteWithFiles } from "@/lib/delete";
import { loadHierarchy, pathLabel, type Hierarchy } from "@/lib/hierarchy";
import { supabase } from "@/lib/supabase/client";
import { TYPE_LABEL, type Answer, type Question, type QuestionType } from "@/lib/types";

export default function QuestionPage() {
  const { questionId } = useParams<{ questionId: string }>();
  const router = useRouter();
  const [q, setQ] = useState<Question | null>(null);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [h, setH] = useState<Hierarchy | null>(null);
  const [number, setNumber] = useState("");
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const db = supabase();
    Promise.all([
      db.from("questions").select("*").eq("id", questionId).maybeSingle(),
      db.from("answers").select("*").eq("question_id", questionId).maybeSingle(),
      loadHierarchy(),
    ])
      .then(([qr, ar, hier]) => {
        if (qr.error) throw new Error(qr.error.message);
        if (ar.error) throw new Error(ar.error.message);
        const question = qr.data as Question | null;
        setQ(question);
        setAnswer(ar.data as Answer | null);
        setH(hier);
        setNumber(question?.number ?? "");
        setText(question?.ocr_text ?? "");
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoaded(true));
  }, [questionId]);

  const urls = useSignedUrls("crops", q?.image_paths ?? []);
  const orderedUrls = (q?.image_paths ?? []).map((p) => urls[p]).filter(Boolean);

  async function update(patch: Partial<Question>) {
    if (!q) return false;
    const before = q;
    setQ({ ...q, ...patch });
    const { error } = await supabase().from("questions").update(patch).eq("id", q.id);
    if (error) {
      setQ(before);
      setError(error.code === "23505" ? `Question ${patch.number} already exists in this section.` : error.message);
      return false;
    }
    setError(null);
    return true;
  }

  const section = h && q ? h.sections.find((s) => s.id === q.section_id) : undefined;
  const chapter = h && section ? h.chapters.find((c) => c.id === section.chapter_id) : undefined;
  const back = chapter ? `/library/${chapter.subject_id}/${chapter.id}` : "/library";

  if (!loaded) return <Loading />;
  if (!q) {
    return (
      <>
        <TopBar title="Question" back="/library" />
        <main className="px-4 py-4">
          <ErrorNote>{error ?? "This question no longer exists."}</ErrorNote>
        </main>
      </>
    );
  }

  return (
    <>
      <TopBar
        title={<span className="qnum">{q.number}</span>}
        subtitle={h && chapter ? pathLabel(h, chapter.id, q.section_id) : undefined}
        back={back}
      />
      <main className="space-y-6 px-4 py-4">
        <section className="card overflow-hidden bg-white">
          {q.image_paths.map((p, i) =>
            urls[p] ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={p} src={urls[p]} alt={`Question ${q.number}, part ${i + 1}`} className="block w-full" />
            ) : (
              <div key={p} className="h-40 animate-pulse bg-sunken" />
            ),
          )}
        </section>

        <ShareButtons urls={orderedUrls.length === q.image_paths.length ? orderedUrls : []} number={q.number} text={q.ocr_text} />

        <div className="flex gap-2">
          <button type="button" className="chip" aria-pressed={q.is_starred} onClick={() => update({ is_starred: !q.is_starred })}>
            <Star size={16} fill={q.is_starred ? "currentColor" : "none"} aria-hidden /> Starred
          </button>
          <button type="button" className="chip" aria-pressed={q.is_theory} onClick={() => update({ is_theory: !q.is_theory })}>
            <BookOpen size={16} fill={q.is_theory ? "currentColor" : "none"} aria-hidden /> Theory
          </button>
        </div>

        {error && <ErrorNote>{error}</ErrorNote>}

        <section className="space-y-3">
          <h2 className="font-bold">Details</h2>
          <div className="flex items-center gap-3">
            <label htmlFor="q-number" className="w-20 shrink-0 text-sm text-muted">
              Number
            </label>
            <input
              id="q-number"
              className="field"
              value={number}
              onChange={(e) => setNumber(e.target.value)}
              onBlur={async () => {
                const n = number.trim();
                if (!n) return setNumber(q.number);
                if (n !== q.number && !(await update({ number: n }))) setNumber(q.number);
              }}
            />
          </div>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Question type">
            {(Object.keys(TYPE_LABEL) as QuestionType[]).map((t) => (
              <button key={t} type="button" role="radio" aria-checked={q.type === t} className="chip" onClick={() => update(t === "theory" && q.type !== "theory" ? { type: t, is_theory: true } : { type: t })}>
                {TYPE_LABEL[t]}
              </button>
            ))}
          </div>
          <label htmlFor="q-text" className="block text-sm text-muted">
            Question text, used for search and Copy text
          </label>
          <textarea
            id="q-text"
            rows={3}
            className="field py-3"
            placeholder="Type the key words of the question"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={() => text !== q.ocr_text && update({ ocr_text: text })}
          />
        </section>

        <section className="space-y-3">
          <h2 className="font-bold">Answer</h2>
          <AnswerEditor key={q.type} questionId={q.id} type={q.type} answer={answer} onSaved={setAnswer} />
        </section>

        <button
          type="button"
          className="btn-danger w-full"
          onClick={async () => {
            if (!window.confirm(`Delete question ${q.number}? Its answer and practice history go too.`)) return;
            try {
              await deleteWithFiles({ questionId: q.id });
              router.replace(back);
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          <Trash2 size={18} aria-hidden /> Delete question
        </button>
      </main>
    </>
  );
}
