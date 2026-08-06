import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  type CliproxyAccount,
  type ProviderConnection,
  type ConnectionToken,
  type ModelBinding,
  type Preset,
} from '../api';
import { latestErrorMessage } from '../format';
import { Modal, useModalId } from '../Modal';

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

  const selectedConnection = connections.data?.find(
    (connection) => connection.id === showBindPreset,
  );

  const modalTokens = useQuery({
    queryKey: ['tokens', showBindPreset],
    queryFn: () => api<ConnectionToken[]>(`/api/connections/${showBindPreset}/tokens`),
    enabled: !!showBindPreset && !selectedConnection?.isCliproxy,
  });

  const modalBindings = useQuery({
    queryKey: ['bindings', showBindPreset],
    queryFn: () => api<ModelBinding[]>(`/api/connections/${showBindPreset}/bindings`),
    enabled: !!showBindPreset,
  });

  const presets = useQuery({
    queryKey: ['presets'],
    queryFn: () => api<Preset[]>('/api/presets'),
  });

  const cliproxyAccounts = useQuery({
    queryKey: ['cliproxy-accounts'],
    queryFn: () => api<CliproxyAccount[]>('/api/cliproxy/accounts'),
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
      setExpandedId(null);
      qc.invalidateQueries({ queryKey: ['connections'] });
      qc.invalidateQueries({ queryKey: ['models'] });
      qc.invalidateQueries({ queryKey: ['mappings'] });
    },
  });

  const toggleConnection = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api(`/api/connections/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['connections'] });
      qc.invalidateQueries({ queryKey: ['models'] });
    },
  });

  const addToken = useMutation({
    mutationFn: ({
      connectionId,
      name,
      apiKey,
    }: {
      connectionId: string;
      name: string;
      apiKey: string;
    }) =>
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
      cliproxyAccountId,
    }: {
      connectionId: string;
      presetIds: string[];
      apiFormat?: string;
      providerBasePath?: string;
      cliproxyAccountId?: string;
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
          ...(cliproxyAccountId ? { cliproxyAccountId } : {}),
        }),
      });
      if (result.failed.length)
        throw new Error(
          `${result.failed.length}/${presetIds.length} binding(s) failed: ${result.failed
            .map((failure) => failure.error)
            .join('; ')}`,
        );
      return result;
    },
    onSuccess: () => setShowBindPreset(null),
    onSettled: (_data, _error, variables) => {
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
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Provider connections</h1>
          <p className="muted mt-1">
            Connections hold base URLs, tokens, and preset bindings. See the Models tab for
            per-token instance status.
          </p>
        </div>
        <button
          className="btn btn-primary shrink-0"
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
          onCancel={() => {
            setShowForm(false);
            setEditing(null);
          }}
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
          bindings={modalBindings.data ?? []}
          cliproxyAccounts={cliproxyAccounts.data ?? []}
          requiresCliproxyAccount={selectedConnection?.isCliproxy ?? false}
          tokenCount={selectedConnection?.isCliproxy ? 0 : (modalTokens.data?.length ?? 0)}
          error={addBindings.error?.message}
          isPending={addBindings.isPending}
          onCancel={() => setShowBindPreset(null)}
          onBind={(presetIds, apiFormat, providerBasePath, cliproxyAccountId) =>
            addBindings.mutate({
              connectionId: showBindPreset,
              presetIds,
              apiFormat,
              providerBasePath,
              cliproxyAccountId,
            })
          }
        />
      )}

      <div className="grid gap-3">
        {connections.data?.map((connection) => (
          <ConnectionCard
            connection={connection}
            expanded={expandedId === connection.id}
            key={connection.id}
            onAddToken={() => setShowAddToken(connection.id)}
            onBindPreset={() => setShowBindPreset(connection.id)}
            onDelete={() =>
              confirm(
                `Delete "${connection.displayName}"? This also permanently deletes all tokens, bindings, and model instances.`,
              ) && deleteConnection.mutate(connection.id)
            }
            onDeleteBinding={(binding) =>
              confirm(
                `Unbind "${binding.presetDisplayName}" from this connection? This will remove all associated model instances.`,
              ) &&
              deleteBinding.mutate({ connectionId: connection.id, bindingId: binding.id })
            }
            onDeleteToken={(token) =>
              confirm(`Delete token "${token.name}"?`) &&
              deleteToken.mutate({ connectionId: connection.id, tokenId: token.id })
            }
            onEdit={() => {
              setEditing(connection);
              setShowForm(true);
            }}
            onToggle={() =>
              toggleConnection.mutate({ id: connection.id, enabled: !connection.enabled })
            }
            onToggleExpanded={() =>
              setExpandedId((current) => (current === connection.id ? null : connection.id))
            }
            onToggleToken={(token) =>
              toggleToken.mutate({
                connectionId: connection.id,
                tokenId: token.id,
                enabled: !token.enabled,
              })
            }
            tokenTogglePending={toggleToken.isPending}
          />
        ))}
        {connections.data?.length === 0 && (
          <div className="card text-center text-zinc-400">
            Add a provider connection to get started.
          </div>
        )}
      </div>
    </>
  );
}

function ConnectionCard({
  connection,
  expanded,
  onToggle,
  onEdit,
  onDelete,
  onToggleExpanded,
  onAddToken,
  onBindPreset,
  onDeleteToken,
  onToggleToken,
  onDeleteBinding,
  tokenTogglePending,
}: {
  connection: ProviderConnection;
  expanded: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onToggleExpanded: () => void;
  onAddToken: () => void;
  onBindPreset: () => void;
  onDeleteToken: (token: ConnectionToken) => void;
  onToggleToken: (token: ConnectionToken) => void;
  onDeleteBinding: (binding: ModelBinding) => void;
  tokenTogglePending: boolean;
}) {
  const tokens = useQuery({
    queryKey: ['tokens', connection.id],
    queryFn: () => api<ConnectionToken[]>(`/api/connections/${connection.id}/tokens`),
    enabled: !connection.isCliproxy,
    staleTime: 30_000,
  });

  const bindings = useQuery({
    queryKey: ['bindings', connection.id],
    queryFn: () => api<ModelBinding[]>(`/api/connections/${connection.id}/bindings`),
    staleTime: 30_000,
  });

  const tokenCount = connection.isCliproxy ? 0 : (tokens.data?.length ?? 0);
  const bindingCount = bindings.data?.length ?? 0;

  return (
    <article className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/70 shadow-sm">
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3.5">
        <Switch
          checked={connection.enabled}
          label={`${connection.enabled ? 'Disable' : 'Enable'} ${connection.displayName}`}
          onClick={onToggle}
        />

        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate font-semibold">{connection.displayName}</h2>
            {!connection.isCliproxy && <CountPill count={tokenCount} singular="token" />}
            <CountPill count={bindingCount} singular="binding" />
          </div>
          <a
            className="mt-0.5 block truncate text-sm text-zinc-400 underline decoration-zinc-700 underline-offset-2 hover:text-zinc-300"
            href={connection.baseUrl}
            rel="noopener noreferrer"
            target="_blank"
          >
            {connection.baseUrl}
          </a>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <button className="btn h-8 px-2.5 text-xs" onClick={onEdit} title="Edit connection">
            <span className="hidden sm:inline">Edit</span>
            <span aria-hidden className="sm:hidden">✎</span>
          </button>
          <button
            className="btn btn-danger h-8 px-2.5 text-xs"
            onClick={onDelete}
            title="Delete connection"
          >
            <span className="hidden sm:inline">Delete</span>
            <span aria-hidden className="sm:hidden">×</span>
          </button>
          <button
            aria-expanded={expanded}
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${connection.displayName}`}
            className="btn h-8 w-8 px-0 text-sm text-zinc-300"
            onClick={onToggleExpanded}
            title={expanded ? 'Collapse details' : 'Expand details'}
          >
            <span className={`transition-transform ${expanded ? 'rotate-180' : ''}`}>⌄</span>
          </button>
        </div>
      </div>

      {expanded && (
        <div className="space-y-4 border-t border-zinc-800 bg-zinc-950/45 px-4 py-3.5">
          {!connection.isCliproxy && (
            <CompactSection title="Tokens" action="+ Add token" onAction={onAddToken}>
              <div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950">
                {tokens.data?.map((token) => {
                  const cooling =
                    !!token.cooldownUntil && new Date(token.cooldownUntil) > new Date();
                  const errorMessage = latestErrorMessage(token.latestError);
                  return (
                    <div
                      className={`grid min-h-11 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b border-zinc-800/70 px-3 py-2 last:border-b-0 ${!token.enabled ? 'opacity-60' : ''}`}
                      key={token.id}
                    >
                      <Switch
                        checked={token.enabled}
                        compact
                        disabled={tokenTogglePending}
                        label={`${token.enabled ? 'Disable' : 'Enable'} ${token.name}`}
                        onClick={() => onToggleToken(token)}
                      />
                      <div className="min-w-0">
                        <div className="flex min-w-0 items-baseline gap-2">
                          <span className="truncate text-sm font-medium">{token.name}</span>
                          {token.keyPreview && (
                            <span className="truncate font-mono text-xs text-zinc-500">
                              {token.keyPreview}
                            </span>
                          )}
                        </div>
                        {token.enabled && cooling && (
                          <p className="truncate text-xs text-amber-400">
                            Cooling down until {new Date(token.cooldownUntil!).toLocaleTimeString()}
                            {errorMessage ? ` — ${errorMessage}` : ''}
                          </p>
                        )}
                        {!token.enabled && errorMessage && (
                          <p className="truncate text-xs text-red-400">Last error — {errorMessage}</p>
                        )}
                      </div>
                      <button
                        className="btn btn-danger h-7 px-2.5 text-xs"
                        onClick={() => onDeleteToken(token)}
                      >
                        Delete
                      </button>
                    </div>
                  );
                })}
                {tokens.isLoading && (
                  <p className="px-3 py-2.5 text-center text-sm text-zinc-500">Loading tokens…</p>
                )}
                {!tokens.isLoading && tokenCount === 0 && (
                  <p className="px-3 py-2.5 text-center text-sm text-zinc-500">
                    No tokens added yet.
                  </p>
                )}
              </div>
            </CompactSection>
          )}

          <CompactSection title="Model bindings" action="+ Bind preset" onAction={onBindPreset}>
            <div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950">
              {bindings.data?.map((binding) => (
                <div
                  className="grid min-h-11 grid-cols-[minmax(0,1.6fr)_minmax(0,1.2fr)_auto] items-center gap-3 border-b border-zinc-800/70 px-3 py-2 last:border-b-0 md:grid-cols-[minmax(0,1.6fr)_minmax(0,1.2fr)_minmax(5rem,.65fr)_minmax(4rem,.5fr)_auto]"
                  key={binding.id}
                >
                  <span className="truncate text-sm font-medium" title={binding.presetDisplayName}>
                    {binding.presetDisplayName}
                  </span>
                  <span
                    className="truncate font-mono text-xs text-zinc-500"
                    title={binding.presetUpstreamModelId}
                  >
                    {binding.presetUpstreamModelId}
                  </span>
                  <span className="hidden truncate text-xs text-zinc-500 md:block">
                    {binding.apiFormat === 'anthropic_compatible' ? 'Anthropic' : 'OpenAI'}
                  </span>
                  <span className="hidden truncate font-mono text-xs text-zinc-500 md:block">
                    {binding.providerBasePath || '—'}
                  </span>
                  <button
                    className="btn btn-danger h-7 px-2.5 text-xs"
                    onClick={() => onDeleteBinding(binding)}
                  >
                    Unbind
                  </button>
                </div>
              ))}
              {bindings.isLoading && (
                <p className="px-3 py-2.5 text-center text-sm text-zinc-500">Loading bindings…</p>
              )}
              {!bindings.isLoading && bindingCount === 0 && (
                <p className="px-3 py-2.5 text-center text-sm text-zinc-500">No bindings yet.</p>
              )}
            </div>
          </CompactSection>
        </div>
      )}
    </article>
  );
}

function CountPill({ count, singular }: { count: number; singular: string }) {
  return (
    <span className="rounded-full border border-zinc-700 bg-zinc-800/70 px-2 py-0.5 text-xs text-zinc-300">
      {count} {singular}
      {count === 1 ? '' : 's'}
    </span>
  );
}

function CompactSection({
  title,
  action,
  onAction,
  children,
}: {
  title: string;
  action: string;
  onAction: () => void;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-zinc-400">{title}</h3>
        <button className="text-xs font-medium text-indigo-400 hover:text-indigo-300" onClick={onAction}>
          {action}
        </button>
      </div>
      {children}
    </section>
  );
}

function Switch({
  checked,
  label,
  onClick,
  compact = false,
  disabled = false,
}: {
  checked: boolean;
  label: string;
  onClick: () => void;
  compact?: boolean;
  disabled?: boolean;
}) {
  const track = compact ? 'h-4 w-7' : 'h-5 w-9';
  const knob = compact ? 'h-3 w-3' : 'h-4 w-4';
  const translate = compact ? 'translate-x-3' : 'translate-x-4';
  return (
    <button
      aria-checked={checked}
      aria-label={label}
      className={`relative shrink-0 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 ${track} ${checked ? 'bg-emerald-500/80' : 'bg-zinc-700'}`}
      disabled={disabled}
      onClick={onClick}
      role="switch"
      type="button"
    >
      <span
        className={`absolute left-0.5 top-0.5 rounded-full bg-zinc-100 shadow-sm transition-transform ${knob} ${checked ? translate : 'translate-x-0'}`}
      />
    </button>
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
  const titleId = useModalId();
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
    <Modal titleId={titleId} onClose={onCancel} maxWidth="max-w-2xl">
      <form
        autoComplete="off"
        className="grid gap-4 md:grid-cols-2"
        onSubmit={handleSubmit(onSave)}
      >
        <h2 className="text-lg font-medium md:col-span-2" id={titleId}>
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
    </Modal>
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
  const titleId = useModalId();
  const { register, handleSubmit } = useForm<TokenForm>({ defaultValues: tokenDefaults });
  return (
    <Modal titleId={titleId} onClose={onCancel} maxWidth="max-w-md">
      <h2 className="text-lg font-medium" id={titleId}>
        Add token
      </h2>
      <p className="muted mt-1">API keys are stored encrypted and never shown after creation.</p>
      <form className="mt-4 grid gap-4" onSubmit={handleSubmit((value) => onAdd(value.name, value.apiKey))}>
        <label>
          <span className="label">Token name</span>
          <input
            className="input"
            {...register('name', { required: true })}
            placeholder="e.g. Primary, Backup"
          />
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
    </Modal>
  );
}

function BindPresetModal({
  presets,
  bindings,
  cliproxyAccounts,
  requiresCliproxyAccount,
  tokenCount,
  error,
  isPending,
  onCancel,
  onBind,
}: {
  presets: Preset[];
  bindings: ModelBinding[];
  cliproxyAccounts: CliproxyAccount[];
  requiresCliproxyAccount: boolean;
  tokenCount: number;
  error?: string;
  isPending: boolean;
  onCancel: () => void;
  onBind: (
    presetIds: string[],
    apiFormat: string,
    providerBasePath: string,
    cliproxyAccountId?: string,
  ) => void;
}) {
  const titleId = useModalId();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [apiFormat, setApiFormat] = useState('');
  const [providerBasePath, setProviderBasePath] = useState('');
  const [cliproxyAccountId, setCliproxyAccountId] = useState('');
  const selectedCliproxyAccount = cliproxyAccounts.find(
    (account) => account.id === cliproxyAccountId,
  );
  const available = presets.filter((preset) => {
    const presetProvider = preset.displayName.split('/')[0]?.trim().toLowerCase();
    const providerMatches =
      !selectedCliproxyAccount || presetProvider === selectedCliproxyAccount.provider;
    return (
      providerMatches &&
      !bindings.some(
        (binding) =>
          binding.presetId === preset.id && (binding.cliproxyAccountId ?? '') === cliproxyAccountId,
      )
    );
  });
  const allSelected = available.length > 0 && selected.size === available.length;

  function toggle(id: string) {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <Modal titleId={titleId} onClose={onCancel} maxWidth="max-w-lg">
      <h2 className="text-lg font-medium" id={titleId}>
        Bind presets
      </h2>
      <p className="muted mt-1">
        Link one or more model presets to this connection. This will create model instances
        automatically.
      </p>
      <form
        className="mt-4 grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (selected.size)
            onBind([...selected], apiFormat, providerBasePath, cliproxyAccountId || undefined);
        }}
      >
        {(requiresCliproxyAccount || cliproxyAccounts.length > 0) && (
          <label>
            <span className="label">CLIProxy account</span>
            <select
              className="input"
              onChange={(event) => {
                setCliproxyAccountId(event.target.value);
                setSelected(new Set());
              }}
              value={cliproxyAccountId}
            >
              <option value="">
                {requiresCliproxyAccount ? 'Select an account…' : 'No CLIProxy account'}
              </option>
              {cliproxyAccounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.provider} · {account.label ?? account.prefix} · {account.prefix}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-xs text-zinc-500">
              Select the exact auth JSON to use. Required when binding the CLIProxyAPI connection.
            </span>
          </label>
        )}

        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="label">Presets ({selected.size} selected)</span>
            {available.length > 0 && (
              <button
                className="text-xs text-indigo-400 hover:text-indigo-300"
                onClick={() =>
                  setSelected(allSelected ? new Set() : new Set(available.map((preset) => preset.id)))
                }
                type="button"
              >
                {allSelected ? 'Deselect all' : 'Select all'}
              </button>
            )}
          </div>
          <div className="max-h-64 overflow-y-auto rounded-lg border border-zinc-800">
            {available.map((preset) => (
              <label
                className="flex cursor-pointer items-center gap-3 border-b border-zinc-800/60 px-3 py-2 last:border-b-0 hover:bg-zinc-800/40"
                key={preset.id}
              >
                <input
                  checked={selected.has(preset.id)}
                  className="shrink-0"
                  onChange={() => toggle(preset.id)}
                  type="checkbox"
                />
                <span className="min-w-0 flex-1 truncate text-sm">{preset.displayName}</span>
                <span className="shrink-0 font-mono text-xs text-zinc-500">
                  {preset.upstreamModelId}
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
          <select className="input" onChange={(event) => setApiFormat(event.target.value)} value={apiFormat}>
            <option value="">No override — use each preset's own format</option>
            <option value="openai_compatible">OpenAI compatible</option>
            <option value="anthropic_compatible">Anthropic compatible</option>
          </select>
        </label>

        <label>
          <span className="label">Base path (optional)</span>
          <input
            className="input"
            onChange={(event) => setProviderBasePath(event.target.value)}
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
        {tokenCount === 0 && !requiresCliproxyAccount && (
          <p className="text-sm text-amber-400">
            No tokens on this connection. Add a token first to create instances.
          </p>
        )}
        {requiresCliproxyAccount && !cliproxyAccountId && (
          <p className="text-sm text-amber-400">Select a CLIProxy account before binding presets.</p>
        )}
        {error && <p className="text-red-400">{error}</p>}

        <div className="flex gap-2">
          <button
            className="btn btn-primary"
            disabled={!selected.size || isPending || (requiresCliproxyAccount && !cliproxyAccountId)}
          >
            {isPending ? 'Binding…' : `Bind${selected.size ? ` (${selected.size})` : ''}`}
          </button>
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}
