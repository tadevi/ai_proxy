import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type ProviderConnection, type ConnectionToken, type ModelBinding, type Model, type Preset } from '../api';

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

type BindingForm = {
  presetId: string;
  apiFormat: string;
  providerBasePath: string;
};

const bindingDefaults: BindingForm = {
  presetId: '',
  apiFormat: 'openai_compatible',
  providerBasePath: '',
};

function latestErrorMessage(error?: Record<string, unknown> | null) {
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

export function Connections() {
  const qc = useQueryClient();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showAddToken, setShowAddToken] = useState<string | null>(null);
  const [showBindPreset, setShowBindPreset] = useState<string | null>(null);
  const [editing, setEditing] = useState<ProviderConnection | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; message: string } | null>(null);

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

  const models = useQuery({
    queryKey: ['models'],
    queryFn: () => api<Model[]>('/api/models'),
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

  const addBinding = useMutation({
    mutationFn: ({
      connectionId,
      presetId,
      apiFormat,
      providerBasePath,
    }: {
      connectionId: string;
      presetId: string;
      apiFormat?: string;
      providerBasePath?: string;
    }) =>
      api(`/api/connections/${connectionId}/bindings`, {
        method: 'POST',
        body: JSON.stringify({
          presetId,
          ...(apiFormat ? { apiFormat } : {}),
          ...(providerBasePath ? { providerBasePath } : {}),
        }),
      }),
    onSuccess: (_data, variables) => {
      setShowBindPreset(null);
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

  const testModel = useMutation({
    mutationFn: (id: string) =>
      api<{ message: string }>(`/api/models/${id}/test`, { method: 'POST' }),
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
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['models'] });
    },
  });

  const connectionModels = (connectionId: string) =>
    (models.data ?? []).filter((m) => m.providerConnectionId === connectionId);

  return (
    <>
      <div className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Provider connections</h1>
          <p className="muted mt-1">
            Connections hold base URLs, tokens, and preset bindings. Model instances are auto-generated.
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
          tokenCount={tokens.data?.length ?? 0}
          error={addBinding.error?.message}
          onCancel={() => setShowBindPreset(null)}
          onBind={(presetId, apiFormat, providerBasePath) =>
            addBinding.mutate({ connectionId: showBindPreset, presetId, apiFormat, providerBasePath })
          }
        />
      )}

      <div className="grid gap-4">
        {connections.data?.map((connection) => {
          const isExpanded = expandedId === connection.id;
          const instanceModels = connectionModels(connection.id);
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
                      {tokens.data?.map((token) => (
                        <div
                          className={`flex items-center gap-3 border-b border-zinc-800/60 px-4 py-2.5 last:border-b-0 ${!token.enabled ? 'opacity-60' : ''}`}
                          key={token.id}
                        >
                          <span
                            className={`inline-block h-2 w-2 shrink-0 rounded-full ${token.enabled ? 'bg-emerald-400' : 'bg-zinc-600'}`}
                          />
                          <span className="min-w-0 flex-1 truncate text-sm">{token.name}</span>
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
                      ))}
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
                    <div className="mt-2 rounded-lg border border-zinc-800 bg-zinc-950">
                      {bindings.data?.map((binding) => (
                        <div
                          className="flex items-center gap-3 border-b border-zinc-800/60 px-4 py-2.5 last:border-b-0"
                          key={binding.id}
                        >
                          <div className="min-w-0 flex-1">
                            <span className="text-sm">{binding.presetName}</span>
                            <span className="ml-2 text-xs text-zinc-500">
                              · {binding.apiFormat === 'anthropic_compatible' ? 'Anthropic' : 'OpenAI'}
                              {binding.providerBasePath && ` · ${binding.providerBasePath}`}
                            </span>
                          </div>
                          <button
                            className="btn btn-danger h-7 px-2.5 text-xs"
                            onClick={() =>
                              confirm(`Unbind "${binding.presetName}" from this connection? This will remove all associated model instances.`) &&
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

                  {/* Model instances section */}
                  <details open>
                    <summary className="flex cursor-pointer items-center justify-between text-sm font-medium text-zinc-300 hover:text-white">
                      <span>Model instances ({instanceModels.length})</span>
                    </summary>
                    <div className="mt-2 rounded-lg border border-zinc-800 bg-zinc-950">
                      {instanceModels.map((m) => (
                        <div
                          className={`flex items-center gap-3 border-b border-zinc-800/60 px-4 py-2.5 last:border-b-0 ${!m.enabled ? 'opacity-60' : ''}`}
                          key={m.id}
                        >
                          <span className="min-w-0 flex-1 truncate text-sm">
                            {m.displayName}
                          </span>
                          <div className="flex items-center gap-1.5">
                            {m.latestTestStatus && (
                              <span
                                className={`inline-block h-2 w-2 rounded-full ${m.latestTestStatus === 'healthy' ? 'bg-emerald-400' : 'bg-red-400'}`}
                              />
                            )}
                            <span className="text-xs text-zinc-500">
                              {m.latestTestStatus === 'healthy'
                                ? 'Healthy'
                                : m.latestTestStatus === 'failed'
                                  ? 'Failed'
                                  : '—'}
                            </span>
                          </div>
                          <button
                            aria-checked={m.enabled}
                            aria-label={`${m.enabled ? 'Disable' : 'Enable'} ${m.displayName}`}
                            className={`relative h-4 w-7 shrink-0 rounded-full transition-colors focus:outline-none ${m.enabled ? 'bg-emerald-500/80' : 'bg-zinc-700'}`}
                            disabled={toggleModel.isPending}
                            onClick={() => toggleModel.mutate({ id: m.id, enabled: !m.enabled })}
                            role="switch"
                            type="button"
                          >
                            <span
                              className={`absolute top-0.5 left-0.5 h-3 w-3 rounded-full bg-zinc-100 shadow-sm transition-transform ${m.enabled ? 'translate-x-3' : 'translate-x-0'}`}
                            />
                          </button>
                          <button
                            className="btn h-7 px-2.5 text-xs"
                            disabled={testingId === m.id}
                            onClick={() => testModel.mutate(m.id)}
                          >
                            {testingId === m.id ? 'Testing…' : 'Test'}
                          </button>
                        </div>
                      ))}
                      {instanceModels.length === 0 && (
                        <p className="px-4 py-3 text-center text-sm text-zinc-500">
                          No instances. Bind a preset to create instances.
                        </p>
                      )}
                    </div>
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
  tokenCount,
  error,
  onCancel,
  onBind,
}: {
  presets: Preset[];
  tokenCount: number;
  error?: string;
  onCancel: () => void;
  onBind: (presetId: string, apiFormat: string, providerBasePath: string) => void;
}) {
  const { register, handleSubmit, watch } = useForm<BindingForm>({
    defaultValues: bindingDefaults,
  });
  const selectedPresetId = watch('presetId');
  const selectedPreset = presets.find((p) => p.id === selectedPresetId);
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
      role="presentation"
    >
      <section className="card w-full max-w-md" role="dialog" aria-modal="true">
        <h2 className="text-lg font-medium">Bind preset</h2>
        <p className="muted mt-1">
          Link a model preset to this connection. This will create model instances automatically.
        </p>
        <form
          className="mt-4 grid gap-4"
          onSubmit={handleSubmit((v) => onBind(v.presetId, v.apiFormat, v.providerBasePath))}
        >
          <label>
            <span className="label">Preset</span>
            <select className="input" {...register('presetId', { required: true })}>
              <option value="">Select a preset…</option>
              {presets.map((p) => (
                <option value={p.id} key={p.id}>
                  {p.displayName} ({p.upstreamModelId})
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="label">API format</span>
            <select
              className="input"
              {...register('apiFormat')}
              defaultValue={selectedPreset?.apiFormat ?? 'openai_compatible'}
            >
              <option value="openai_compatible">OpenAI compatible</option>
              <option value="anthropic_compatible">Anthropic compatible</option>
            </select>
          </label>
          <label>
            <span className="label">Base path (optional)</span>
            <input
              className="input"
              placeholder="/apps/anthropic or /compatible-mode/v1"
              {...register('providerBasePath')}
            />
          </label>
          {tokenCount > 0 && (
            <p className="text-sm text-zinc-400">
              This will create {tokenCount} model instance{tokenCount !== 1 ? 's' : ''} (one per token).
            </p>
          )}
          {tokenCount === 0 && (
            <p className="text-sm text-amber-400">
              No tokens on this connection. Add a token first to create instances.
            </p>
          )}
          {error && <p className="text-red-400">{error}</p>}
          <div className="flex gap-2">
            <button className="btn btn-primary">Bind</button>
            <button type="button" className="btn" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
