import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import { Auth } from './pages/Auth';
import { Connections } from './pages/Connections';
import { Models } from './pages/Models';
import { Presets } from './pages/Presets';
import { Mappings } from './pages/Mappings';
import { Playground } from './pages/Playground';
import { Logs } from './pages/Logs';
import { Setup } from './pages/Setup';
import { Account } from './pages/Account';
const pages = [
  { name: 'Connections', path: '/connections' },
  { name: 'Models', path: '/models' },
  { name: 'Presets', path: '/presets' },
  { name: 'Mappings', path: '/mappings' },
  { name: 'Playground', path: '/playground' },
  { name: 'Logs', path: '/logs' },
  { name: 'Setup', path: '/setup' },
  { name: 'Account', path: '/account' },
] as const;
type Page = (typeof pages)[number]['name'];

function pageFromPath(pathname: string): Page {
  return pages.find((page) => page.path === pathname)?.name ?? 'Connections';
}

export function App() {
  const [page, setPage] = useState<Page>(() => pageFromPath(window.location.pathname));
  const qc = useQueryClient();
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api<{ id: string; username: string }>('/api/me'),
  });
  const logout = useMutation({
    mutationFn: () => api('/api/auth/logout', { method: 'POST' }),
    onSuccess: () => qc.setQueryData(['me'], null),
  });
  useEffect(() => {
    const onPopState = () => setPage(pageFromPath(window.location.pathname));
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);
  const navigate = (next: (typeof pages)[number]) => {
    if (next.name === page) return;
    window.history.pushState(null, '', next.path);
    setPage(next.name);
  };
  if (me.isLoading) return <Center>Loading…</Center>;
  if (!me.data) return <Auth onSuccess={() => qc.invalidateQueries({ queryKey: ['me'] })} />;
  return (
    <div className="min-h-screen">
      <header className="border-b border-zinc-800">
        <div className="mx-auto flex max-w-7xl items-center gap-2 px-4 py-3">
          <div className="mr-6 font-semibold">Passthrough</div>
          <nav className="flex flex-1 gap-1 overflow-x-auto">
            {pages.map((item) => (
              <button
                className={`rounded-lg px-3 py-2 text-sm ${page === item.name ? 'bg-zinc-800' : 'text-zinc-400 hover:text-white'}`}
                onClick={() => navigate(item)}
                key={item.name}
              >
                {item.name}
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
        ) : page === 'Presets' ? (
          <Presets />
        ) : page === 'Mappings' ? (
          <Mappings />
        ) : page === 'Playground' ? (
          <Playground />
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
