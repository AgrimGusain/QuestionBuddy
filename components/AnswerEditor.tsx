"use client";

import { useEffect, useState } from "react";
import { numericRange, TOLERANCE_PCT } from "@/lib/grading";
import { supabase } from "@/lib/supabase/client";
import type { Answer, QuestionType } from "@/lib/types";
import { OptionPad } from "./OptionPad";
import { ErrorNote } from "./Status";

/** Enter or edit the stored answer for one question. */
export function AnswerEditor({
  questionId,
  type,
  answer,
  onSaved,
}: {
  questionId: string;
  type: QuestionType;
  answer: Answer | null;
  onSaved: (a: Answer | null) => void;
}) {
  const range = answer ? numericRange(answer) : null;
  const [options, setOptions] = useState<string[]>(answer?.correct_options ?? []);
  const [isRange, setIsRange] = useState(!!range && range[0] !== range[1]);
  const [min, setMin] = useState(range ? String(range[0]) : "");
  const [max, setMax] = useState(range ? String(range[1]) : "");
  const [text, setText] = useState(answer?.answer_text ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => setSaved(false), [options, isRange, min, max, text, type]);

  async function save() {
    setError(null);
    const row: Record<string, unknown> = {
      question_id: questionId,
      answer_text: text.trim() || null,
      correct_options: null,
      numeric_min: null,
      numeric_max: null,
    };
    if (type === "mcq" || type === "msq") {
      if (type === "mcq" && options.length !== 1) return setError("Pick the one correct option.");
      if (type === "msq" && options.length < 1) return setError("Pick at least one correct option.");
      row.correct_options = options;
    }
    if (type === "numerical") {
      const lo = Number(min.replace(",", "."));
      const hi = isRange ? Number(max.replace(",", ".")) : lo;
      if (min.trim() === "" || !Number.isFinite(lo) || !Number.isFinite(hi)) return setError("Enter a number.");
      if (lo > hi) return setError("The lower value must not be above the upper value.");
      row.numeric_min = lo;
      row.numeric_max = hi;
    }
    const hasSomething = row.answer_text || row.correct_options || row.numeric_min !== null || answer?.answer_image_path;
    setBusy(true);
    const db = supabase();
    const res = hasSomething
      ? await db.from("answers").upsert(row, { onConflict: "question_id" }).select("*").single()
      : await db.from("answers").delete().eq("question_id", questionId);
    setBusy(false);
    if (res.error) return setError(res.error.message);
    setSaved(true);
    onSaved(hasSomething ? (res.data as Answer) : null);
  }

  return (
    <div className="space-y-4">
      {(type === "mcq" || type === "msq") && (
        <div className="space-y-2">
          <p className="text-sm text-muted">{type === "mcq" ? "Correct option" : "All correct options"}</p>
          <OptionPad value={options} onChange={setOptions} multiple={type === "msq"} />
        </div>
      )}

      {type === "numerical" && (
        <div className="space-y-2">
          <div className="flex gap-2" role="radiogroup" aria-label="Answer kind">
            <button type="button" role="radio" aria-checked={!isRange} className="chip" onClick={() => setIsRange(false)}>
              Single value
            </button>
            <button type="button" role="radio" aria-checked={isRange} className="chip" onClick={() => setIsRange(true)}>
              Range
            </button>
          </div>
          <div className="flex items-center gap-2">
            <input
              className="field"
              inputMode="decimal"
              aria-label={isRange ? "Lowest accepted value" : "Answer"}
              placeholder={isRange ? "From" : "e.g. 9.8"}
              value={min}
              onChange={(e) => setMin(e.target.value)}
            />
            {isRange && (
              <>
                <span className="text-muted">to</span>
                <input
                  className="field"
                  inputMode="decimal"
                  aria-label="Highest accepted value"
                  placeholder="To"
                  value={max}
                  onChange={(e) => setMax(e.target.value)}
                />
              </>
            )}
          </div>
          {!isRange && <p className="text-sm text-muted">Answers within ±{TOLERANCE_PCT}% are accepted.</p>}
        </div>
      )}

      <div className="space-y-2">
        <label htmlFor="answer-text" className="block text-sm text-muted">
          {type === "theory" ? "Model answer" : "Solution notes (optional)"}
        </label>
        <textarea
          id="answer-text"
          rows={type === "theory" ? 6 : 3}
          className="field py-3"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}
      <button type="button" className="btn-primary w-full" onClick={save} disabled={busy}>
        {busy ? "Saving…" : saved ? "Answer saved" : "Save answer"}
      </button>
    </div>
  );
}
