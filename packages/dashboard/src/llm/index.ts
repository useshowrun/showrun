/**
 * LLM Provider Factory
 * Creates the appropriate LLM provider based on environment configuration
 */

import type { LlmProvider } from './provider.js';
import { OpenAIProvider } from './openai.js';
import { AnthropicProvider } from './anthropic.js';
import { CliProxyProvider } from './cliproxy.js';

export function createLlmProvider(): LlmProvider {
  // Auto-detect provider based on available API keys
  const provider = process.env.LLM_PROVIDER ||
    (process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'openai');

  switch (provider) {
    case 'openai':
      return new OpenAIProvider();
    case 'anthropic':
      return new AnthropicProvider();
    case 'cliproxy':
      return new CliProxyProvider();
    default:
      throw new Error(`Unsupported LLM provider: ${provider}`);
  }
}

export type { LlmProvider, ChatMessage, StreamEvent } from './provider.js';
