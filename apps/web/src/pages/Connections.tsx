import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type ProviderConnection, type ConnectionToken, type ModelBinding, type Preset } from '../api';
import { latestErrorMessage } from '../format';

type ConnectionForm = {
  displayName: string;
  baseUrl: string;
  enabled: boolean;
};

const connectionDefaults: ConnectionForm = {
  displayName: '',
  baseUrl: '',
  enabled: true,
};

type TokenForm = {
  name: string;
  apiKey: string;
};

const tokenDefaults: TokenForm = {
  name: '',
  apiKey: '',
};

export function Connections() {
  const qc = useQueryClient();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showAddToken, setShowAddToken] = useState<string | null>(null);
  const [showBindPreset, setShowBindPreset] = useState<string | null>(null);
  const [editing, setEditing] = useState<ProviderConnection | null>(null);
  const [showForm, setShowForm] = useState(false);

  const connections = useQuery({
    queryKey: ['connections'],
    queryFn: () => api<ProviderConnection[]>('/api/connections'),
  });

  const tokens = useQuery({
    queryKey: ['tokens', expandedId],
    queryFn: () => api<ConnectionToken[]>(`/api/connections/${expandedId}/tokens`),
    enabled: !!expandedId,
  });

  const bindings = useQuery({
    queryKey: ['bindings', expandedId],
    queryFn: () => api<ModelBinding[]>(`/api/connections/${expandedId}/bindings`),
    enabled: !!expandedId,
  });

  const presets = useQuery({
    queryKey: ['presets'],
    queryFn: () => api<Preset[]>('/api/presets'),
  });

  const saveConnection = useMutation({
    mutationFn: (form: ConnectionForm) =>
      api(`/api/connections${editing ? `/${editing.id}` : ''}`, {
        method: editing ? 'PATCH' : 'POST',
        body: JSON.stringify(form),
      }),
    onSuccess: () => {
      setShowForm(false);
      setEditing(null);
      qc.invalidateQueries({ queryKey: ['connections'] });
    },
  });

  const deleteConnection = useMutation({
    mutationFn: (id: string) => api(`/api/connections/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      if (expandedId) setExpandedId(null);
      qc.invalidateQueries({ queryKey: ['connections'] });
      qc.invalidateQueries({ queryKey: ['models'] });
      qc.invalidateQueries({ queryKey: ['mappings'] });
    },
  });

  const toggleConnection = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api(`/api/connections/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['connections'] });
      qc.invalidateQueries({ queryKey: ['models'] });
    },
  });

  const addToken = useMutation({
    mutationFn: ({ connectionId, name, apiKey }: { connectionId: string; name: string; apiKey: string }) =>
      api(`/api/connections/${connectionId}/tokens`, {
        method: 'POST',
        body: JSON.stringify({ name, apiKey }),
      }),
    onSuccess: (_data, variables) => {
      setShowAddToken(null);
      qc.invalidateQueries({ queryKey: ['tokens', variables.connectionId] });
      qc.invalidateQueries({ queryKey: ['models'] });
    },
  });

  const deleteToken = useMutation({
    mutationFn: ({ connectionId, tokenId }: { connectionId: string; tokenId: string }) =>
      api(`/api/connections/${connectionId}/tokens/${tokenId}`, { method: 'DELETE' }),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ['tokens', variables.connectionId] });
      qc.invalidateQueries({ queryKey: ['models'] });
    },
  });

  const toggleToken = useMutation({
    mutationFn: ({
      connectionId,
      tokenId,
      enabled,
    }: {
      connectionId: string;
      tokenId: string;
      enabled: boolean;
    }) =>
      api(`/api/connections/${connectionId}/tokens/${tokenId}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled }),
      }),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ['tokens', variables.connectionId] });
      qc.invalidateQueries({ queryKey: ['models'] });
    },
  });

  const addBindings = useMutation({
    mutationFn: async ({
      connectionId,
      presetIds,
      apiFormat,
      providerBasePath,
    }: {
      connectionId: string;
      presetIds: string[];
      apiFormat?: string;
      providerBasePath?: string;
    }) => {
      const result = await api<{
        bound: unknown[];
        failed: { presetId: string; error: string }[];
      }>(`/api/connections/${connectionId}/bindings`, {
        method: 'POST',
        body: JSON.stringify({
          presetIds,
          ...(apiFormat ? { apiFormat } : {}),
          ...(providerBasePath ? { providerBasePath } : {}),
        }),
      });
      if (result.failed.length)
        throw new Error(
          `${result.failed.length}/${presetIds.length} binding(s) failed: ${result.failed
            .map((f) => f.error)
            .join('; ')}`,
        );
      return result;
    },
    onSuccess: () => setShowBindPreset(null),
    onSettled: (_data, _error, variables) => {
      // Invalidate on partial failure too — some presets may still have bound successfully.
      qc.invalidateQueries({ queryKey: ['bindings', variables.connectionId] });
      qc.invalidateQueries({ queryKey: ['models'] });
    },
  });

  const deleteBinding = useMutation({
    mutationFn: ({ connectionId, bindingId }: { connectionId: string; bindingId: string }) =>
      api(`/api/connections/${connectionId}/bindings/${bindingId}`, { method: 'DELETE' }),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ['bindings', variables.connectionId] });
      qc.invalidateQueries({ queryKey: ['models'] });
    },
  });

  return (
    <>
      <div className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Provider connections</h1>
          <p className="muted mt-1">
            Connections hold base URLs, tokens, and preset bindings. See the Models tab for
            per-token instance status.
          </p>
        </div>
        <button
          className="btn btn-primary"
          onClick={() => {
            setEditing(null);
            setShowForm(true);
          }}
        >
          Add connection
        </button>
      </div>

      {showForm && (
        <ConnectionFormCard
          initial={editing}
          error={saveConnection.error?.message}
          onCancel={() => { setShowForm(false); setEditing(null); }}
          onSave={(form) => saveConnection.mutate(form)}
        />
      )}

      {showAddToken && (
        <AddTokenModal
          error={addToken.error?.message}
          onCancel={() => setShowAddToken(null)}
          onAdd={(name, apiKey) => addToken.mutate({ connectionId: showAddToken, name, apiKey })}
        />
      )}

      {showBindPreset && (
        <BindPresetModal
          presets={presets.data ?? []}
          boundPresetIds={new Set((bindings.data ?? []).map((b) => b.presetId))}
          tokenCount={tokens.data?.length ?? 0}
          error={addBindings.error?.message}
          isPending={addBindings.isPending}
          onCancel={() => setShowBindPreset(null)}
          onBind={(presetIds, apiFormat, providerBasePath) =>
            addBindings.mutate({ connectionId: showBindPreset, presetIds, apiFormat, providerBasePath })
          }
        />
      )}

      <div className="grid gap-4">
        {connections.data?.map((connection) => {
          const isExpanded = expandedId === connection.id;
          return (
            <div className="card overflow-hidden" key={connection.id}>
              {/* Header row */}
              <div className="flex items-center gap-3 p-5">
                <button
                  aria-checked={connection.enabled}
                  aria-label={`${connection.enabled ? 'Disable' : 'Enable'} ${connection.displayName}`}
                  className={`relative h-5 w-9 shrink-0 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-900 ${connection.enabled ? 'bg-emerald-500/80' : 'bg-zinc-700'}`}
                  disabled={toggleConnection.isPending}
                  onClick={() => toggleConnection.mutate({ id: connection.id, enabled: !connection.enabled })}
                  role="switch"
                  title={connection.enabled ? 'Enabled — click to disable' : 'Disabled — click to enable'}
                  type="button"
                >
                  <span
                    className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-zinc-100 shadow-sm transition-transform ${connection.enabled ? 'translate-x-4' : 'translate-x-0'}`}
                  />
                </button>
                <div className="min-w-0 flex-1">
                  <h2 className="font-medium">{connection.displayName}</h2>
                  <p className="muted mt-0.5 truncate">{connection.baseUrl}</p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <button
                    className="btn"
                    onClick={() => {
                      setEditing(connection);
                      setShowForm(true);
                    }}
                  >
                    Edit
                  </button>
                  <button
                    className="btn btn-danger"
                    onClick={() =>
                      confirm(
                        `Delete "${connection.displayName}"? This also permanently deletes all tokens, bindings, and model instances.`,
                      ) && deleteConnection.mutate(connection.id)
                    }
                  >
                    Delete
                  </button>
                </div>
              </div>

              {/* Expandable sections */}
              {isExpanded && (
                <div className="border-t border-zinc-800 bg-zinc-950/50 p-5 space-y-5">
                  {/* Tokens section */}
                  <details open>
                    <summary className="flex cursor-pointer items-center justify-between text-sm font-medium text-zinc-300 hover:text-white">
                      <span>Tokens ({tokens.data?.length ?? 0})</span>
                    </summary>
                    <div className="mt-2 rounded-lg border border-zinc-800 bg-zinc-950">
                      {tokens.data?.map((token) => {
                        const cooling =
                          !!token.cooldownUntil && new Date(token.cooldownUntil) > new Date();
                        const errorMessage = latestErrorMessage(token.latestError);
                        return (
                          <div
                            className={`flex items-center gap-3 border-b border-zinc-800/60 px-4 py-2.5 last:border-b-0 ${!token.enabled ? 'opacity-60' : ''}`}
                            key={token.id}
                          >
                            <button
                              aria-checked={token.enabled}
                              aria-label={`${token.enabled ? 'Disable' : 'Enable'} ${token.name}`}
                              className={`relative h-4 w-7 shrink-0 rounded-full transition-colors focus:outline-none ${token.enabled ? 'bg-emerald-500/80' : 'bg-zinc-700'}`}
                              disabled={toggleToken.isPending}
                              onClick={() =>
                                toggleToken.mutate({
                                  connectionId: connection.id,
                                  tokenId: token.id,
                                  enabled: !token.enabled,
                                })
                              }
                              role="switch"
                              title={token.enabled ? 'Enabled — click to disable' : 'Disabled — click to enable'}
                              type="button"
                            >
                              <span
                                className={`absolute top-0.5 left-0.5 h-3 w-3 rounded-full bg-zinc-100 shadow-sm transition-transform ${token.enabled ? 'translate-x-3' : 'translate-x-0'}`}
                              />
                            </button>
                            <div className="min-w-0 flex-1">
                              <span className="flex items-baseline gap-2 truncate text-sm">
                                {token.name}
                                {token.keyPreview && (
                                  <span className="truncate font-mono text-xs text-zinc-500">
                                    {token.keyPreview}
                                  </span>
                                )}
                              </span>
                              {token.enabled && cooling && (
                                <span className="block truncate text-xs text-amber-400">
                                  Cooling down until {new Date(token.cooldownUntil!).toLocaleTimeString()}
                                  {errorMessage ? ` — ${errorMessage}` : ''}
                                </span>
                              )}
                              {!token.enabled && errorMessage && (
                                <span className="block truncate text-xs text-red-400">
                                  Last error — {errorMessage}
                                </span>
                              )}
                            </div>
                            <button
                              className="btn btn-danger h-7 px-2.5 text-xs"
                              onClick={() =>
                                confirm(`Delete token "${token.name}"?`) &&
                                deleteToken.mutate({ connectionId: connection.id, tokenId: token.id })
                              }
                            >
                              Delete
                            </button>
                          </div>
                        );
                      })}
                      {(!tokens.data || tokens.data.length === 0) && (
                        <p className="px-4 py-3 text-center text-sm text-zinc-500">No tokens added yet.</p>
                      )}
                    </div>
                    <button
                      className="btn mt-2 text-sm"
                      onClick={() => setShowAddToken(connection.id)}
                    >
                      + Add token
                    </button>
                  </details>

                  {/* Bindings section */}
                  <details open>
                    <summary className="flex cursor-pointer items-center justify-between text-sm font-medium text-zinc-300 hover:text-white">
                      <span>Model bindings ({bindings.data?.length ?? 0})</span>
                    </summary>
                    <div className="mt-2 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950">
                      {bindings.data?.map((binding) => (
                        <div
                          className="flex items-center gap-3 border-b border-zinc-800/60 px-4 py-2.5 last:border-b-0"
                          key={binding.id}
                        >
                          <span className="w-32 shrink-0 truncate text-sm" title={binding.presetDisplayName}>
                            {binding.presetDisplayName}
                          </span>
                          <span
                            className="w-36 shrink-0 truncate font-mono text-xs text-zinc-500"
                            title={binding.presetUpstreamModelId}
                          >
                            {binding.presetUpstreamModelId}
                          </span>
                          <span className="w-16 shrink-0 text-xs text-zinc-500">
                            {binding.apiFormat === 'anthropic_compatible' ? 'Anthropic' : 'OpenAI'}
                          </span>
                          <span className="w-24 shrink-0 truncate font-mono text-xs text-zinc-500">
                            {binding.providerBasePath || '—'}
                          </span>
                          <button
                            className="btn btn-danger ml-auto h-7 shrink-0 px-2.5 text-xs"
                            onClick={() =>
                              confirm(`Unbind "${binding.presetDisplayName}" from this connection? This will remove all associated model instances.`) &&
                              deleteBinding.mutate({ connectionId: connection.id, bindingId: binding.id })
                            }
                          >
                            Unbind
                          </button>
                        </div>
                      ))}
                      {(!bindings.data || bindings.data.length === 0) && (
                        <p className="px-4 py-3 text-center text-sm text-zinc-500">No bindings yet.</p>
                      )}
                    </div>
                    <button
                      className="btn mt-2 text-sm"
                      onClick={() => setShowBindPreset(connection.id)}
                    >
                      + Bind preset
                    </button>
                  </details>
                </div>
              )}

              {/* Expand/collapse button */}
              {!isExpanded && (
                <button
                  className="w-full border-t border-zinc-800 px-5 py-2 text-center text-xs text-zinc-500 hover:bg-zinc-800/50 hover:text-zinc-300"
                  onClick={() => setExpandedId(connection.id)}
                >
                  Expand details
                </button>
              )}
              {isExpanded && (
                <button
                  className="w-full border-t border-zinc-800 px-5 py-2 text-center text-xs text-zinc-500 hover:bg-zinc-800/50 hover:text-zinc-300"
                  onClick={() => setExpandedId(null)}
                >
                  Collapse
                </button>
              )}
            </div>
          );
        })}
        {connections.data?.length === 0 && (
          <div className="card text-center text-zinc-400">
            Add a provider connection to get started.
          </div>
        )}
      </div>
    </>
  );
}

function ConnectionFormCard({
  initial,
  onSave,
  onCancel,
  error,
}: {
  initial: ProviderConnection | null;
  onSave: (form: ConnectionForm) => void;
  onCancel: () => void;
  error?: string;
}) {
  const { register, handleSubmit } = useForm<ConnectionForm>({
    defaultValues: initial
      ? {
          displayName: initial.displayName,
          baseUrl: initial.baseUrl,
          enabled: initial.enabled,
        }
      : connectionDefaults,
  });
  return (
    <form
      autoComplete="off"
      className="card mb-6 grid gap-4 md:grid-cols-2"
      onSubmit={handleSubmit(onSave)}
    >
      <h2 className="text-lg font-medium md:col-span-2">
        {initial ? 'Edit connection' : 'Add connection'}
      </h2>
      <label>
        <span className="label">Connection name</span>
        <input className="input" {...register('displayName', { required: true })} />
      </label>
      <label>
        <span className="label">Base endpoint</span>
        <input
          className="input"
          placeholder="https://provider.example"
          {...register('baseUrl', { required: true })}
        />
      </label>
      <label className="flex items-center gap-2 pt-7">
        <input type="checkbox" {...register('enabled')} /> Enabled
      </label>
      {error && <p className="text-red-400 md:col-span-2">{error}</p>}
      <div className="flex gap-2 md:col-span-2">
        <button className="btn btn-primary">Save</button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function AddTokenModal({
  error,
  onCancel,
  onAdd,
}: {
  error?: string;
  onCancel: () => void;
  onAdd: (name: string, apiKey: string) => void;
}) {
  const { register, handleSubmit } = useForm<TokenForm>({ defaultValues: tokenDefaults });
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
      role="presentation"
    >
      <section className="card w-full max-w-md" role="dialog" aria-modal="true">
        <h2 className="text-lg font-medium">Add token</h2>
        <p className="muted mt-1">API keys are stored encrypted and never shown after creation.</p>
        <form
          className="mt-4 grid gap-4"
          onSubmit={handleSubmit((v) => onAdd(v.name, v.apiKey))}
        >
          <label>
            <span className="label">Token name</span>
            <input className="input" {...register('name', { required: true })} placeholder="e.g. Primary, Backup" />
          </label>
          <label>
            <span className="label">API key</span>
            <input
              autoComplete="new-password"
              className="input"
              spellCheck={false}
              type="password"
              {...register('apiKey', { required: true })}
            />
          </label>
          {error && <p className="text-red-400">{error}</p>}
          <div className="flex gap-2">
            <button className="btn btn-primary">Add</button>
            <button type="button" className="btn" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function BindPresetModal({
  presets,
  boundPresetIds,
  tokenCount,
  error,
  isPending,
  onCancel,
  onBind,
}: {
  presets: Preset[];
  boundPresetIds: Set<string>;
  tokenCount: number;
  error?: string;
  isPending: boolean;
  onCancel: () => void;
  onBind: (presetIds: string[], apiFormat: string, providerBasePath: string) => void;
}) {
  const available = presets.filter((p) => !boundPresetIds.has(p.id));
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [apiFormat, setApiFormat] = useState('');
  const [providerBasePath, setProviderBasePath] = useState('');
  const allSelected = available.length > 0 && selected.size === available.length;

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
      role="presentation"
    >
      <section className="card w-full max-w-lg" role="dialog" aria-modal="true">
        <h2 className="text-lg font-medium">Bind presets</h2>
        <p className="muted mt-1">
          Link one or more model presets to this connection. This will create model instances
          automatically.
        </p>
        <form
          className="mt-4 grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (selected.size) onBind([...selected], apiFormat, providerBasePath);
          }}
        >
          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="label">Presets ({selected.size} selected)</span>
              {available.length > 0 && (
                <button
                  className="text-xs text-indigo-400 hover:text-indigo-300"
                  onClick={() =>
                    setSelected(allSelected ? new Set() : new Set(available.map((p) => p.id)))
                  }
                  type="button"
                >
                  {allSelected ? 'Deselect all' : 'Select all'}
                </button>
              )}
            </div>
            <div className="max-h-64 overflow-y-auto rounded-lg border border-zinc-800">
              {available.map((p) => (
                <label
                  className="flex cursor-pointer items-center gap-3 border-b border-zinc-800/60 px-3 py-2 last:border-b-0 hover:bg-zinc-800/40"
                  key={p.id}
                >
                  <input
                    checked={selected.has(p.id)}
                    className="shrink-0"
                    onChange={() => toggle(p.id)}
                    type="checkbox"
                  />
                  <span className="min-w-0 flex-1 truncate text-sm">{p.displayName}</span>
                  <span className="shrink-0 font-mono text-xs text-zinc-500">
                    {p.upstreamModelId}
                  </span>
                </label>
              ))}
              {available.length === 0 && (
                <p className="px-3 py-3 text-center text-sm text-zinc-500">
                  All presets are already bound to this connection.
                </p>
              )}
            </div>
          </div>
          <label>
            <span className="label">API format override (optional)</span>
            <select
              className="input"
              onChange={(e) => setApiFormat(e.target.value)}
              value={apiFormat}
            >
              <option value="">No override — use each preset's own format</option>
              <option value="openai_compatible">OpenAI compatible</option>
              <option value="anthropic_compatible">Anthropic compatible</option>
            </select>
          </label>
          <label>
            <span className="label">Base path (optional)</span>
            <input
              className="input"
              onChange={(e) => setProviderBasePath(e.target.value)}
              placeholder="/apps/anthropic or /compatible-mode/v1"
              value={providerBasePath}
            />
          </label>
          {tokenCount > 0 && (
            <p className="text-sm text-zinc-400">
              This will create {tokenCount} model instance{tokenCount !== 1 ? 's' : ''} per preset
              (one per token).
            </p>
          )}
          {tokenCount === 0 && (
            <p className="text-sm text-amber-400">
              No tokens on this connection. Add a token first to create instances.
            </p>
          )}
          {error && <p className="text-red-400">{error}</p>}
          <div className="flex gap-2">
            <button className="btn btn-primary" disabled={!selected.size || isPending}>
              {isPending ? 'Binding…' : `Bind${selected.size ? ` (${selected.size})` : ''}`}
            </button>
            <button type="button" className="btn" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
