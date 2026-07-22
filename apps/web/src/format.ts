export function latestErrorMessage(error?: Record<string, unknown> | null) {
  if (!error) return undefined;
  const response = error.response;
  if (response && typeof response === 'object' && !Array.isArray(response)) {
    const message = (response as Record<string, unknown>).message;
    if (typeof message === 'string') return message;
    const nested = (response as Record<string, unknown>).error;
    if (
      nested &&
      typeof nested === 'object' &&
      typeof (nested as Record<string, unknown>).message === 'string'
    )
      return (nested as Record<string, unknown>).message as string;
  }
  if (typeof error.responseText === 'string') {
    const match = error.responseText.match(/data:(.+)/);
    if (match?.[1]) {
      try {
        const message = (JSON.parse(match[1]) as { message?: unknown }).message;
        if (typeof message === 'string') return message;
      } catch {
        // Use the raw text below when an SSE error cannot be parsed.
      }
    }
    return error.responseText;
  }
  return typeof error.message === 'string' ? error.message : 'An upstream error was recorded.';
}

export function formatTokens(value: string | number) {
  const tokens = Number(value);
  if (!Number.isFinite(tokens)) return '—';
  const [suffix, divisor]: [string, number] =
    tokens >= 1_000_000_000
      ? ['B', 1_000_000_000]
      : tokens >= 1_000_000
        ? ['M', 1_000_000]
        : ['K', 1_000];
  const scaled = tokens / divisor;
  return `${Number(scaled.toFixed(scaled >= 10 ? 1 : 2))}${suffix}`;
}
