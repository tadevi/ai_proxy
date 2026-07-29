import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';

function formatTokens(tokens?: number) {
  if (tokens === undefined || tokens === null) return '—';
  const [suffix, divisor]: [string, number] =
    tokens >= 1_000_000_000
      ? ['B', 1_000_000_000]
      : tokens >= 1_000_000
        ? ['M', 1_000_000]
        : ['K', 1_000];
  const value = tokens / divisor;
  return `${Number(value.toFixed(value >= 10 ? 1 : 2))}${suffix}`;
}

type Log = {
  id: string;
  createdAt: string;
  requestId: string;
  incomingModel: string;
  resolvedUpstreamModel?: string;
  cliproxyAccountLabel?: string | null;
  cliproxyAccountPrefix?: string | null;
  apiFormat?: string;
  status: number;
  latencyMs: number;
  timeToFirstTokenMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheInputTokens?: number;
  fallbackCount: number;
  errorCategory?: string;
  providerError?: Record<string, unknown>;
  thinkingConfig?: Record<string, unknown> | null;
};
type LogPage = {
  items: Log[];
  pageSize: number;
  total: number;
  nextCursor: string | null;
};

function formatLatencySeconds(milliseconds: number) {
  return `${(milliseconds / 1_000).toFixed(1)}s`;
}

function formatThinking(config?: Record<string, unknown> | null) {
  if (!config) return '—';
  if (typeof config.effort === 'string')
    return config.effort.charAt(0).toUpperCase() + config.effort.slice(1);
  if (typeof config.budgetTokens === 'number') return `Budget ${formatTokens(config.budgetTokens)}`;
  if (config.enabled === false || config.type === 'disabled') return 'Disabled';
  if (config.type === 'adaptive') return 'Adaptive';
  if (config.enabled === true || config.type === 'enabled') return 'Enabled';
  return 'Configured';
}

function resolvedModelLabel(value?: string) {
  return value?.replace(/\s+\([^()]+\s+@\s+[^()]+\)$/, '') ?? '—';
}

function resolvedModelDetails(value?: string) {
  return value?.match(/\s+\(([^()]+\s+@\s+[^()]+)\)$/)?.[1];
}

function tokenMetrics(log: Log) {
  const input = log.inputTokens ?? 0;
  const cache = log.cacheInputTokens ?? 0;
  const isAnthropic = log.apiFormat === 'anthropic_compatible';
  return {
    totalInput: isAnthropic ? input + cache : input,
    nonCacheInput: isAnthropic ? input : Math.max(0, input - cache),
    cacheInput: cache,
  };
}

function tokenTooltip(log: Log) {
  const metrics = tokenMetrics(log);
  return [
    `Total input: ${formatTokens(metrics.totalInput)}`,
    `Non-cache: ${formatTokens(metrics.nonCacheInput)}`,
    `Cache: ${formatTokens(metrics.cacheInput)}`,
    `Output: ${formatTokens(log.outputTokens)}`,
  ].join('\n');
}

export function Logs() {
  const [selectedError, setSelectedError] = useState<Log | null>(null);
  const [cursorHistory, setCursorHistory] = useState<string[]>([]);
  const cursor = cursorHistory.at(-1);
  const search = new URLSearchParams(cursor ? { cursor } : undefined);
  const logs = useQuery({
    queryKey: ['logs', cursor],
    queryFn: () => api<LogPage>(`/api/logs?${search}`),
    refetchInterval: 10000,
  });
  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">Request logs</h1>
        <p className="muted mt-1">
          Request bodies are never stored; sanitized provider error details may be retained.
        </p>
      </div>
      <div className="card overflow-x-auto p-0">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-zinc-800 text-zinc-400">
            <tr>
              {[
                'Time',
                'Request ID',
                'Model → resolved',
                'Format',
                'Status',
                'Latency',
                'Tokens (in/out)',
                'Thinking',
                'Fallbacks',
                'Error',
              ].map((x) => (
                <th className="whitespace-nowrap p-3" key={x}>
                  {x}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {logs.data?.items.map((l) => (
              <tr className="border-b border-zinc-800/60" key={l.id}>
                <td className="whitespace-nowrap p-3">{new Date(l.createdAt).toLocaleString()}</td>
                <td className="p-3 font-mono text-xs">{l.requestId}</td>
                <td className="p-3">
                  {l.incomingModel}
                  <br />
                  <span
                    className="text-zinc-500"
                    title={
                      l.cliproxyAccountLabel || l.cliproxyAccountPrefix
                        ? (l.cliproxyAccountLabel ?? l.cliproxyAccountPrefix ?? undefined)
                        : resolvedModelDetails(l.resolvedUpstreamModel)
                    }
                  >
                    {resolvedModelLabel(l.resolvedUpstreamModel)}
                    {(l.cliproxyAccountLabel || l.cliproxyAccountPrefix) && (
                      <span className="ml-1 text-zinc-600">
                        · {l.cliproxyAccountLabel ?? l.cliproxyAccountPrefix}
                      </span>
                    )}
                  </span>
                </td>
                <td className="p-3">
                  {l.apiFormat === 'anthropic_compatible'
                    ? 'Anthropic'
                    : l.apiFormat === 'openai_compatible'
                      ? 'OpenAI'
                      : '—'}
                </td>
                <td className="p-3">{l.status}</td>
                <td className="p-3">{formatLatencySeconds(l.latencyMs)}</td>
                <td className="p-3" title={tokenTooltip(l)}>
                  {formatTokens(tokenMetrics(l).totalInput)} / {formatTokens(l.outputTokens)}
                </td>
                <td className="p-3">
                  {l.thinkingConfig ? (
                    <button
                      className="cursor-pointer text-zinc-300 underline decoration-zinc-600 underline-offset-4 hover:text-zinc-100"
                      onClick={() => setSelectedError(l)}
                      title={JSON.stringify(l.thinkingConfig)}
                      type="button"
                    >
                      {formatThinking(l.thinkingConfig)}
                    </button>
                  ) : (
                    <span className="text-zinc-600">—</span>
                  )}
                </td>
                <td className="p-3">{l.fallbackCount}</td>
                <td className="p-3 text-red-300">
                  {l.providerError ? (
                    <button
                      className="cursor-pointer underline decoration-red-400/50 underline-offset-4 hover:text-red-200"
                      onClick={() => setSelectedError(l)}
                      title="View error details"
                      type="button"
                    >
                      {l.errorCategory ?? 'upstream_error'}
                    </button>
                  ) : (
                    (l.errorCategory ?? '—')
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {logs.data?.items.length === 0 && (
          <p className="p-8 text-center text-zinc-400">No gateway requests yet.</p>
        )}
      </div>
      <div className="mt-4 flex items-center justify-between gap-3 text-sm text-zinc-400">
        <span>
          {logs.data
            ? `Showing ${logs.data.total ? cursorHistory.length * logs.data.pageSize + 1 : 0}–${Math.min(
                (cursorHistory.length + 1) * logs.data.pageSize,
                logs.data.total,
              )} of ${logs.data.total}`
            : 'Loading logs…'}
        </span>
        <div className="flex items-center gap-2">
          <button
            className="btn"
            disabled={cursorHistory.length === 0}
            onClick={() => setCursorHistory((history) => history.slice(0, -1))}
            type="button"
          >
            Previous
          </button>
          <span className="whitespace-nowrap">
            Page {cursorHistory.length + 1} /{' '}
            {logs.data ? Math.max(1, Math.ceil(logs.data.total / logs.data.pageSize)) : '…'}
          </span>
          <button
            className="btn"
            disabled={!logs.data?.nextCursor}
            onClick={() => {
              if (logs.data?.nextCursor)
                setCursorHistory((history) => [...history, logs.data.nextCursor!]);
            }}
            type="button"
          >
            Next
          </button>
        </div>
      </div>
      {selectedError && (selectedError.providerError || selectedError.thinkingConfig) && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setSelectedError(null);
          }}
          role="presentation"
        >
          <section
            aria-labelledby="detail-title"
            aria-modal="true"
            className="card w-full max-w-2xl"
            role="dialog"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-medium" id="detail-title">
                  {selectedError.providerError
                    ? `Error details · ${selectedError.errorCategory ?? 'unknown_error'}`
                    : 'Thinking config'}
                </h2>
                <p className="muted mt-1">Request {selectedError.requestId}</p>
              </div>
              <button
                aria-label="Close details"
                className="btn"
                onClick={() => setSelectedError(null)}
                type="button"
              >
                Close
              </button>
            </div>
            <pre className="mt-4 max-h-[60vh] overflow-auto rounded-lg bg-zinc-950 p-4 text-xs text-zinc-200">
              {JSON.stringify(selectedError.providerError ?? selectedError.thinkingConfig, null, 2)}
            </pre>
          </section>
        </div>
      )}
    </>
  );
}
