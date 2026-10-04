import { SourceSelector } from "@/components/SourceSelector";
import { TopBar } from "@/components/TopBar";

export default function PracticePage() {
  return (
    <>
      <TopBar title="Practice" />
      <main className="px-4 py-4">
        <SourceSelector mode="practice" />
      </main>
    </>
  );
}
