import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { currentUserId, maybeSingle } = vi.hoisted(() => ({
  currentUserId: vi.fn(),
  maybeSingle: vi.fn(),
}));

vi.mock("@/lib/supabase/client", () => {
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: () => builder,
    or: () => builder,
    order: () => builder,
    limit: () => builder,
    maybeSingle,
  };
  return { currentUserId, supabase: () => ({ from: () => builder }) };
});

import { startQueueRunner, wakeQueueRunner } from "./runner";

describe("queue runner", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    currentUserId.mockReset().mockResolvedValue("user-1");
    maybeSingle.mockReset();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}")));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("mounting twice issues one request per candidate, not two", async () => {
    maybeSingle.mockResolvedValueOnce({ data: { id: "p1" } }).mockResolvedValue({ data: null });
    const stop1 = startQueueRunner();
    const stop2 = startQueueRunner();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    stop1();
    stop2();
  });

  it("stops polling once every caller has unmounted", async () => {
    maybeSingle.mockResolvedValue({ data: null });
    const stop = startQueueRunner();
    await vi.advanceTimersByTimeAsync(0); // first tick: nothing to do, schedules an idle poll
    stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("backs off instead of hot-looping when the segment route errors", async () => {
    maybeSingle.mockResolvedValue({ data: { id: "p1" } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 500 })));
    const stop = startQueueRunner();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    stop();
  });

  it("wakeQueueRunner checks immediately instead of waiting for the idle poll", async () => {
    maybeSingle.mockResolvedValue({ data: null });
    const stop = startQueueRunner();
    await vi.advanceTimersByTimeAsync(0); // first tick: nothing to do
    maybeSingle.mockReset().mockResolvedValueOnce({ data: { id: "p2" } }).mockResolvedValue({ data: null });
    wakeQueueRunner();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    stop();
  });
});
