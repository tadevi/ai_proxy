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
        <div className="grid gap-6">
          {[...byConnection.entries()].map(([connectionId, list]) => (
            <section key={connectionId}>
              <h2 className="mb-3 text-lg font-semibold">{connectionName(connectionId)}</h2>
              <div className="grid gap-4">
                {list.map((m) => (
                  <ModelCard
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
                <th className="px-4 py-2.5 font-medium">Format</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium text-right">Tokens (in/out)</th>
                <th className="px-4 py-2.5 font-medium text-right">Cache</th>
                <th className="px-4 py-2.5 font-medium text-right">Requests</th>
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
                    <td className="max-w-[16rem] truncate px-4 py-2.5">
                      <div className="truncate font-medium">{m.displayName}</div>
                      <div className="truncate font-mono text-[11px] text-zinc-500">
                        {m.upstreamModelId}
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-zinc-400">{m.providerConnectionName}</td>
                    <td className="px-4 py-2.5 text-zinc-400">{m.tokenName ?? '—'}</td>
                    <td className="px-4 py-2.5">
                      <FormatChip apiFormat={m.apiFormat} />
                    </td>
                    <td className="px-4 py-2.5">
                      <StatusBadge model={m} />
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-xs text-zinc-400">
                      {u ? `${formatTokens(u.inputTokens)} / ${formatTokens(u.outputTokens)}` : '— / —'}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-xs text-zinc-400">
                      {u ? formatTokens(u.cacheInputTokens) : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-right text-zinc-400">
                      {u ? Number(u.requestCount).toLocaleString() : 0}
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
                  <td className="px-4 py-6 text-center text-zinc-500" colSpan={9}>
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

function FormatChip({ apiFormat }: { apiFormat: string }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${apiFormat === 'anthropic_compatible' ? 'bg-indigo-950 text-indigo-300' : 'bg-sky-950 text-sky-300'}`}
    >
      {apiFormat === 'anthropic_compatible' ? 'Anthropic' : 'OpenAI'}
    </span>
  );
}

// Read-only reflection of the token's own state — change it from Connections → Tokens.
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

function ModelCard({
  model: m,
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
  const cooling = !!m.tokenCooldownUntil && new Date(m.tokenCooldownUntil) > new Date();
  return (
    <div className="card overflow-hidden p-0">
      <div className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex flex-wrap items-baseline gap-2">
            <h3 className="font-mono text-lg font-medium">{m.displayName}</h3>
            <span className="font-mono text-[13px] text-zinc-500">{m.upstreamModelId}</span>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <button
              aria-checked={m.enabled}
              aria-label={`${m.enabled ? 'Disable' : 'Enable'} ${m.displayName}`}
              className={`relative h-5 w-9 shrink-0 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-900 ${m.enabled ? 'bg-emerald-500/80' : 'bg-zinc-700'}`}
              onClick={onToggle}
              role="switch"
              title={m.enabled ? 'Enabled — click to disable' : 'Disabled — click to enable'}
              type="button"
            >
              <span
                className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-zinc-100 shadow-sm transition-transform ${m.enabled ? 'translate-x-4' : 'translate-x-0'}`}
              />
            </button>
            <button className="btn h-8 px-3.5 text-[13px]" disabled={testing} onClick={onTest}>
              {testing ? 'Testing…' : 'Test'}
            </button>
          </div>
        </div>

        <div className="mt-1.5 flex flex-wrap items-center gap-2.5 text-[13px]">
          <span className="text-zinc-400">{m.providerConnectionName}</span>
          {m.tokenName && (
            <>
              <span className="text-zinc-600">·</span>
              <span className="text-zinc-400">{m.tokenName}</span>
            </>
          )}
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          <span
            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${m.enabled ? 'bg-emerald-950 text-emerald-400' : 'bg-zinc-800 text-zinc-400'}`}
          >
            {m.enabled && (
              <span className="relative inline-block h-1.5 w-1.5 rounded-full bg-emerald-400">
                <span className="absolute -inset-1 rounded-full border border-emerald-400 opacity-50 animate-[pulse-ring_2s_ease-out_infinite]" />
              </span>
            )}
            {m.enabled ? 'Enabled' : 'Disabled'}
          </span>
          {m.latestTestStatus && (
            <span
              className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${m.latestTestStatus === 'healthy' ? 'bg-emerald-950 text-emerald-400' : 'bg-red-950 text-red-400'}`}
            >
              {m.latestTestStatus === 'healthy' ? 'Healthy' : 'Unhealthy'}
            </span>
          )}
          {m.tokenEnabled === false && (
            <span className="rounded-full bg-red-950 px-2.5 py-0.5 text-xs font-medium text-red-400">
              Token disabled
            </span>
          )}
          {cooling && (
            <span className="rounded-full bg-amber-950 px-2.5 py-0.5 text-xs font-medium text-amber-400">
              Token cooling down until {new Date(m.tokenCooldownUntil!).toLocaleTimeString()}
            </span>
          )}
          <FormatChip apiFormat={m.apiFormat} />
          {m.supportsReasoning === 'yes' && (
            <span className="rounded-full border border-zinc-700 px-2.5 py-0.5 text-xs text-zinc-400">
              Reasoning
            </span>
          )}
          {m.supportsImages === 'yes' && (
            <span className="rounded-full border border-zinc-700 px-2.5 py-0.5 text-xs text-zinc-400">
              Images
            </span>
          )}
        </div>
      </div>
      <div className="grid border-t border-zinc-800 sm:grid-cols-4">
        <div className="border-b border-zinc-800 px-6 py-4 sm:border-r sm:border-b-0">
          <p className="text-xs text-zinc-500">Input tokens</p>
          <p className="mt-1 text-[22px] font-medium">
            {usage ? formatTokens(usage.inputTokens) : '—'}
          </p>
        </div>
        <div className="border-b border-zinc-800 px-6 py-4 sm:border-r sm:border-b-0">
          <p className="text-xs text-zinc-500">Output tokens</p>
          <p className="mt-1 text-[22px] font-medium">
            {usage ? formatTokens(usage.outputTokens) : '—'}
          </p>
        </div>
        <div className="border-b border-zinc-800 px-6 py-4 sm:border-r sm:border-b-0">
          <p className="text-xs text-zinc-500">Cache tokens</p>
          <p className="mt-1 text-[22px] font-medium">
            {usage ? formatTokens(usage.cacheInputTokens) : '—'}
          </p>
        </div>
        <div className="px-6 py-4">
          <p className="text-xs text-zinc-500">Requests</p>
          <p className="mt-1 text-[22px] font-medium">
            {usage ? Number(usage.requestCount).toLocaleString() : 0}
          </p>
        </div>
      </div>
      {m.latestError && (
        <details className="border-t border-red-950 bg-red-950/20 px-5 py-3 text-sm text-red-200">
          <summary className="cursor-pointer list-none">
            <div className="flex min-w-0 items-center gap-2">
              <span className="shrink-0 font-medium">Last error</span>
              {m.latestErrorAt && (
                <span className="shrink-0 text-xs text-red-300/70">
                  {new Date(m.latestErrorAt).toLocaleString()}
                </span>
              )}
              <span className="truncate text-red-200/90">{latestErrorMessage(m.latestError)}</span>
            </div>
          </summary>
          <pre className="mt-3 max-h-48 overflow-auto rounded-lg bg-zinc-950 p-3 text-xs text-red-100">
            {JSON.stringify(m.latestError, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}
