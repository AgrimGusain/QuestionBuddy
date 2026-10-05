import { BottomNav } from "@/components/BottomNav";
import { QueueRunner } from "@/components/QueueRunner";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <div className="mx-auto max-w-xl" style={{ paddingBottom: "calc(5.5rem + env(safe-area-inset-bottom, 0px))" }}>
        {children}
      </div>
      <BottomNav />
      <QueueRunner />
    </>
  );
}
