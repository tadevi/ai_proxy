import { useForm } from 'react-hook-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type ProviderConnection } from '../api';

type Form = {
  displayName: string;
  baseUrl: string;
  apiKey: string;
  enabled: boolean;
};

const defaults: Form = {
  displayName: '',
  baseUrl: '',
  apiKey: '',
  enabled: true,
};

export function Connections() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<ProviderConnection | null>(null);
  const [showForm, setShowForm] = useState(false);
  const connections = useQuery({
    queryKey: ['connections'],
    queryFn: () => api<ProviderConnection[]>('/api/connections'),
  });
  const save = useMutation({
    mutationFn: (form: Form) =>
      api(`/api/connections${editing ? `/${editing.id}` : ''}`, {
        method: editing ? 'PATCH' : 'POST',
        body: JSON.stringify({
          ...form,
          apiKey: form.apiKey || undefined,
        }),
      }),
    onSuccess: () => {
      setShowForm(false);
      setEditing(null);
      queryClient.invalidateQueries({ queryKey: ['connections'] });
      queryClient.invalidateQueries({ queryKey: ['models'] });
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/connections/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['connections'] });
      queryClient.invalidateQueries({ queryKey: ['models'] });
      queryClient.invalidateQueries({ queryKey: ['mappings'] });
    },
  });
  return (
    <>
      <div className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Provider connections</h1>
          <p className="muted mt-1">
            Base URL and encrypted API key, shared by one or more models.
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
        <ConnectionForm
          initial={editing}
          error={save.error?.message}
          onCancel={() => setShowForm(false)}
          onSave={(form) => save.mutate(form)}
        />
      )}
      <div className="grid gap-4">
        {connections.data?.map((connection) => (
          <div className="card flex flex-col gap-4 lg:flex-row lg:items-center" key={connection.id}>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h2 className="font-medium">{connection.displayName}</h2>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs ${connection.enabled ? 'bg-emerald-950 text-emerald-300' : 'bg-zinc-800 text-zinc-400'}`}
                >
                  {connection.enabled ? 'Enabled' : 'Disabled'}
                </span>
              </div>
              <p className="muted mt-1 truncate">{connection.baseUrl}</p>
            </div>
            <div className="flex gap-2">
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
                    `Delete “${connection.displayName}”? This also permanently deletes all of its models and removes them from mappings.`,
                  ) && remove.mutate(connection.id)
                }
              >
                Delete
              </button>
            </div>
          </div>
        ))}
        {connections.data?.length === 0 && (
          <div className="card text-center text-zinc-400">
            Add a provider connection before adding models.
          </div>
        )}
      </div>
    </>
  );
}

function ConnectionForm({
  initial,
  onSave,
  onCancel,
  error,
}: {
  initial: ProviderConnection | null;
  onSave: (form: Form) => void;
  onCancel: () => void;
  error?: string;
}) {
  const { register, handleSubmit } = useForm<Form>({
    defaultValues: initial
      ? {
          ...defaults,
          ...initial,
          apiKey: '',
        }
      : defaults,
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
      <label>
        <span className="label">
          {initial ? 'Replace API key (leave blank to retain)' : 'API key'}
        </span>
        <input
          autoComplete="new-password"
          className="input"
          spellCheck={false}
          type="password"
          {...register('apiKey', { required: !initial })}
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
