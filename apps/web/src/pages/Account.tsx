import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type CliproxyAccount } from '../api';
type Key = {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
};
export function Account({ username }: { username: string }) {
  const qc = useQueryClient();
  const [name, setName] = useState('Claude Code');
  const [secret, setSecret] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const keys = useQuery({ queryKey: ['keys'], queryFn: () => api<Key[]>('/api/keys') });
  const create = useMutation({
    mutationFn: () =>
      api<Key & { key: string }>('/api/keys', { method: 'POST', body: JSON.stringify({ name }) }),
    onSuccess: (k) => {
      setSecret(k.key);
      qc.invalidateQueries({ queryKey: ['keys'] });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/api/keys/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['keys'] }),
  });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const accounts = useQuery({
    queryKey: ['cliproxy-accounts'],
    queryFn: () => api<CliproxyAccount[]>('/api/cliproxy/accounts'),
  });
  const uploadAccount = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append('file', file);
      const response = await fetch('/api/cliproxy/accounts', { method: 'POST', body: form });
      const body = await response.json().catch(() => ({}));
      if (!response.ok)
        throw new Error(
          (body as { error?: string }).error ?? `Request failed (${response.status})`,
        );
      return body as CliproxyAccount;
    },
    onSuccess: () => {
      if (fileInputRef.current) fileInputRef.current.value = '';
      qc.invalidateQueries({ queryKey: ['cliproxy-accounts'] });
    },
  });
  const removeAccount = useMutation({
    mutationFn: (id: string) => api(`/api/cliproxy/accounts/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cliproxy-accounts'] }),
  });
  const changePassword = useMutation({
    mutationFn: () =>
      api('/api/account/password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword, newPassword }),
      }),
    onSuccess: () => {
      window.location.reload();
    },
  });
  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">Account</h1>
        <p className="muted mt-1">Signed in as {username}.</p>
      </div>
      {secret && (
        <div className="mb-6 rounded-xl border border-amber-800 bg-amber-950/30 p-5">
          <h2 className="font-medium text-amber-200">
            Copy this key now—it will not be shown again.
          </h2>
          <div className="mt-3 flex gap-2">
            <code className="min-w-0 flex-1 overflow-x-auto rounded bg-black p-3 text-amber-100">
              {secret}
            </code>
            <button className="btn" onClick={() => navigator.clipboard.writeText(secret)}>
              Copy
            </button>
          </div>
        </div>
      )}
      <section className="card mb-6 max-w-xl">
        <h2 className="font-medium">Change password</h2>
        <p className="muted mt-1">You will be signed out after a successful change.</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label>
            <span className="label">Current password</span>
            <input
              className="input"
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
            />
          </label>
          <label>
            <span className="label">New password</span>
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              minLength={6}
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
            />
          </label>
        </div>
        {changePassword.error && (
          <p className="mt-3 text-sm text-red-400">{changePassword.error.message}</p>
        )}
        <button
          className="btn btn-primary mt-4"
          disabled={!currentPassword || newPassword.length < 6 || changePassword.isPending}
          onClick={() => changePassword.mutate()}
        >
          Change password
        </button>
      </section>
      <section className="card">
        <h2 className="font-medium">Gateway API keys</h2>
        <div className="my-4 flex max-w-md gap-2">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          <button className="btn btn-primary" onClick={() => create.mutate()}>
            Create
          </button>
        </div>
        <div className="divide-y divide-zinc-800">
          {keys.data?.map((k) => (
            <div className="flex items-center gap-3 py-3" key={k.id}>
              <div className="flex-1">
                <div>
                  {k.name} {k.revokedAt && <span className="text-xs text-red-400">revoked</span>}
                </div>
                <div className="font-mono text-xs text-zinc-500">
                  {k.prefix}… · created {new Date(k.createdAt).toLocaleDateString()}
                </div>
              </div>
              {!k.revokedAt && (
                <button className="btn btn-danger" onClick={() => revoke.mutate(k.id)}>
                  Revoke
                </button>
              )}
            </div>
          ))}
        </div>
      </section>
      <section className="card mt-6">
        <h2 className="font-medium">Connected accounts</h2>
        <p className="muted mt-1">
          Upload a Codex/Claude/Gemini OAuth auth file to route requests through your own
          account via CLIProxyAPI.
        </p>
        {accounts.error ? (
          <p className="mt-4 text-sm text-zinc-500">{accounts.error.message}</p>
        ) : (
          <>
            <div className="my-4 flex max-w-md gap-2">
              <input
                ref={fileInputRef}
                accept=".json"
                className="input"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) uploadAccount.mutate(file);
                }}
                type="file"
              />
            </div>
            {uploadAccount.isPending && <p className="text-sm text-zinc-400">Uploading…</p>}
            {uploadAccount.error && (
              <p className="text-sm text-red-400">{uploadAccount.error.message}</p>
            )}
            <div className="divide-y divide-zinc-800">
              {accounts.data?.map((a) => (
                <div className="flex items-center gap-3 py-3" key={a.id}>
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="rounded-full border border-zinc-700 px-2 py-0.5 text-xs text-zinc-400 capitalize">
                        {a.provider}
                      </span>
                      {a.label && <span>{a.label}</span>}
                    </div>
                    <div className="font-mono text-xs text-zinc-500">
                      {a.prefix} · created {new Date(a.createdAt).toLocaleDateString()}
                    </div>
                  </div>
                  <button className="btn btn-danger" onClick={() => removeAccount.mutate(a.id)}>
                    Remove
                  </button>
                </div>
              ))}
              {accounts.data?.length === 0 && (
                <p className="py-3 text-center text-sm text-zinc-500">No accounts connected.</p>
              )}
            </div>
          </>
        )}
      </section>
    </>
  );
}
