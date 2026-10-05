import { currentUserId, supabase } from "@/lib/supabase/client";

const POLL_IDLE_MS = 20_000;
const POLL_BUSY_MS = 250;
const POLL_SIGNED_OUT_MS = 30_000;
const POLL_FAILURE_MAX_MS = 60_000;

let consecutiveFailures = 0;
let refCount = 0;
let active = false;
let pollTimer: ReturnType<typeof setTimeout> | null = null;

function schedule(ms: number) {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(tick, ms);
}

async function tick(): Promise<void> {
  if (refCount === 0) return; // every consumer unmounted while this was scheduled
  if (active) return;

  const userId = await currentUserId().catch(() => null);
  if (!userId) {
    schedule(POLL_SIGNED_OUT_MS);
    return;
  }

  const nowIso = new Date().toISOString();
  const staleIso = new Date(Date.now() - 3 * 60_000).toISOString();
  const { data: candidate } = await supabase()
    .from("pages")
    .select("id")
    .or(
      `status.eq.queued,` +
        `and(status.eq.rate_limited,retry_after.is.null),` +
        `and(status.eq.rate_limited,retry_after.lte.${nowIso}),` +
        `and(status.eq.processing,updated_at.lt.${staleIso})`,
    )
    .order("created_at")
    .limit(1)
    .maybeSingle();

  if (!candidate) {
    schedule(POLL_IDLE_MS);
    return;
  }

  active = true;
  let ok = false;
  try {
    const res = await fetch(`/api/pages/${candidate.id}/segment`, { method: "POST" });
    ok = res.ok || res.status === 409; // 409: another request already claimed it
  } catch {
    // Network hiccup: the page stays queued/processing and will be retried.
  } finally {
    active = false;
  }
  // A failure before the server claims the page (e.g. misconfigured env) leaves
  // it queued, so retrying at POLL_BUSY_MS would hammer the route. Back off.
  consecutiveFailures = ok ? 0 : consecutiveFailures + 1;
  schedule(ok ? POLL_BUSY_MS : Math.min(POLL_FAILURE_MAX_MS, POLL_BUSY_MS * 2 ** (consecutiveFailures + 2)));
}

/** Mount once per app shell; safe to call from multiple components. */
export function startQueueRunner(): () => void {
  refCount++;
  if (refCount === 1) void tick();
  return () => {
    refCount--;
    if (refCount === 0 && pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  };
}

/** Call right after queuing a page (or retrying a failed one) to skip the idle wait. */
export function wakeQueueRunner(): void {
  if (refCount === 0) return;
  schedule(0);
}
