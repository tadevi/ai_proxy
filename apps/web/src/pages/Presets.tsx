import { useMemo, useState } from 'react';
import { Search, Trash2 } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Preset } from '../api';
import { Modal, useModalId } from '../Modal';

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
  const [query, setQuery] = useState('');
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

  const filteredPresets = useMemo(() => {
    const value = query.trim().toLowerCase();
    if (!value) return presets.data ?? [];
    return (presets.data ?? []).filter((preset) =>
      [preset.displayName, preset.upstreamModelId, preset.apiFormat]
        .join(' ')
        .toLowerCase()
        .includes(value),
    );
  }, [presets.data, query]);

  return (
    <>
      <div className="mb-5 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Model presets</h1>
          <p className="muted mt-1">
            Pre-configured model definitions. Bind presets to connections from the Connections page.
          </p>
        </div>
        <button className="btn btn-primary shrink-0" onClick={() => setShowForm(true)}>
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

      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-sm">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-zinc-500"
            size={16}
          />
          <input
            aria-label="Search presets"
            className="input pl-9"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search presets or model IDs…"
            value={query}
          />
        </div>
        <span className="text-xs text-zinc-500">
          {filteredPresets.length} of {presets.data?.length ?? 0} presets
        </span>
      </div>

      <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/40">
        {filteredPresets.map((preset, index) => {
          const isSystem = preset.userId === null;
          return (
            <div
              className={`group flex min-w-0 items-center gap-4 px-4 py-3.5 sm:px-5 ${
                index > 0 ? 'border-t border-zinc-800' : ''
              }`}
              key={preset.id}
            >
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <h2 className="truncate text-sm font-semibold text-zinc-100">
                    {preset.displayName}
                  </h2>
                  {isSystem && (
                    <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-400">
                      System
                    </span>
                  )}
                  <span
                    className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                      preset.apiFormat === 'anthropic_compatible'
                        ? 'bg-indigo-950 text-indigo-300'
                        : 'bg-sky-950 text-sky-300'
                    }`}
                  >
                    {preset.apiFormat === 'anthropic_compatible' ? 'Anthropic' : 'OpenAI'}
                  </span>
                  {preset.supportsReasoning === 'yes' && (
                    <span className="rounded-full border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-400">
                      Reasoning
                    </span>
                  )}
                  {preset.supportsImages === 'yes' && (
                    <span className="rounded-full border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-400">
                      Images
                    </span>
                  )}
                  {preset.maxOutputTokens && (
                    <span className="rounded-full border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-400">
                      Max {preset.maxOutputTokens.toLocaleString()}
                    </span>
                  )}
                </div>
                <p className="mt-1 truncate font-mono text-xs text-zinc-500">
                  {preset.upstreamModelId}
                </p>
              </div>

              {!isSystem && (
                <button
                  aria-label={`Delete ${preset.displayName}`}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-zinc-600 transition hover:bg-red-950/50 hover:text-red-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
                  disabled={remove.isPending}
                  onClick={() =>
                    confirm(`Delete preset \"${preset.displayName}\"?`) && remove.mutate(preset.id)
                  }
                  title="Delete preset"
                  type="button"
                >
                  <Trash2 size={16} />
                </button>
              )}
            </div>
          );
        })}

        {!presets.isLoading && filteredPresets.length === 0 && (
          <div className="px-5 py-10 text-center text-sm text-zinc-500">
            {presets.data?.length ? 'No presets match your search.' : 'No presets available.'}
          </div>
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
  const titleId = useModalId();
  const { register, handleSubmit, watch } = useForm<Form>({ defaultValues: defaults });
  const apiFormat = watch('apiFormat');
  return (
    <Modal titleId={titleId} onClose={onCancel} maxWidth="max-w-2xl">
      <h2 className="text-lg font-medium" id={titleId}>
        Add custom preset
      </h2>
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
    </Modal>
  );
}
