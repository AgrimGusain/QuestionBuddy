import { SourceSelector } from "@/components/SourceSelector";
import { TopBar } from "@/components/TopBar";

export default function TheoryPage() {
  return (
    <>
      <TopBar title="Theory revision" subtitle="Questions you tagged as theory" />
      <main className="space-y-4 px-4 py-4">
        <p className="text-sm text-muted">
          Write your answer, reveal the model answer and mark yourself. AI grading arrives in Phase 4.
        </p>
        <SourceSelector mode="theory" />
      </main>
    </>
  );
}
