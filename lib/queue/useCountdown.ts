"use client";

import { useEffect, useState } from "react";

/** Milliseconds remaining until `target` (an ISO timestamp), ticking every second. Null if there's no target or it has passed. */
export function useCountdown(target: string | null): number | null {
  const [ms, setMs] = useState<number | null>(() => remaining(target));

  useEffect(() => {
    setMs(remaining(target));
    if (!target) return;
    const id = setInterval(() => setMs(remaining(target)), 1000);
    return () => clearInterval(id);
  }, [target]);

  return ms;
}

function remaining(target: string | null): number | null {
  if (!target) return null;
  const ms = new Date(target).getTime() - Date.now();
  return ms > 0 ? ms : null;
}
