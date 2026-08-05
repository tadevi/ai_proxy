export function extractCacheInputTokens(
  usage: Record<string, unknown> | undefined,
): number | undefined {
  const cacheCreation = usage?.cache_creation_input_tokens;
  const cacheRead = usage?.cache_read_input_tokens;
  const reported = typeof cacheCreation === 'number' || typeof cacheRead === 'number';
  if (!reported) return undefined;
  return (
    (typeof cacheCreation === 'number' ? cacheCreation : 0) +
    (typeof cacheRead === 'number' ? cacheRead : 0)
  );
}
