"use client";

import { useEffect } from "react";
import { startQueueRunner } from "@/lib/queue/runner";

/** Drives the AI segmentation queue while the app is open. Renders nothing. */
export function QueueRunner() {
  useEffect(() => startQueueRunner(), []);
  return null;
}
