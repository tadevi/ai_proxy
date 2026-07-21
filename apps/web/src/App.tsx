import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import { Auth } from './pages/Auth';
import { Models } from './pages/Models';
import { Connections } from './pages/Connections';
import { Mappings } from './pages/Mappings';
import { Logs } from './pages/Logs';
import { Setup } from './pages/Setup';
import { Account } from './pages/Account';
const pages = ['Connections', 'Models', 'Mappings', 'Logs', 'Setup', 'Account'] as const;
type Page = (typeof pages)[number];
export function App() {
  const [page, setPage] = useState<Page>('Models');
  const qc = useQueryClient();
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api<{ id: string; username: string }>('/api/me'),
  });
  const logout = useMutation({
    mutationFn: () => api('/api/auth/logout', { method: 'POST' }),
    onSuccess: () => qc.setQueryData(['me'], null),
  });
  if (me.isLoading) return <Center>Loading…</Center>;
  if (!me.data) return <Auth onSuccess={() => qc.invalidateQueries({ queryKey: ['me'] })} />;
  return (
    <div className="min-h-screen">
      <header className="border-b border-zinc-800">
        <div className="mx-auto flex max-w-7xl items-center gap-2 px-4 py-3">
          <div className="mr-6 font-semibold">Passthrough</div>
          <nav className="flex flex-1 gap-1 overflow-x-auto">
            {pages.map((p) => (
              <button
                className={`rounded-lg px-3 py-2 text-sm ${page === p ? 'bg-zinc-800' : 'text-zinc-400 hover:text-white'}`}
                onClick={() => setPage(p)}
                key={p}
              >
                {p}
              </button>
            ))}
          </nav>
          <span className="hidden text-sm text-zinc-400 sm:block">{me.data.username}</span>
          <button className="btn" onClick={() => logout.mutate()}>
            Log out
          </button>
        </div>
      </header>
      <main className="mx-auto max-w-7xl p-4 sm:p-8">
        {page === 'Connections' ? (
          <Connections />
        ) : page === 'Models' ? (
          <Models />
        ) : page === 'Mappings' ? (
          <Mappings />
        ) : page === 'Logs' ? (
          <Logs />
        ) : page === 'Setup' ? (
          <Setup />
        ) : (
          <Account username={me.data.username} />
        )}
      </main>
    </div>
  );
}
function Center({ children }: { children: React.ReactNode }) {
  return <div className="grid min-h-screen place-items-center">{children}</div>;
}
