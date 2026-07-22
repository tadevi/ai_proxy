import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Preset } from '../api';

type Form = {
  displayName: string;
  upstreamModelId: string;
  apiFormat: 'openai_compatible' | 'anthropic_compatible';
  supportsImages: 'yes' | 'no';
  supportsReasoning: 'yes' | 'no';
  maxOutputTokens: string;
};

const defaults: Form = {
  displayName: '',
  upstreamModelId: '',
  apiFormat: 'openai_compatible',
  supportsImages: 'no',
  supportsReasoning: 'yes',
  maxOutputTokens: '',
};

export function Presets() {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const presets = useQuery({ queryKey: ['presets'], queryFn: () => api<Preset[]>('/api/presets') });
  const save = useMutation({
    mutationFn: (v: Form) =>
      api('/api/presets', {
        method: 'POST',
        body: JSON.stringify({
          ...v,
          maxOutputTokens: v.maxOutputTokens ? Number(v.maxOutputTokens) : null,
        }),
      }),
    onSuccess: () => {
      setShowForm(false);
      qc.invalidateQueries({ queryKey: ['presets'] });
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/presets/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['presets'] }),
  });
  return (
    <>
      <div className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Model presets</h1>
          <p className="muted mt-1">
            Pre-configured model definitions. Bind presets to connections from the Connections page.
          </p>
        </div>
        <button
          className="btn btn-primary"
          onClick={() => {
            setShowForm(true);
          }}
        >
          Add custom preset
        </button>
      </div>
      {showForm && (
        <PresetFormModal
          error={save.error?.message}
          onCancel={() => setShowForm(false)}
          onSave={(v) => save.mutate(v)}
        />
      )}
      <div className="grid gap-4">
        {presets.data?.map((preset) => {
          const isSystem = preset.userId === null;
          return (
            <div className="card flex flex-col gap-4 lg:flex-row lg:items-start" key={preset.id}>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="font-medium">{preset.displayName}</h2>
                  {isSystem && (
                    <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400">
                      System
                    </span>
                  )}
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${preset.apiFormat === 'anthropic_compatible' ? 'bg-indigo-950 text-indigo-300' : 'bg-sky-950 text-sky-300'}`}
                  >
                    {preset.apiFormat === 'anthropic_compatible' ? 'Anthropic' : 'OpenAI'}
                  </span>
                </div>
                <p className="mt-1 font-mono text-xs text-zinc-400">{preset.upstreamModelId}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {preset.supportsReasoning === 'yes' && (
                    <span className="rounded-full border border-zinc-700 px-2 py-0.5 text-xs text-zinc-400">
                      Reasoning
                    </span>
                  )}
                  {preset.supportsImages === 'yes' && (
                    <span className="rounded-full border border-zinc-700 px-2 py-0.5 text-xs text-zinc-400">
                      Images
                    </span>
                  )}
                  {preset.maxOutputTokens && (
                    <span className="rounded-full border border-zinc-700 px-2 py-0.5 text-xs text-zinc-400">
                      Max output: {preset.maxOutputTokens.toLocaleString()}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex gap-2">
                {!isSystem && (
                  <button
                    className="btn btn-danger"
                    onClick={() =>
                      confirm(`Delete preset "${preset.displayName}"?`) && remove.mutate(preset.id)
                    }
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>
          );
        })}
        {presets.data?.length === 0 && (
          <div className="card text-center text-zinc-400">No presets available.</div>
        )}
      </div>
    </>
  );
}

function PresetFormModal({
  onSave,
  onCancel,
  error,
}: {
  onSave: (v: Form) => void;
  onCancel: () => void;
  error?: string;
}) {
  const { register, handleSubmit, watch } = useForm<Form>({ defaultValues: defaults });
  const apiFormat = watch('apiFormat');
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
      role="presentation"
    >
      <section className="card w-full max-w-2xl" role="dialog" aria-modal="true">
        <h2 className="text-lg font-medium">Add custom preset</h2>
        <form className="mt-4 grid gap-4 md:grid-cols-2" onSubmit={handleSubmit(onSave)}>
          <label>
            <span className="label">Display name</span>
            <input className="input" {...register('displayName', { required: true })} />
          </label>
          <label>
            <span className="label">Upstream model ID</span>
            <input className="input" {...register('upstreamModelId', { required: true })} />
          </label>
          <label>
            <span className="label">API format</span>
            <select className="input" {...register('apiFormat')}>
              <option value="openai_compatible">OpenAI compatible</option>
              <option value="anthropic_compatible">Anthropic compatible</option>
            </select>
          </label>
          <label>
            <span className="label">Max output tokens</span>
            <input
              className="input"
              min="1"
              placeholder="Leave blank for default"
              type="number"
              {...register('maxOutputTokens')}
            />
          </label>
          <section className="md:col-span-2">
            <h3 className="mb-3 text-sm font-medium text-zinc-200">Capabilities</h3>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              {(apiFormat === 'openai_compatible'
                ? (['supportsImages', 'supportsReasoning'] as const)
                : (['supportsImages'] as const)
              ).map((name) => (
                <label key={name}>
                  <span className="label">{name.replace('supports', 'Supports ')}</span>
                  <select className="input" {...register(name)}>
                    <option value="yes">Yes</option>
                    <option value="no">No</option>
                  </select>
                </label>
              ))}
            </div>
          </section>
          {error && <p className="text-red-400 md:col-span-2">{error}</p>}
          <div className="flex gap-2 md:col-span-2">
            <button className="btn btn-primary">Save preset</button>
            <button type="button" className="btn" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
