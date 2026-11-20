// Label helpers for metrics. Kept out of observability.ts so the many tests
// that mock that module don't each have to re-implement a pure function.
//
// LABEL RULE (see observability.ts): no URL, domain, query text or error
// message in any metric label.
/**
 * A bounded `error_type` label for an error: its class name when that is a
 * plain identifier, else "unknown". Never the message (see LABEL RULE above).
 * An error may name its own label with a `metricErrorType` property, for a
 * failure whose class alone ("Error") says nothing.
 */
export function errorTypeLabel(err: unknown): string {
  if (err instanceof Error) {
    const own = (err as { metricErrorType?: unknown }).metricErrorType;
    if (typeof own === "string" && /^[a-z][a-z0-9_]{0,39}$/.test(own)) {
      return own;
    }
    if (/^[A-Za-z][A-Za-z0-9]{0,39}$/.test(err.name)) return err.name;
  }
  return "unknown";
}
