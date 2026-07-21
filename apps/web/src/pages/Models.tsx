import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Model, type ProviderConnection } from '../api';
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
export function Models() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Model | null>(null);
  const [show, setShow] = useState(false);
  const [rulesModel, setRulesModel] = useState<Model | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; message: string } | null>(null);
  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(null), 2_000);
    return () => window.clearTimeout(timeout);
  }, [notice]);
  const models = useQuery({ queryKey: ['models'], queryFn: () => api<Model[]>('/api/models') });
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
      setShow(false);
      setEditing(null);
      qc.invalidateQueries({ queryKey: ['models'] });
    },
  });
  const del = useMutation({
    mutationFn: (id: string) => api(`/api/models/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['models'] }),
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
            setShow(true);
          }}
        >
          Add model
        </button>
      </div>
      {show && (
        <ModelForm
          initial={editing}
          error={save.error?.message}
          onCancel={() => setShow(false)}
          onSave={(v) => save.mutate(v)}
        />
      )}
      {rulesModel && <ThinkingRules model={rulesModel} onClose={() => setRulesModel(null)} />}
      <div className="grid gap-4">
        {models.data?.map((m) => (
          <div className="card flex flex-col gap-4 lg:flex-row lg:items-center" key={m.id}>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h2 className="font-medium">{m.displayName}</h2>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs ${m.enabled ? 'bg-emerald-950 text-emerald-300' : 'bg-zinc-800 text-zinc-400'}`}
                >
                  {m.enabled ? 'Enabled' : 'Disabled'}
                </span>
                {m.latestTestStatus && (
                  <span className="text-xs text-zinc-400">Health: {m.latestTestStatus}</span>
                )}
              </div>
              <p className="mt-1 truncate font-mono text-sm text-indigo-300">{m.gatewayModelId}</p>
              <p className="muted truncate">
                {m.providerConnectionName} · {m.apiFormat.replace('_', ' ')} · {m.upstreamModelId}
              </p>
              <div className="mt-2 flex flex-wrap gap-1">
                {['Images', 'Reasoning'].map((k) => (
                  <span className="rounded bg-zinc-800 px-2 py-1 text-xs" key={k}>
                    {k}: {m[`supports${k}` as keyof Model] as string}
                  </span>
                ))}
              </div>
            </div>
            <div className="flex gap-2">
              <button
                className="btn"
                disabled={testingId === m.id}
                onClick={() => test.mutate(m.id)}
              >
                {testingId === m.id ? 'Testing…' : 'Test'}
              </button>
              <button
                className="btn"
                onClick={() => {
                  setEditing(m);
                  setShow(true);
                }}
              >
                Edit
              </button>
              {m.apiFormat === 'openai_compatible' && (
                <button className="btn" onClick={() => setRulesModel(m)}>
                  Rules
                </button>
              )}
              <button
                className="btn btn-danger"
                onClick={() =>
                  confirm('Delete this model? It will also be removed from mappings.') &&
                  del.mutate(m.id)
                }
              >
                Delete
              </button>
            </div>
          </div>
        ))}
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
    <form className="card mb-6 grid gap-4 md:grid-cols-2" onSubmit={handleSubmit(onSave)}>
      <h2 className="md:col-span-2 text-lg font-medium">{initial ? 'Edit model' : 'Add model'}</h2>
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
