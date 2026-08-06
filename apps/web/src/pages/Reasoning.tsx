import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';

type ReasoningCodec = 'auto' | 'reasoning_details' | 'reasoning_content';

type ReasoningBinding = {
  id: string;
  connectionId: string;
  connectionName: string;
  presetDisplayName: string;
  presetUpstreamModelId: string;
  apiFormat: 'openai_compatible';
  codec: ReasoningCodec;
};

const labels: Record<ReasoningCodec, string> = {
  auto: 'Auto',
  reasoning_details: 'Reasoning details',
  reasoning_content: 'Reasoning content',
};

export function Reasoning() {
  const qc = useQueryClient();
  const bindings = useQuery({
    queryKey: ['reasoning-bindings'],
    queryFn: () => api<ReasoningBinding[]>('/api/reasoning-bindings'),
  });
  const save = useMutation({
    mutationFn: ({ id, codec }: { id: string; codec: ReasoningCodec }) =>
      api(`/api/reasoning-bindings/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ codec }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['reasoning-bindings'] }),
  });

  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">Reasoning formats</h1>
        <p className="muted mt-1">
          Configure reasoning payload format for external API-key OpenAI-compatible bindings.
          CLIProxy and Anthropic-compatible bindings are intentionally excluded.
        </p>
      </div>

      {bindings.isLoading ? (
        <div className="card p-5">Loading…</div>
      ) : bindings.error ? (
        <div className="card border-red-900/50 p-5 text-red-300">{bindings.error.message}</div>
      ) : !bindings.data?.length ? (
        <div className="card p-5 text-zinc-400">No eligible bindings.</div>
      ) : (
        <div className="card overflow-hidden">
          {bindings.data.map((binding) => (
            <div
              className="flex flex-col gap-3 border-b border-zinc-800 p-4 last:border-b-0 sm:flex-row sm:items-center"
              key={binding.id}
            >
              <div className="min-w-0 flex-1">
                <div className="font-medium">{binding.presetDisplayName}</div>
                <div className="muted truncate text-sm">
                  {binding.presetUpstreamModelId} · {binding.connectionName}
                </div>
              </div>
              <label className="flex items-center gap-3 text-sm">
                <span className="text-zinc-400">Format</span>
                <select
                  className="input min-w-48"
                  disabled={save.isPending}
                  onChange={(event) =>
                    save.mutate({
                      id: binding.id,
                      codec: event.target.value as ReasoningCodec,
                    })
                  }
                  value={binding.codec}
                >
                  {(Object.keys(labels) as ReasoningCodec[]).map((codec) => (
                    <option key={codec} value={codec}>
                      {labels[codec]}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          ))}
        </div>
      )}

      <p className="muted mt-4 text-sm">
        Auto preserves existing provider URL detection. Explicit choices override it for the
        selected binding.
      </p>
    </>
  );
}
