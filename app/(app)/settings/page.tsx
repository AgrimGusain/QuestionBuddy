import { connection } from "next/server";
import { SettingsClient } from "@/components/SettingsClient";
import { layoutModelName, readModelName } from "@/lib/ai";

// Server component: the model env vars are server-only (no NEXT_PUBLIC_), so
// they reach the browser only as these rendered strings, read per request.
export default async function SettingsPage() {
  await connection();
  return <SettingsClient layoutModel={layoutModelName()} readModel={readModelName()} />;
}
