"use client";

import { BookOpen, CircleCheck, Star } from "lucide-react";
import Link from "next/link";
import { TYPE_SHORT, type QuestionOverview } from "@/lib/types";

export function QuestionCard({
  q,
  thumbUrl,
  onToggle,
}: {
  q: QuestionOverview;
  thumbUrl?: string;
  onToggle: (field: "is_starred" | "is_theory") => void;
}) {
  return (
    <article className="card overflow-hidden">
      <Link href={`/library/question/${q.question_id}`} className="block bg-white">
        {thumbUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={thumbUrl} alt={`Question ${q.number}`} loading="lazy" className="max-h-56 w-full object-contain object-top" />
        ) : (
          <div className="h-24 animate-pulse bg-sunken" />
        )}
      </Link>
      <div className="flex items-center gap-2 border-t border-line px-3 py-1.5">
        <Link href={`/library/question/${q.question_id}`} className="flex min-w-0 flex-1 items-center gap-2 py-2">
          <span className="qnum">{q.number}</span>
          <span className="text-sm text-muted">{TYPE_SHORT[q.type]}</span>
          {q.has_answer && (
            <span className="inline-flex items-center gap-1 text-sm text-ok">
              <CircleCheck size={16} aria-hidden /> Answer
            </span>
          )}
          {q.last_verdict === "wrong" && <span className="text-sm text-bad">Last: wrong</span>}
        </Link>
        <button
          type="button"
          className="btn-icon"
          aria-label={q.is_theory ? "Remove theory tag" : "Tag as theory"}
          aria-pressed={q.is_theory}
          onClick={() => onToggle("is_theory")}
        >
          <BookOpen size={22} className={q.is_theory ? "text-accent" : ""} fill={q.is_theory ? "currentColor" : "none"} />
        </button>
        <button
          type="button"
          className="btn-icon"
          aria-label={q.is_starred ? "Unstar" : "Star"}
          aria-pressed={q.is_starred}
          onClick={() => onToggle("is_starred")}
        >
          <Star size={22} className={q.is_starred ? "text-mark" : ""} fill={q.is_starred ? "currentColor" : "none"} />
        </button>
      </div>
    </article>
  );
}
