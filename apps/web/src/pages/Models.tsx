import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Model, type ProviderConnection } from '../api';
import { formatTokens, latestErrorMessage } from '../format';

type ModelUsage = {
  upstreamModelId: string;
  requestCount: string;
  inputTokens: string;
  outputTokens: string;
  cacheInputTokens: string;
};

export function Models() {
  const qc = useQueryClient();
  const [viewMode, setViewMode] = useState<'detail' | 'list'>('detail');
  const [filterConnection, setFilterConnection] = useState('');
  const [testingId, setTestingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; message: string } | null>(null);

  const models = useQuery({ queryKey: ['models'], queryFn: () => api<Model[]>('/api/models') });
  const connections = useQuery({
    queryKey: ['connections'],
    queryFn: () => api<ProviderConnection[]>('/api/connections'),
  });
  const usage = useQuery({
    queryKey: ['models', 'usage'],
    queryFn: () => api<ModelUsage[]>('/api/models/usage'),
    refetchInterval: 10_000,
  });
  const usageByModel = new Map(usage.data?.map((item) => [item.upstreamModelId, item]));

  const testModel = useMutation({
    mutationFn: (id: string) => api<{ message: string }>(`/api/models/${id}/test`, { method: 'POST' }),
    onMutate: (id) => {
      setTestingId(id);
      setNotice(null);
    },
    onSuccess: (result) => {
      setNotice({ tone: 'success', message: result.message });
      qc.invalidateQueries({ queryKey: ['models'] });
    },
    onError: (error) => setNotice({ tone: 'error', message: error.message }),
    onSettled: () => setTestingId(null),
  });

  const toggleModel = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api(`/api/models/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['models'] }),
  });

  const filtered = (models.data ?? []).filter(
    (m) => !filterConnection || m.providerConnectionId === filterConnection,
  );
  const byConnection = new Map<string, Model[]>();
  for (const m of filtered) {
    const list = byConnection.get(m.providerConnectionId) ?? [];
    list.push(m);
    byConnection.set(m.providerConnectionId, list);
  }
  const connectionName = (id: string) =>
    connections.data?.find((c) => c.id === id)?.displayName ?? '—';

  return (
    <>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Models</h1>
          <p className="muted mt-1">
            One row per (model, token) instance — test individually, or use Connections to add
            bindings/tokens.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <select
            aria-label="Filter by connection"
            className="input w-44 shrink-0"
            value={filterConnection}
            onChange={(e) => setFilterConnection(e.target.value)}
          >
            <option value="">All connections</option>
            {connections.data?.map((c) => (
              <option value={c.id} key={c.id}>
                {c.displayName}
              </option>
            ))}
          </select>
          <div className="flex shrink-0 overflow-hidden rounded-lg border border-zinc-800">
            <button
              className={`px-3 py-2 text-sm ${viewMode === 'detail' ? 'bg-zinc-800' : 'text-zinc-400 hover:text-white'}`}
              onClick={() => setViewMode('detail')}
            >
              Detail
            </button>
            <button
              className={`px-3 py-2 text-sm ${viewMode === 'list' ? 'bg-zinc-800' : 'text-zinc-400 hover:text-white'}`}
              onClick={() => setViewMode('list')}
            >
              List
            </button>
          </div>
        </div>
      </div>

      {viewMode === 'detail' ? (
        <div className="grid gap-4">
          {[...byConnection.entries()].map(([connectionId, list]) => (
            <section className="card" key={connectionId}>
              <h2 className="mb-3 text-lg font-semibold">{connectionName(connectionId)}</h2>
              <div className="rounded-lg border border-zinc-800 bg-zinc-950">
                {list.map((m) => (
                  <ModelRow
                    key={m.id}
                    model={m}
                    usage={usageByModel.get(m.upstreamModelId)}
                    testing={testingId === m.id}
                    onTest={() => testModel.mutate(m.id)}
                    onToggle={() => toggleModel.mutate({ id: m.id, enabled: !m.enabled })}
                  />
                ))}
              </div>
            </section>
          ))}
          {byConnection.size === 0 && (
            <div className="card text-center text-zinc-400">
              No model instances yet — bind a preset to a connection first.
            </div>
          )}
        </div>
      ) : (
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-zinc-800 text-left text-xs text-zinc-500">
              <tr>
                <th className="px-4 py-2.5 font-medium">Model</th>
                <th className="px-4 py-2.5 font-medium">Connection</th>
                <th className="px-4 py-2.5 font-medium">Token</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium">Requests</th>
                <th className="px-4 py-2.5 font-medium">Tokens</th>
                <th className="px-4 py-2.5 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((m) => {
                const u = usageByModel.get(m.upstreamModelId);
                return (
                  <tr
                    className={`border-b border-zinc-800/60 last:border-b-0 ${!m.enabled ? 'opacity-60' : ''}`}
                    key={m.id}
                  >
                    <td className="max-w-[16rem] truncate px-4 py-2.5">{m.displayName}</td>
                    <td className="px-4 py-2.5 text-zinc-400">{m.providerConnectionName}</td>
                    <td className="px-4 py-2.5 text-zinc-400">{m.tokenName ?? '—'}</td>
                    <td className="px-4 py-2.5">
                      <StatusBadge model={m} />
                    </td>
                    <td className="px-4 py-2.5 text-zinc-400">
                      {u ? Number(u.requestCount).toLocaleString() : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-zinc-400">
                      {u ? formatTokens(Number(u.inputTokens) + Number(u.outputTokens)) : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <button
                        className="btn h-7 px-2.5 text-xs"
                        disabled={testingId === m.id}
                        onClick={() => testModel.mutate(m.id)}
                      >
                        {testingId === m.id ? 'Testing…' : 'Test'}
                      </button>
                    </td>
                  </tr>
                );
              })}
              {filtered.length === 0 && (
                <tr>
                  <td className="px-4 py-6 text-center text-zinc-500" colSpan={7}>
                    No model instances yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {notice && (
        <div
          className={`fixed top-5 left-1/2 z-50 w-[min(30rem,calc(100%-2rem))] -translate-x-1/2 animate-[toast-drop_220ms_ease-out] rounded-xl border px-4 py-3 shadow-xl ${notice.tone === 'success' ? 'border-emerald-700 bg-emerald-950 text-emerald-100' : 'border-red-700 bg-red-950 text-red-100'}`}
          role="status"
        >
          <div className="flex items-center justify-between gap-3">
            <span>{notice.message}</span>
            <button
              className="text-lg leading-none opacity-70 hover:opacity-100"
              onClick={() => setNotice(null)}
              aria-label="Dismiss notification"
            >
              x
            </button>
          </div>
        </div>
      )}
    </>
  );
}

function StatusBadge({ model }: { model: Model }) {
  const cooling = !!model.tokenCooldownUntil && new Date(model.tokenCooldownUntil) > new Date();
  if (model.tokenEnabled === false)
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-red-400">
        <span className="h-2 w-2 rounded-full bg-red-400" /> Token disabled
      </span>
    );
  if (cooling)
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-amber-400">
        <span className="h-2 w-2 rounded-full bg-amber-400" /> Token cooling down
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-zinc-400">
      <span
        className={`h-2 w-2 rounded-full ${model.latestTestStatus === 'healthy' ? 'bg-emerald-400' : model.latestTestStatus === 'failed' ? 'bg-red-400' : 'bg-zinc-600'}`}
      />
      {model.latestTestStatus === 'healthy' ? 'Healthy' : model.latestTestStatus === 'failed' ? 'Failed' : '—'}
    </span>
  );
}

function ModelRow({
  model,
  usage,
  testing,
  onTest,
  onToggle,
}: {
  model: Model;
  usage?: ModelUsage;
  testing: boolean;
  onTest: () => void;
  onToggle: () => void;
}) {
  const errorMessage = model.latestTestStatus === 'failed' ? latestErrorMessage(model.latestError) : undefined;
  return (
    <div
      className={`flex items-center gap-3 border-b border-zinc-800/60 px-4 py-2.5 last:border-b-0 ${!model.enabled ? 'opacity-60' : ''}`}
    >
      <button
        aria-checked={model.enabled}
        aria-label={`${model.enabled ? 'Disable' : 'Enable'} ${model.displayName}`}
        className={`relative h-4 w-7 shrink-0 rounded-full transition-colors focus:outline-none ${model.enabled ? 'bg-emerald-500/80' : 'bg-zinc-700'}`}
        onClick={onToggle}
        role="switch"
        title={model.enabled ? 'Enabled — click to disable' : 'Disabled — click to enable'}
        type="button"
      >
        <span
          className={`absolute top-0.5 left-0.5 h-3 w-3 rounded-full bg-zinc-100 shadow-sm transition-transform ${model.enabled ? 'translate-x-3' : 'translate-x-0'}`}
        />
      </button>
      <div className="min-w-0 flex-1">
        <span className="block truncate text-sm">{model.displayName}</span>
        {errorMessage && <span className="block truncate text-xs text-red-400">{errorMessage}</span>}
      </div>
      {usage && (
        <span className="hidden shrink-0 text-xs text-zinc-500 sm:block">
          {Number(usage.requestCount).toLocaleString()} req ·{' '}
          {formatTokens(Number(usage.inputTokens) + Number(usage.outputTokens))} tok
        </span>
      )}
      <StatusBadge model={model} />
      <button className="btn h-7 px-2.5 text-xs" disabled={testing} onClick={onTest}>
        {testing ? 'Testing…' : 'Test'}
      </button>
    </div>
  );
}
