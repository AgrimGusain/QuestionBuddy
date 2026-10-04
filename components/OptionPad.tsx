"use client";

import { OPTION_LETTERS } from "@/lib/types";

/** Big a–e buttons. Single choice for MCQ, multiple for MSQ. */
export function OptionPad({
  value,
  onChange,
  multiple,
  disabled,
  correct,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  multiple: boolean;
  disabled?: boolean;
  correct?: string[]; // highlight after checking
}) {
  return (
    <div role={multiple ? "group" : "radiogroup"} className="grid grid-cols-5 gap-2">
      {OPTION_LETTERS.map((o) => {
        const on = value.includes(o);
        const isCorrect = correct?.includes(o);
        let tone = on ? "border-accent bg-accent text-on-accent" : "border-line bg-surface text-ink";
        if (correct) {
          if (isCorrect) tone = "border-ok bg-ok text-white";
          else if (on) tone = "border-bad bg-bad text-white";
        }
        return (
          <button
            key={o}
            type="button"
            role={multiple ? "checkbox" : "radio"}
            aria-checked={on}
            disabled={disabled}
            onClick={() =>
              onChange(multiple ? (on ? value.filter((x) => x !== o) : [...value, o].sort()) : [o])
            }
            className={`aspect-square rounded-2xl border-2 text-2xl font-bold transition-colors ${tone} ${
              o === "e" && !on && !isCorrect ? "opacity-60" : ""
            }`}
          >
            {o}
          </button>
        );
      })}
    </div>
  );
}
