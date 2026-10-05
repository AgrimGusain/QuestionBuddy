"use client";

import { useEffect, useState } from "react";
import { ErrorNote } from "@/components/Status";
import { TopBar } from "@/components/TopBar";
import { getSnapDisplay, setSnapDisplay } from "@/lib/settings";

type TestState = { kind: "idle" } | { kind: "testing" } | { kind: "ok"; latencyMs: number } | { kind: "error"; message: string };

export function SettingsClient({ layoutModel, readModel }: { layoutModel: string; readModel: string }) {
  const [snap, setSnap] = useState(true);
  const [test, setTest] = useState<TestState>({ kind: "idle" });

  useEffect(() => setSnap(getSnapDisplay()), []);

  async function testConnection() {
    setTest({ kind: "testing" });
    const res = await fetch("/api/groq/test", { method: "POST" }).catch(() => null);
    const body = res ? await res.json().catch(() => ({})) : {};
    if (res?.ok && body.ok) setTest({ kind: "ok", latencyMs: body.latencyMs });
    else setTest({ kind: "error", message: body.error ?? (res ? `HTTP ${res.status}` : "No connection") });
  }

  return (
    <>
      <TopBar title="Settings" back="/" />
      <main className="space-y-6 px-4 py-4">
        <section className="card space-y-3 p-4">
          <h2 className="font-bold">Question finding and reading</h2>
          <div>
            <span className="block text-sm font-bold text-muted">Finds questions (Gemini)</span>
            <code className="break-all text-sm">{layoutModel}</code>
            <p className="text-xs text-muted">Set with GEMINI_LAYOUT_MODEL on the server.</p>
          </div>
          <div>
            <span className="block text-sm font-bold text-muted">Reads text (Groq)</span>
            <code className="break-all text-sm">{readModel}</code>
            <p className="text-xs text-muted">Set with GROQ_VISION_MODEL on the server.</p>
          </div>
          <button type="button" className="btn-secondary w-full" onClick={testConnection} disabled={test.kind === "testing"}>
            {test.kind === "testing" ? "Testing…" : "Test Groq connection"}
          </button>
          {test.kind === "ok" && <p className="text-sm text-ok">Connected ({test.latencyMs} ms).</p>}
          {test.kind === "error" && <ErrorNote>Couldn&apos;t reach Groq: {test.message}</ErrorNote>}
        </section>

        <section className="card space-y-2 p-4">
          <label className="flex min-h-10 items-center gap-3">
            <input
              type="checkbox"
              className="size-5 accent-[var(--accent)]"
              checked={snap}
              onChange={(e) => {
                setSnap(e.target.checked);
                setSnapDisplay(e.target.checked);
              }}
            />
            <span className="font-bold">Snap boxes to clean edges</span>
          </label>
          <p className="text-sm text-muted">
            When on, pages you open for review start from boxes tidied to the whitespace between questions. When off, they start
            from the model&apos;s boxes as it returned them. Both are always kept; this only changes which one you start from, on this
            phone.
          </p>
        </section>
      </main>
    </>
  );
}
