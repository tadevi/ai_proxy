import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Model, type Preset, type ProviderConnection } from '../api';
type Form = {
  displayName: string;
  providerConnectionId: string;
  upstreamModelId: string;
  apiFormat: 'openai_compatible' | 'anthropic_compatible';
  providerBasePath: string;
  requestPathOverride: string;
  maxOutputTokens: string;
  enabled: boolean;
  supportsImages: string;
  supportsReasoning: string;
};
const defaults: Form = {
  displayName: '',
  providerConnectionId: '',
  upstreamModelId: '',
  apiFormat: 'openai_compatible',
  providerBasePath: '',
  requestPathOverride: '',
  maxOutputTokens: '',
  enabled: true,
  supportsImages: 'no',
  supportsReasoning: 'yes',
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

type ModelUsage = {
  gatewayModelId: string;
  requestCount: string;
  inputTokens: string;
  outputTokens: string;
};

function formatTokens(value: string | number) {
  const tokens = Number(value);
  if (!Number.isFinite(tokens)) return '—';
  const [suffix, divisor]: [string, number] =
    tokens >= 1_000_000_000
      ? ['B', 1_000_000_000]
      : tokens >= 1_000_000
        ? ['M', 1_000_000]
        : ['K', 1_000];
  const scaled = tokens / divisor;
  return `${Number(scaled.toFixed(scaled >= 10 ? 1 : 2))}${suffix}`;
}

export function Models() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Model | null>(null);
  const [addMode, setAddMode] = useState<'preset' | 'manual' | null>(null);
  const [linkPreset, setLinkPreset] = useState<Preset | null>(null);
  const [presetSearch, setPresetSearch] = useState('');
  const [rulesModel, setRulesModel] = useState<Model | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; message: string } | null>(null);
  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(null), 2_000);
    return () => window.clearTimeout(timeout);
  }, [notice]);
  const models = useQuery({ queryKey: ['models'], queryFn: () => api<Model[]>('/api/models') });
  const presets = useQuery({ queryKey: ['presets'], queryFn: () => api<Preset[]>('/api/presets') });
  const connections = useQuery({
    queryKey: ['connections'],
    queryFn: () => api<ProviderConnection[]>('/api/connections'),
  });
  const usage = useQuery({
    queryKey: ['models', 'usage'],
    queryFn: () => api<ModelUsage[]>('/api/models/usage'),
    refetchInterval: 10_000,
  });
  const usageByModel = new Map(usage.data?.map((item) => [item.gatewayModelId, item]));
  const save = useMutation({
    mutationFn: (v: Form) =>
      api(`/api/models${editing ? `/${editing.id}` : ''}`, {
        method: editing ? 'PATCH' : 'POST',
        body: JSON.stringify({
          ...v,
          maxOutputTokens: v.maxOutputTokens ? Number(v.maxOutputTokens) : null,
          requestPathOverride: v.requestPathOverride || null,
        }),
      }),
    onSuccess: () => {
      setAddMode(null);
      setEditing(null);
      qc.invalidateQueries({ queryKey: ['models'] });
    },
  });
  const link = useMutation({
    mutationFn: ({
      presetId,
      providerConnectionId,
      displayName,
    }: {
      presetId: string;
      providerConnectionId: string;
      displayName?: string;
    }) =>
      api(`/api/presets/${presetId}/link`, {
        method: 'POST',
        body: JSON.stringify({ providerConnectionId, displayName }),
      }),
    onSuccess: () => {
      setLinkPreset(null);
      setAddMode(null);
      setNotice({ tone: 'success', message: 'Model created from preset.' });
      qc.invalidateQueries({ queryKey: ['models'] });
      qc.invalidateQueries({ queryKey: ['mappings'] });
    },
    onError: (error) => setNotice({ tone: 'error', message: error.message }),
  });
  const del = useMutation({
    mutationFn: (id: string) => api(`/api/models/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['models'] }),
  });
  const toggleEnabled = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api(`/api/models/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['models'] });
      qc.invalidateQueries({ queryKey: ['mappings'] });
    },
  });
  const test = useMutation({
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
  return (
    <>
      <div className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Models</h1>
          <p className="muted mt-1">
            Models choose an existing provider connection and have immutable gateway IDs.
          </p>
        </div>
        <button
          className="btn btn-primary"
          onClick={() => {
            setEditing(null);
            setAddMode('preset');
            setPresetSearch('');
          }}
        >
          Add model
        </button>
      </div>
      {addMode === 'preset' && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setAddMode(null);
              setLinkPreset(null);
            }
          }}
          role="presentation"
        >
          <section
            aria-modal="true"
            className="flex w-full max-w-2xl flex-col rounded-xl border border-zinc-700 bg-zinc-900 shadow-xl"
            role="dialog"
            style={{ maxHeight: 'calc(100vh - 2rem)' }}
          >
            {!linkPreset ? (
              <>
                <div className="border-b border-zinc-800 p-5 pb-4">
                  <div className="flex items-center justify-between">
                    <h2 className="text-lg font-medium">Select a preset</h2>
                    <button
                      className="text-sm text-zinc-400 hover:text-zinc-200"
                      onClick={() => {
                        setAddMode('manual');
                        setLinkPreset(null);
                      }}
                    >
                      Add manually →
                    </button>
                  </div>
                  <input
                    className="input mt-3"
                    placeholder="Search presets…"
                    value={presetSearch}
                    onChange={(event) => setPresetSearch(event.target.value)}
                    autoFocus
                  />
                </div>
                <div className="flex-1 overflow-y-auto p-5 pt-3">
                  <div className="grid gap-2">
                    {presets.data
                      ?.filter(
                        (p) =>
                          !presetSearch ||
                          p.displayName.toLowerCase().includes(presetSearch.toLowerCase()) ||
                          p.upstreamModelId.toLowerCase().includes(presetSearch.toLowerCase()),
                      )
                      .map((preset) => (
                        <button
                          className="flex w-full items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-950/50 p-3 text-left transition-colors hover:border-zinc-600 hover:bg-zinc-800/50"
                          key={preset.id}
                          onClick={() => setLinkPreset(preset)}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="font-medium">{preset.displayName}</span>
                              {preset.userId === null && (
                                <span className="rounded-full bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-500">
                                  System
                                </span>
                              )}
                              <span
                                className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${preset.apiFormat === 'anthropic_compatible' ? 'bg-indigo-950 text-indigo-300' : 'bg-sky-950 text-sky-300'}`}
                              >
                                {preset.apiFormat === 'anthropic_compatible' ? 'Anthropic' : 'OpenAI'}
                              </span>
                            </div>
                            <p className="mt-0.5 truncate font-mono text-xs text-zinc-500">
                              {preset.upstreamModelId}
                            </p>
                          </div>
                          <div className="flex shrink-0 gap-1.5">
                            {preset.supportsReasoning === 'yes' && (
                              <span className="rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-500">
                                Reasoning
                              </span>
                            )}
                            {preset.supportsImages === 'yes' && (
                              <span className="rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-500">
                                Images
                              </span>
                            )}
                          </div>
                        </button>
                      ))}
                    {presets.data?.filter(
                      (p) =>
                        !presetSearch ||
                        p.displayName.toLowerCase().includes(presetSearch.toLowerCase()) ||
                        p.upstreamModelId.toLowerCase().includes(presetSearch.toLowerCase()),
                    ).length === 0 && (
                      <p className="py-8 text-center text-sm text-zinc-500">No presets found.</p>
                    )}
                  </div>
                </div>
              </>
            ) : (
              <div className="p-5">
                <button
                  className="mb-4 text-sm text-zinc-400 hover:text-zinc-200"
                  onClick={() => setLinkPreset(null)}
                >
                  ← Back to presets
                </button>
                <h2 className="text-lg font-medium">Link preset</h2>
                <p className="muted mt-1">
                  Create a model from{' '}
                  <span className="font-mono text-zinc-200">{linkPreset.displayName}</span>
                </p>
                <LinkPresetForm
                  connections={connections.data?.filter((c) => c.enabled) ?? []}
                  preset={linkPreset}
                  error={link.error?.message}
                  onCancel={() => {
                    setAddMode(null);
                    setLinkPreset(null);
                  }}
                  onLink={(connectionId, displayName) =>
                    link.mutate({
                      presetId: linkPreset.id,
                      providerConnectionId: connectionId,
                      displayName,
                    })
                  }
                />
              </div>
            )}
          </section>
        </div>
      )}
      {addMode === 'manual' && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setAddMode(null);
              setEditing(null);
            }
          }}
          role="presentation"
        >
          <section
            aria-labelledby="model-dialog-title"
            aria-modal="true"
            className="w-full max-w-3xl"
            role="dialog"
          >
            <ModelForm
              initial={editing}
              error={save.error?.message}
              onCancel={() => {
                setAddMode(null);
                setEditing(null);
              }}
              onSave={(v) => save.mutate(v)}
            />
          </section>
        </div>
      )}
      {rulesModel && <ThinkingRules model={rulesModel} onClose={() => setRulesModel(null)} />}
      <div className="grid gap-4">
        {models.data?.map((m) => {
          const modelUsage = usageByModel.get(m.gatewayModelId);
          return (
            <div className="card overflow-hidden p-0" key={m.id}>
              <div className="p-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <h2 className="font-mono text-lg font-medium">{m.displayName}</h2>
                    <span className="font-mono text-[13px] text-zinc-500">(id: {m.gatewayModelId})</span>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    <button
                      aria-checked={m.enabled}
                      aria-label={`${m.enabled ? 'Disable' : 'Enable'} ${m.displayName}`}
                      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-900 ${m.enabled ? 'bg-emerald-500/80' : 'bg-zinc-700'}`}
                      disabled={toggleEnabled.isPending}
                      onClick={() => toggleEnabled.mutate({ id: m.id, enabled: !m.enabled })}
                      role="switch"
                      title={m.enabled ? 'Enabled — click to disable' : 'Disabled — click to enable'}
                      type="button"
                    >
                      <span
                        className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-zinc-100 shadow-sm transition-transform ${m.enabled ? 'translate-x-4' : 'translate-x-0'}`}
                      />
                    </button>
                    <button
                      className="btn h-8 px-3.5 text-[13px]"
                      disabled={testingId === m.id}
                      onClick={() => test.mutate(m.id)}
                    >
                      {testingId === m.id ? 'Testing…' : 'Test'}
                    </button>
                    <button
                      className="btn h-8 px-3.5 text-[13px]"
                      onClick={() => {
                        setEditing(m);
                        setAddMode('manual');
                      }}
                    >
                      Edit
                    </button>
                    {m.apiFormat === 'openai_compatible' && (
                      <button className="btn h-8 px-3.5 text-[13px]" onClick={() => setRulesModel(m)}>
                        Rules
                      </button>
                    )}
                    <button
                      className="btn btn-danger h-8 px-3.5 text-[13px]"
                      onClick={() =>
                        confirm('Delete this model? It will also be removed from mappings.') &&
                        del.mutate(m.id)
                      }
                    >
                      Delete
                    </button>
                  </div>
                </div>

                <div className="mt-1.5 flex flex-wrap items-center gap-2.5 text-[13px]">
                  <span className="font-mono text-zinc-400">{m.upstreamModelId}</span>
                  <span className="text-zinc-600">·</span>
                  <span className="text-zinc-400">{m.providerConnectionName}</span>
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
                      className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${m.latestTestStatus === 'pass' ? 'bg-emerald-950 text-emerald-400' : 'bg-red-950 text-red-400'}`}
                    >
                      {m.latestTestStatus === 'pass' ? 'Healthy' : 'Unhealthy'}
                    </span>
                  )}
                  {m.cooldownUntil && new Date(m.cooldownUntil) > new Date() && (
                    <span className="rounded-full bg-amber-950 px-2.5 py-0.5 text-xs font-medium text-amber-400">
                      Cooling down until {new Date(m.cooldownUntil).toLocaleTimeString()}
                    </span>
                  )}
                  <span
                    className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${m.apiFormat === 'anthropic_compatible' ? 'bg-indigo-950 text-indigo-300' : 'bg-sky-950 text-sky-300'}`}
                  >
                    {m.apiFormat === 'anthropic_compatible' ? 'Anthropic' : 'OpenAI'}
                  </span>
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
              <div className="grid border-t border-zinc-800 sm:grid-cols-3">
                <div className="border-b border-zinc-800 px-6 py-4 sm:border-r sm:border-b-0">
                  <p className="text-xs text-zinc-500">Input tokens</p>
                  <p className="mt-1 text-[22px] font-medium">
                    {modelUsage ? formatTokens(modelUsage.inputTokens) : '—'}
                  </p>
                </div>
                <div className="border-b border-zinc-800 px-6 py-4 sm:border-r sm:border-b-0">
                  <p className="text-xs text-zinc-500">Output tokens</p>
                  <p className="mt-1 text-[22px] font-medium">
                    {modelUsage ? formatTokens(modelUsage.outputTokens) : '—'}
                  </p>
                </div>
                <div className="px-6 py-4">
                  <p className="text-xs text-zinc-500">Requests</p>
                  <p className="mt-1 text-[22px] font-medium">
                    {modelUsage ? Number(modelUsage.requestCount).toLocaleString() : 0}
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
                      <span className="truncate text-red-200/90">
                        {latestErrorMessage(m.latestError)}
                      </span>
                    </div>
                  </summary>
                  <pre className="mt-3 max-h-48 overflow-auto rounded-lg bg-zinc-950 p-3 text-xs text-red-100">
                    {JSON.stringify(m.latestError, null, 2)}
                  </pre>
                </details>
              )}
            </div>
          );
        })}
        {models.data?.length === 0 && (
          <div className="card text-center text-zinc-400">
            Add your first upstream model to get started.
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
              ×
            </button>
          </div>
        </div>
      )}
    </>
  );
}

type StoredRule = {
  id: string;
  type: string;
  enabled: boolean;
  position: number;
  configJson: Record<string, unknown>;
};

function ThinkingRules({ model, onClose }: { model: Model; onClose: () => void }) {
  const qc = useQueryClient();
  const rules = useQuery({
    queryKey: ['rules', model.id],
    queryFn: () => api<StoredRule[]>(`/api/models/${model.id}/rules`),
  });
  const existing = rules.data?.find((rule) => rule.type === 'thinking_effort');
  const config = existing?.configJson ?? {};
  const [destination, setDestination] = useState('reasoning_effort');
  const [mapping, setMapping] = useState<Record<string, string>>({
    low: 'low',
    medium: 'medium',
    high: 'high',
    xhigh: 'high',
  });
  useEffect(() => {
    if (!existing) return;
    setDestination(String(config.destination ?? 'reasoning_effort'));
    setMapping({
      low: String((config.mapping as Record<string, unknown> | undefined)?.low ?? 'low'),
      medium: String((config.mapping as Record<string, unknown> | undefined)?.medium ?? 'medium'),
      high: String((config.mapping as Record<string, unknown> | undefined)?.high ?? 'high'),
      xhigh: String((config.mapping as Record<string, unknown> | undefined)?.xhigh ?? 'high'),
    });
  }, [existing?.id]);
  const save = useMutation({
    mutationFn: () => {
      const otherRules = (rules.data ?? []).filter((rule) => rule.type !== 'thinking_effort');
      return api(`/api/models/${model.id}/rules`, {
        method: 'PUT',
        body: JSON.stringify([
          {
            type: 'thinking_effort',
            enabled: true,
            position: 0,
            config: { destination, disabledBehavior: 'remove', mapping },
          },
          ...otherRules.map((rule, index) => ({
            type: rule.type,
            enabled: rule.enabled,
            position: index + 1,
            config: rule.configJson,
          })),
        ]),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['rules', model.id] });
      onClose();
    },
  });
  return (
    <section className="card mb-6">
      <div className="flex justify-between">
        <div>
          <h2 className="text-lg font-medium">Thinking effort · {model.displayName}</h2>
          <p className="muted">OpenAI reasoning effort preset, fully editable.</p>
        </div>
        <button className="btn" onClick={onClose}>
          Close
        </button>
      </div>
      <label className="mt-4 block max-w-sm">
        <span className="label">Destination field</span>
        <input
          className="input"
          value={destination}
          onChange={(e) => setDestination(e.target.value)}
        />
      </label>
      <div className="mt-4 grid gap-3 sm:grid-cols-4">
        {['low', 'medium', 'high', 'xhigh'].map((effort) => (
          <label key={effort}>
            <span className="label capitalize">Incoming {effort}</span>
            <input
              className="input"
              value={mapping[effort]}
              onChange={(e) => setMapping({ ...mapping, [effort]: e.target.value })}
            />
          </label>
        ))}
      </div>
      {save.error && <p className="mt-3 text-red-400">{save.error.message}</p>}
      <button
        className="btn btn-primary mt-4"
        disabled={rules.isLoading}
        onClick={() => save.mutate()}
      >
        Save rule
      </button>
    </section>
  );
}
function ModelForm({
  initial,
  onSave,
  onCancel,
  error,
}: {
  initial: Model | null;
  onSave: (v: Form) => void;
  onCancel: () => void;
  error?: string;
}) {
  const { register, handleSubmit, watch } = useForm<Form>({
    defaultValues: initial
      ? {
          ...defaults,
          ...initial,
          maxOutputTokens: initial.maxOutputTokens?.toString() ?? '',
          requestPathOverride: initial.requestPathOverride ?? '',
        }
      : defaults,
  });
  const connections = useQuery({
    queryKey: ['connections'],
    queryFn: () => api<ProviderConnection[]>('/api/connections'),
  });
  const apiFormat = watch('apiFormat');
  return (
    <form
      className="card grid max-h-[calc(100vh-2rem)] gap-4 overflow-y-auto md:grid-cols-2"
      onSubmit={handleSubmit(onSave)}
    >
      <h2 className="md:col-span-2 text-lg font-medium" id="model-dialog-title">
        {initial ? 'Edit model' : 'Add model'}
      </h2>
      <Field label="Display name">
        <input className="input" {...register('displayName', { required: true })} />
      </Field>
      <Field label="Provider connection">
        <select className="input" {...register('providerConnectionId', { required: true })}>
          <option value="">Select a connection…</option>
          {connections.data
            ?.filter((connection) => connection.enabled)
            .map((connection) => (
              <option value={connection.id} key={connection.id}>
                {connection.displayName}
              </option>
            ))}
        </select>
      </Field>
      <Field label="Upstream model ID">
        <input className="input" {...register('upstreamModelId', { required: true })} />
      </Field>
      <Field label="API format">
        <select className="input" {...register('apiFormat')}>
          <option value="openai_compatible">OpenAI compatible</option>
          <option value="anthropic_compatible">Anthropic compatible</option>
        </select>
      </Field>
      <Field label="Provider base path">
        <input
          className="input"
          placeholder="/apps/anthropic or /compatible-mode/v1"
          {...register('providerBasePath')}
        />
      </Field>
      <Field label="Max output tokens">
        <input
          className="input"
          min="1"
          placeholder="Leave blank to forward unchanged"
          type="number"
          {...register('maxOutputTokens')}
        />
      </Field>
      <Field label="Advanced request path override">
        <input
          className="input"
          placeholder="Optional full relative path"
          {...register('requestPathOverride')}
        />
      </Field>
      <label className="flex items-center gap-2 pt-7">
        <input type="checkbox" {...register('enabled')} /> Enabled
      </label>
      <section className="md:col-span-2">
        <h3 className="mb-3 text-sm font-medium text-zinc-200">Capabilities</h3>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {(apiFormat === 'openai_compatible'
            ? (['supportsImages', 'supportsReasoning'] as const)
            : (['supportsImages'] as const)
          ).map((name) => (
            <Field label={name.replace('supports', 'Supports ')} key={name}>
              <select className="input" {...register(name)}>
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </select>
            </Field>
          ))}
        </div>
      </section>
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
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label>
      <span className="label">{label}</span>
      {children}
    </label>
  );
}

function LinkPresetForm({
  connections,
  preset,
  error,
  onCancel,
  onLink,
}: {
  connections: ProviderConnection[];
  preset: Preset;
  error?: string;
  onCancel: () => void;
  onLink: (connectionId: string, displayName?: string) => void;
}) {
  const { register, handleSubmit } = useForm<{
    providerConnectionId: string;
    displayName: string;
  }>({
    defaultValues: { providerConnectionId: '', displayName: preset.displayName },
  });
  return (
    <form
      className="mt-4 grid gap-4"
      onSubmit={handleSubmit((v) =>
        onLink(
          v.providerConnectionId,
          v.displayName !== preset.displayName ? v.displayName : undefined,
        ),
      )}
    >
      <label>
        <span className="label">Display name</span>
        <input className="input" {...register('displayName')} />
      </label>
      <label>
        <span className="label">Provider connection</span>
        <select className="input" {...register('providerConnectionId', { required: true })}>
          <option value="">Select a connection…</option>
          {connections.map((c) => (
            <option value={c.id} key={c.id}>
              {c.displayName}
            </option>
          ))}
        </select>
      </label>
      {error && <p className="text-red-400">{error}</p>}
      <div className="flex gap-2">
        <button className="btn btn-primary">Create model</button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
