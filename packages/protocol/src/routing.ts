export function isFallbackableStatus(status: number) {
  return [429, 500, 502, 503, 504].includes(status);
}
