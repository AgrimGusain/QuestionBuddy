const SNAP_KEY = "sqb:snap-display";

/**
 * Whether the review screen starts from the snapped boxes (default) or the
 * model's raw boxes. Per-device display preference only: the server always
 * computes and stores both, so this never changes what gets saved.
 */
export function getSnapDisplay(): boolean {
  try {
    return localStorage.getItem(SNAP_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setSnapDisplay(on: boolean): void {
  try {
    localStorage.setItem(SNAP_KEY, on ? "on" : "off");
  } catch {
    // Storage unavailable: the default (on) applies.
  }
}
