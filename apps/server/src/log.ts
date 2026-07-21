function detailsText(details?: Record<string, unknown>) {
  return details && Object.keys(details).length ? ` ${JSON.stringify(details)}` : '';
}

export function logRequest(status: number, method: string, url: string, elapsedMs: number) {
  console.log(`[${status}] ${method} ${url} ${Math.round(elapsedMs)}ms`);
}

export function logWarn(message: string, details?: Record<string, unknown>) {
  console.warn(`[warn] ${message}${detailsText(details)}`);
}

export function logError(message: string, details?: Record<string, unknown>) {
  console.error(`[error] ${message}${detailsText(details)}`);
}
