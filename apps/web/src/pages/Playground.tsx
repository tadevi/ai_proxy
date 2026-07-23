import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, type Model } from '../api';

type ContentBlock = { type: string; text?: string; name?: string; input?: unknown };
type CompletionResponse = {
  content?: ContentBlock[];
  usage?: { input_tokens?: number; output_tokens?: number };
  stop_reason?: string;
};

function extractText(response?: CompletionResponse): string {
  if (!response?.content) return '';
  return response.content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

function extractToolCalls(response?: CompletionResponse): ContentBlock[] {
  return response?.content?.filter((block) => block.type === 'tool_use') ?? [];
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // Strip the "data:<mime>;base64," prefix — the API wants the bare base64 payload.
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

export function Playground() {
  const [modelId, setModelId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [maxTokens, setMaxTokens] = useState(1024);
  const [includeTestTool, setIncludeTestTool] = useState(false);
  const [image, setImage] = useState<{ dataUrl: string; base64: string; mediaType: string } | null>(
    null,
  );

  const models = useQuery({ queryKey: ['models'], queryFn: () => api<Model[]>('/api/models') });

  const run = useMutation({
    mutationFn: () =>
      api<{ ok: boolean; response?: CompletionResponse }>('/api/playground/complete', {
        method: 'POST',
        body: JSON.stringify({
          modelId,
          prompt,
          maxTokens,
          includeTestTool,
          ...(image ? { imageBase64: image.base64, imageMediaType: image.mediaType } : {}),
        }),
      }),
  });

  async function onPickImage(file: File | undefined) {
    if (!file) {
      setImage(null);
      return;
    }
    const base64 = await readFileAsBase64(file);
    setImage({ dataUrl: `data:${file.type};base64,${base64}`, base64, mediaType: file.type });
  }

  const responseText = extractText(run.data?.response);
  const toolCalls = extractToolCalls(run.data?.response);

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <div>
        <h1 className="text-2xl font-semibold">Playground</h1>
        <p className="muted mt-1">
          Send a one-off prompt to any configured model and see the raw response.
        </p>
        <div className="card mt-5 grid gap-4">
          <label>
            <span className="label">Model</span>
            <select className="input" onChange={(e) => setModelId(e.target.value)} value={modelId}>
              <option value="">Select a model…</option>
              {models.data?.map((m) => (
                <option key={m.id} value={m.id} disabled={!m.enabled}>
                  {m.providerConnectionName} · {m.displayName}
                  {!m.enabled ? ' (disabled)' : ''}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="label">Prompt</span>
            <textarea
              className="input min-h-40 resize-y font-mono text-[13px]"
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Type a prompt to send as a single user message…"
              value={prompt}
            />
          </label>
          <label>
            <span className="label">Image (optional — tests vision support)</span>
            <input
              accept="image/*"
              className="input"
              onChange={(e) => void onPickImage(e.target.files?.[0])}
              type="file"
            />
            {image && (
              <div className="mt-2 flex items-center gap-2">
                <img alt="Attached preview" className="h-16 w-16 rounded-lg object-cover" src={image.dataUrl} />
                <button className="btn h-7 px-2.5 text-xs" onClick={() => setImage(null)} type="button">
                  Remove
                </button>
              </div>
            )}
          </label>
          <label className="flex cursor-pointer items-center gap-2">
            <input
              checked={includeTestTool}
              onChange={(e) => setIncludeTestTool(e.target.checked)}
              type="checkbox"
            />
            <span className="text-sm">
              Include a test tool (<code className="font-mono text-xs">web_search</code>) — checks
              whether the model calls it
            </span>
          </label>
          <label className="max-w-40">
            <span className="label">Max tokens</span>
            <input
              className="input"
              min={1}
              onChange={(e) => setMaxTokens(Number(e.target.value) || 1024)}
              type="number"
              value={maxTokens}
            />
          </label>
          <button
            className="btn btn-primary"
            disabled={!modelId || !prompt.trim() || run.isPending}
            onClick={() => run.mutate()}
          >
            {run.isPending ? 'Running…' : 'Run'}
          </button>
        </div>
      </div>

      <div>
        <h2 className="text-lg font-medium">Output</h2>
        <div className="card mt-5 min-h-[280px]">
          {run.isPending && <p className="text-sm text-zinc-400">Waiting for response…</p>}
          {run.error && <p className="text-sm text-red-400">{run.error.message}</p>}
          {!run.isPending && !run.error && !run.data && (
            <p className="text-sm text-zinc-500">Run a prompt to see the response here.</p>
          )}
          {run.data && (
            <>
              <pre className="whitespace-pre-wrap break-words font-mono text-[13px] text-zinc-100">
                {responseText || '(no text content in response)'}
              </pre>
              {toolCalls.length > 0 && (
                <div className="mt-4 grid gap-2">
                  {toolCalls.map((call, i) => (
                    <div className="rounded-lg border border-indigo-800 bg-indigo-950/30 p-3" key={i}>
                      <div className="text-xs font-medium text-indigo-300">
                        Tool call: <code className="font-mono">{call.name}</code>
                      </div>
                      <pre className="mt-1 overflow-x-auto font-mono text-xs text-indigo-200/80">
                        {JSON.stringify(call.input, null, 2)}
                      </pre>
                    </div>
                  ))}
                </div>
              )}
              {run.data.response?.usage && (
                <p className="mt-4 text-xs text-zinc-500">
                  {run.data.response.usage.input_tokens ?? 0} in ·{' '}
                  {run.data.response.usage.output_tokens ?? 0} out · stop_reason:{' '}
                  {run.data.response.stop_reason ?? '—'}
                </p>
              )}
              <details className="mt-4">
                <summary className="cursor-pointer text-xs text-zinc-500">Raw response</summary>
                <pre className="mt-2 overflow-x-auto rounded-lg bg-black/40 p-3 text-xs text-zinc-400">
                  {JSON.stringify(run.data.response, null, 2)}
                </pre>
              </details>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
