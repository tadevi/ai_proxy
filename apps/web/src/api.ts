export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const response = await fetch(path, {
    ...init,
    headers,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      (body as { error?: string; message?: string }).error ??
        (body as { message?: string }).message ??
        `Request failed (${response.status})`,
    );
  return body as T;
}
export type ProviderConnection = {
  id: string;
  displayName: string;
  baseUrl: string;
  enabled: boolean;
};
export type ConnectionToken = {
  id: string;
  connectionId: string;
  name: string;
  enabled: boolean;
  createdAt: string;
};
export type ModelBinding = {
  id: string;
  connectionId: string;
  presetId: string;
  presetName: string;
  presetUpstreamModelId: string;
  apiFormat: string;
  providerBasePath: string;
  createdAt: string;
};
export type Model = {
  id: string;
  displayName: string;
  upstreamModelId: string;
  providerConnectionId: string;
  providerConnectionName: string;
  bindingId: string | null;
  tokenId: string | null;
  tokenName: string | null;
  apiFormat: 'openai_compatible' | 'anthropic_compatible';
  providerBasePath: string;
  requestPathOverride?: string | null;
  providerEnabled: boolean;
  enabled: boolean;
  maxOutputTokens?: number | null;
  supportsStreaming: string;
  supportsTools: string;
  supportsImages: string;
  supportsReasoning: string;
  latestTestStatus?: string;
  cooldownUntil?: string | null;
  latestError?: Record<string, unknown> | null;
  latestErrorAt?: string | null;
};
export type Preset = {
  id: string;
  userId: string | null;
  displayName: string;
  upstreamModelId: string;
  apiFormat: 'openai_compatible' | 'anthropic_compatible';
  supportsImages: string;
  supportsReasoning: string;
  maxOutputTokens?: number | null;
  createdAt: string;
  updatedAt: string;
};
