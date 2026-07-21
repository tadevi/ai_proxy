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
export type Model = {
  id: string;
  displayName: string;
  gatewayModelId: string;
  upstreamModelId: string;
  providerConnectionId: string;
  providerConnectionName: string;
  apiFormat: 'openai_compatible' | 'anthropic_compatible';
  providerBasePath: string;
  requestPathOverride?: string | null;
  providerEnabled: boolean;
  enabled: boolean;
  supportsStreaming: string;
  supportsTools: string;
  supportsImages: string;
  supportsReasoning: string;
  latestTestStatus?: string;
};
export type ProviderConnection = {
  id: string;
  displayName: string;
  baseUrl: string;
  enabled: boolean;
};
export type Route = {
  routeId: string;
  modelId: string;
  enabled: boolean;
  position: number;
  displayName: string;
  providerConnectionName: string;
  gatewayModelId: string;
  latestTestStatus?: string;
};
