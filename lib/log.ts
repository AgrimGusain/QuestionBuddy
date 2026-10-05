/** Structured server-side logging: one JSON line per event. */
export function log(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...fields }));
}
