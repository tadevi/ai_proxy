import {
  anthropicToOpenAI as baseAnthropicToOpenAI,
} from './conversion.js';
import type {
  AnthropicRequest,
  ReasoningCapabilities,
  ReasoningWireFormat,
} from './types.js';

export * from './conversion.js';

export function reasoningWireFormatForModel(
  upstreamModel: string,
  configured: ReasoningWireFormat = 'reasoning_details',
): ReasoningWireFormat {
  return /^ollama\//i.test(upstreamModel) ? 'reasoning' : configured;
}

export function anthropicToOpenAI(
  request: AnthropicRequest,
  upstreamModel: string,
  capabilities?: ReasoningCapabilities,
  resolveProxySignature?: (signature: string) => Promise<{ data: string; format: string } | null>,
  reasoningWireFormat: ReasoningWireFormat = 'reasoning_details',
) {
  return baseAnthropicToOpenAI(
    request,
    upstreamModel,
    capabilities,
    resolveProxySignature,
    reasoningWireFormatForModel(upstreamModel, reasoningWireFormat),
  );
}
