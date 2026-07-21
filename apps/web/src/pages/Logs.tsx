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
  apiFormat?: string;
  status: number;
  latencyMs: number;
  timeToFirstTokenMs?: number;
  inputTokens?: number;
  outputTokens?: number;
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
export function Logs() {
  const [selectedError, setSelectedError] = useState<Log | null>(null);
  const [cursorHistory, setCursorHistory] = useState<string[]>([]);
  const [filters, setFilters] = useState({
    requestId: '',
    model: '',
    status: '',
    from: '',
    to: '',
  });
  const search = new URLSearchParams(
    Object.entries(filters).filter(([, value]) => value) as Array<[string, string]>,
  );
  const cursor = cursorHistory.at(-1);
  if (cursor) search.set('cursor', cursor);
  const logs = useQuery({
    queryKey: ['logs', filters, cursor],
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
      <div className="card mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <input
          aria-label="Filter by request ID"
          className="input"
          placeholder="Request ID"
          value={filters.requestId}
          onChange={(event) => {
            setFilters({ ...filters, requestId: event.target.value });
            setCursorHistory([]);
          }}
        />
        <input
          aria-label="Filter by model"
          className="input"
          placeholder="Model"
          value={filters.model}
          onChange={(event) => {
            setFilters({ ...filters, model: event.target.value });
            setCursorHistory([]);
          }}
        />
        <select
          aria-label="Filter by status"
          className="input"
          value={filters.status}
          onChange={(event) => {
            setFilters({ ...filters, status: event.target.value });
            setCursorHistory([]);
          }}
        >
          <option value="">All statuses</option>
          <option value="200">200</option>
          <option value="400">400</option>
          <option value="401">401</option>
          <option value="429">429</option>
          <option value="500">500</option>
          <option value="502">502</option>
        </select>
        <input
          aria-label="Requests from"
          className="input"
          type="datetime-local"
          value={filters.from}
          onChange={(event) => {
            setFilters({ ...filters, from: event.target.value });
            setCursorHistory([]);
          }}
        />
        <input
          aria-label="Requests to"
          className="input"
          type="datetime-local"
          value={filters.to}
          onChange={(event) => {
            setFilters({ ...filters, to: event.target.value });
            setCursorHistory([]);
          }}
        />
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
                'Tokens',
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
                  <span className="text-zinc-500">{l.resolvedUpstreamModel ?? '—'}</span>
                </td>
                <td className="p-3">{l.apiFormat === 'anthropic_compatible' ? 'Anthropic' : l.apiFormat === 'openai_compatible' ? 'OpenAI' : '—'}</td>
                <td className="p-3">{l.status}</td>
                <td className="p-3">{l.latencyMs}ms</td>
                <td className="p-3">
                  {formatTokens(l.inputTokens)} / {formatTokens(l.outputTokens)}
                </td>
                <td className="p-3">
                  {l.thinkingConfig ? (
                    <button
                      className="cursor-pointer text-zinc-300 underline decoration-zinc-600 underline-offset-4 hover:text-zinc-100"
                      onClick={() => setSelectedError(l)}
                      title={JSON.stringify(l.thinkingConfig)}
                      type="button"
                    >
                      {String(l.thinkingConfig.effort ?? l.thinkingConfig.type ?? 'configured')}
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
              {JSON.stringify(
                selectedError.providerError ?? selectedError.thinkingConfig,
                null,
                2,
              )}
            </pre>
          </section>
        </div>
      )}
    </>
  );
}
