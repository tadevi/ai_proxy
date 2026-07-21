import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
type SetupData = { baseUrl: string; aliases: Record<string, boolean> };
export function Setup() {
  const setup = useQuery({ queryKey: ['setup'], queryFn: () => api<SetupData>('/api/setup') });
  const config = `export ANTHROPIC_BASE_URL="${setup.data?.baseUrl ?? '<gateway-url>'}"\nexport ANTHROPIC_AUTH_TOKEN="<gateway-api-key>"\n\nexport ANTHROPIC_DEFAULT_HAIKU_MODEL="haiku"\nexport ANTHROPIC_DEFAULT_SONNET_MODEL="sonnet"\nexport ANTHROPIC_DEFAULT_OPUS_MODEL="opus"`;
  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">Setup</h1>
        <p className="muted mt-1">Connect Claude Code without exposing provider credentials.</p>
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <section className="card">
          <div className="flex justify-between">
            <h2 className="font-medium">Claude Code environment</h2>
            <button className="btn" onClick={() => navigator.clipboard.writeText(config)}>
              Copy
            </button>
          </div>
          <pre className="mt-4 overflow-x-auto rounded-lg bg-zinc-950 p-4 text-sm text-indigo-200">
            {config}
          </pre>
        </section>
        <section className="card">
          <h2 className="font-medium">Configuration status</h2>
          <div className="mt-4 space-y-3">
            {Object.entries(setup.data?.aliases ?? {}).map(([name, ok]) => (
              <div className="flex justify-between" key={name}>
                <span className="capitalize">{name}</span>
                <span className={ok ? 'text-emerald-400' : 'text-amber-400'}>
                  {ok ? 'Ready' : 'No active routes'}
                </span>
              </div>
            ))}
          </div>
          <h2 className="mt-6 font-medium">Basic request</h2>
          <pre className="mt-3 overflow-x-auto rounded-lg bg-zinc-950 p-4 text-xs">{`curl ${setup.data?.baseUrl ?? '<url>'}/v1/messages \\\n  -H 'Authorization: Bearer gw_...' \\\n  -H 'content-type: application/json' \\\n  -d '{"model":"sonnet","max_tokens":100,"messages":[{"role":"user","content":"Hello"}]}'`}</pre>
        </section>
      </div>
    </>
  );
}
