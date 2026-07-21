import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
type Log = {
  id: string;
  createdAt: string;
  requestId: string;
  incomingModel: string;
  resolvedGatewayModel?: string;
  apiFormat?: string;
  status: number;
  latencyMs: number;
  timeToFirstTokenMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  fallbackCount: number;
  errorCategory?: string;
};
export function Logs() {
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
  const logs = useQuery({
    queryKey: ['logs', filters],
    queryFn: () => api<Log[]>(`/api/logs${search.size ? `?${search}` : ''}`),
    refetchInterval: 10000,
  });
  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">Request logs</h1>
        <p className="muted mt-1">Metadata only; prompts and responses are never stored.</p>
      </div>
      <div className="card mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <input
          aria-label="Filter by request ID"
          className="input"
          placeholder="Request ID"
          value={filters.requestId}
          onChange={(event) => setFilters({ ...filters, requestId: event.target.value })}
        />
        <input
          aria-label="Filter by model"
          className="input"
          placeholder="Model"
          value={filters.model}
          onChange={(event) => setFilters({ ...filters, model: event.target.value })}
        />
        <select
          aria-label="Filter by status"
          className="input"
          value={filters.status}
          onChange={(event) => setFilters({ ...filters, status: event.target.value })}
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
          onChange={(event) => setFilters({ ...filters, from: event.target.value })}
        />
        <input
          aria-label="Requests to"
          className="input"
          type="datetime-local"
          value={filters.to}
          onChange={(event) => setFilters({ ...filters, to: event.target.value })}
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
                'Latency / TTFT',
                'Tokens',
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
            {logs.data?.map((l) => (
              <tr className="border-b border-zinc-800/60" key={l.id}>
                <td className="whitespace-nowrap p-3">{new Date(l.createdAt).toLocaleString()}</td>
                <td className="p-3 font-mono text-xs">{l.requestId}</td>
                <td className="p-3">
                  {l.incomingModel}
                  <br />
                  <span className="text-zinc-500">{l.resolvedGatewayModel ?? '—'}</span>
                </td>
                <td className="p-3">{l.apiFormat?.replace('_', ' ') ?? '—'}</td>
                <td className="p-3">{l.status}</td>
                <td className="p-3">
                  {l.latencyMs}ms / {l.timeToFirstTokenMs ?? '—'}
                </td>
                <td className="p-3">
                  {l.inputTokens ?? '—'} / {l.outputTokens ?? '—'}
                </td>
                <td className="p-3">{l.fallbackCount}</td>
                <td className="p-3 text-red-300">{l.errorCategory ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {logs.data?.length === 0 && (
          <p className="p-8 text-center text-zinc-400">No gateway requests yet.</p>
        )}
      </div>
    </>
  );
}
