/**
 * Anthropic LLM Provider Implementation
 * Uses ANTHROPIC_API_KEY from environment
 * Supports extended thinking and streaming
 */

import type {
  LlmProvider,
  ToolDef,
  ToolCall,
  ChatWithToolsResult,
  ChatMessage,
  ContentPart,
  StreamEvent,
} from './provider.js';

const DEFAULT_MODEL = 'claude-sonnet-4-20250514';
const DEFAULT_MAX_TOKENS = 16000;
const THINKING_BUDGET_TOKENS = 10000;

// Rate limit handling
const RATE_LIMIT_MAX_RETRIES = 5;
const RATE_LIMIT_WAIT_CAP_SECONDS = 120;
const RATE_LIMIT_WAIT_MIN_SECONDS = 2;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRateLimitWaitSeconds(response: Response, bodyText: string): number {
  const retryAfter = response.headers.get('Retry-After');
  if (retryAfter) {
    const sec = parseInt(retryAfter, 10);
    if (!Number.isNaN(sec)) return Math.min(Math.max(sec, RATE_LIMIT_WAIT_MIN_SECONDS), RATE_LIMIT_WAIT_CAP_SECONDS);
  }
  try {
    const json = JSON.parse(bodyText) as { error?: { message?: string } };
    const message = json?.error?.message ?? '';
    // Anthropic format: "Rate limit exceeded. Please retry after X seconds"
    const match = message.match(/retry after (\d+)/i) || message.match(/(\d+) seconds/i);
    if (match) {
      const sec = parseInt(match[1], 10);
      if (!Number.isNaN(sec) && sec > 0) {
        return Math.min(Math.max(sec, RATE_LIMIT_WAIT_MIN_SECONDS), RATE_LIMIT_WAIT_CAP_SECONDS);
      }
    }
  } catch {
    // ignore
  }
  return 30; // default wait
}

interface AnthropicContentBlock {
  type: 'text' | 'tool_use' | 'thinking' | 'tool_result';
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
}

interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: AnthropicContentBlock[];
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | null;
  usage: { input_tokens: number; output_tokens: number };
}

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

function convertToolDef(tool: ToolDef): AnthropicTool {
  return {
    name: tool.function.name,
    description: tool.function.description,
    input_schema: {
      type: 'object',
      properties: tool.function.parameters.properties,
      required: tool.function.parameters.required,
    },
  };
}

function convertMessages(
  messages: Array<ChatMessage | { role: 'tool'; content: string; tool_call_id: string } | { role: 'assistant'; content: string | null; tool_calls: ToolCall[] }>
): Array<{ role: 'user' | 'assistant'; content: string | AnthropicContentBlock[] }> {
  const result: Array<{ role: 'user' | 'assistant'; content: string | AnthropicContentBlock[] }> = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      continue;
    }

    if (msg.role === 'tool') {
      const toolMsg = msg as { role: 'tool'; content: string; tool_call_id: string };
      result.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolMsg.tool_call_id,
            content: toolMsg.content,
          } as AnthropicContentBlock,
        ],
      });
    } else if (msg.role === 'assistant' && 'tool_calls' in msg && msg.tool_calls) {
      const assistantMsg = msg as { role: 'assistant'; content: string | null; tool_calls: ToolCall[] };
      const content: AnthropicContentBlock[] = [];

      if (assistantMsg.content) {
        content.push({ type: 'text', text: assistantMsg.content });
      }

      for (const tc of assistantMsg.tool_calls) {
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(tc.arguments);
        } catch {
          // ignore
        }
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          input,
        });
      }

      result.push({ role: 'assistant', content });
    } else if (msg.role === 'user' || msg.role === 'assistant') {
      const chatMsg = msg as ChatMessage;
      if (Array.isArray(chatMsg.content)) {
        const anthropicContent: any[] = [];
        for (const part of chatMsg.content as ContentPart[]) {
          if (part.type === 'text') {
            anthropicContent.push({ type: 'text', text: part.text });
          } else if (part.type === 'image_url') {
            const dataUrl = part.image_url.url;
            const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
            if (match) {
              anthropicContent.push({
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: match[1],
                  data: match[2],
                },
              });
            }
          }
        }
        result.push({ role: msg.role, content: anthropicContent });
      } else {
        result.push({ role: msg.role, content: chatMsg.content });
      }
    }
  }

  return result;
}

export class AnthropicProvider implements LlmProvider {
  name = 'anthropic';
  private apiKey: string;
  private baseUrl: string;
  private model: string;

  constructor() {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY environment variable is required');
    }
    this.apiKey = apiKey;
    this.baseUrl = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
    console.log("Anthropic base url: " + process.env.ANTHROPIC_BASE_URL);
    this.model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
  }

  private getHeaders(enableThinking: boolean = false): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': '2023-06-01',
    };

    // Extended thinking requires beta header
    if (enableThinking) {
      headers['anthropic-beta'] = 'interleaved-thinking-2025-05-14';
    }

    return headers;
  }

  private async fetchWithRetry(
    url: string,
    options: RequestInit,
    maxRetries: number = RATE_LIMIT_MAX_RETRIES
  ): Promise<Response> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const response = await fetch(url, options);

        if (response.ok) {
          return response;
        }

        const bodyText = await response.text();

        // Handle rate limits (429) and overloaded (529)
        if ((response.status === 429 || response.status === 529) && attempt < maxRetries - 1) {
          const waitSec = parseRateLimitWaitSeconds(response, bodyText);
          console.log(`[Anthropic] Rate limited, waiting ${waitSec}s before retry ${attempt + 2}/${maxRetries}`);
          await sleep(waitSec * 1000);
          continue;
        }

        // 4xx errors (except 429) are client errors - don't retry, they won't succeed
        if (response.status >= 400 && response.status < 500) {
          throw new Error(`Anthropic API error: ${response.status} ${bodyText}`);
        }

        // 5xx errors (except 529) - retry with backoff
        if (response.status >= 500 && attempt < maxRetries - 1) {
          const waitSec = Math.min(2 ** attempt * 2, 30);
          console.log(`[Anthropic] Server error ${response.status}, waiting ${waitSec}s before retry ${attempt + 2}/${maxRetries}`);
          await sleep(waitSec * 1000);
          continue;
        }

        throw new Error(`Anthropic API error: ${response.status} ${bodyText}`);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        // Only retry network errors, not API errors (which are already thrown above)
        const isNetworkError = !lastError.message.startsWith('Anthropic API error:');
        if (isNetworkError && attempt < maxRetries - 1) {
          const waitSec = Math.min(2 ** attempt * 2, 30);
          console.log(`[Anthropic] Network error, waiting ${waitSec}s before retry ${attempt + 2}/${maxRetries}`);
          await sleep(waitSec * 1000);
          continue;
        }
        throw lastError;
      }
    }

    throw lastError || new Error('Max retries exceeded');
  }

  async generateJson<T>(args: {
    system: string;
    prompt: string;
    schema: object;
  }): Promise<T> {
    const { system, prompt } = args;

    const response = await this.fetchWithRetry(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        model: this.model,
        max_tokens: DEFAULT_MAX_TOKENS,
        system,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = (await response.json()) as AnthropicResponse;
    const textBlock = data.content.find((b) => b.type === 'text');
    const content = textBlock?.text || '';

    const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/) || content.match(/\{[\s\S]*\}/);
    const jsonStr = jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : content;

    try {
      return JSON.parse(jsonStr) as T;
    } catch (error) {
      throw new Error(`Failed to parse JSON from Anthropic response: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async chat(args: {
    systemPrompt?: string;
    messages: ChatMessage[];
  }): Promise<string> {
    const { systemPrompt, messages } = args;
    const anthropicMessages = convertMessages(messages);

    const response = await this.fetchWithRetry(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        model: this.model,
        max_tokens: DEFAULT_MAX_TOKENS,
        ...(systemPrompt && { system: systemPrompt }),
        messages: anthropicMessages,
      }),
    });

    const data = (await response.json()) as AnthropicResponse;
    const textBlock = data.content.find((b) => b.type === 'text');
    return textBlock?.text || '';
  }

  async chatWithTools(args: {
    systemPrompt?: string;
    messages: Array<
      | ChatMessage
      | { role: 'tool'; content: string; tool_call_id: string }
      | { role: 'assistant'; content: string | null; tool_calls: ToolCall[] }
    >;
    tools: ToolDef[];
  }): Promise<ChatWithToolsResult> {
    const { systemPrompt, messages, tools } = args;
    const anthropicMessages = convertMessages(messages);
    const anthropicTools = tools.map(convertToolDef);

    const response = await this.fetchWithRetry(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        model: this.model,
        max_tokens: DEFAULT_MAX_TOKENS,
        ...(systemPrompt && { system: systemPrompt }),
        messages: anthropicMessages,
        ...(anthropicTools.length > 0 && { tools: anthropicTools }),
      }),
    });

    const data = (await response.json()) as AnthropicResponse;

    let content: string | null = null;
    const toolCalls: ToolCall[] = [];

    for (const block of data.content) {
      if (block.type === 'text') {
        content = block.text || null;
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id!,
          name: block.name!,
          arguments: JSON.stringify(block.input || {}),
        });
      }
    }

    return { content, toolCalls };
  }

  async *chatWithToolsStream(args: {
    systemPrompt?: string;
    messages: Array<
      | ChatMessage
      | { role: 'tool'; content: string; tool_call_id: string }
      | { role: 'assistant'; content: string | null; tool_calls: ToolCall[] }
    >;
    tools: ToolDef[];
    enableThinking?: boolean;
  }): AsyncGenerator<StreamEvent, ChatWithToolsResult, unknown> {
    const { systemPrompt, messages, tools, enableThinking = true } = args;
    const anthropicMessages = convertMessages(messages);
    const anthropicTools = tools.map(convertToolDef);

    // Build request body
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: DEFAULT_MAX_TOKENS,
      stream: true,
      ...(systemPrompt && { system: systemPrompt }),
      messages: anthropicMessages,
      ...(anthropicTools.length > 0 && { tools: anthropicTools }),
    };

    // Enable extended thinking
    if (enableThinking) {
      body.thinking = {
        type: 'enabled',
        budget_tokens: THINKING_BUDGET_TOKENS,
      };
    }

    // For streaming, we can't use fetchWithRetry easily, so handle rate limits inline
    let response: Response | null = null;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < RATE_LIMIT_MAX_RETRIES; attempt++) {
      response = null; // Always reset before attempt

      try {
        const fetchResponse = await fetch(`${this.baseUrl}/v1/messages`, {
          method: 'POST',
          headers: this.getHeaders(enableThinking),
          body: JSON.stringify(body),
        });

        if (fetchResponse.ok) {
          response = fetchResponse;
          break;
        }

        // For non-ok responses, clone before reading body to avoid locking issues
        let bodyText = '';
        try {
          bodyText = await fetchResponse.text();
        } catch {
          bodyText = `(failed to read error body)`;
        }

        // Handle rate limits (429) and overloaded (529)
        if ((fetchResponse.status === 429 || fetchResponse.status === 529) && attempt < RATE_LIMIT_MAX_RETRIES - 1) {
          const waitSec = parseRateLimitWaitSeconds(fetchResponse, bodyText);
          console.log(`[Anthropic] Rate limited, waiting ${waitSec}s before retry ${attempt + 2}/${RATE_LIMIT_MAX_RETRIES}`);
          await sleep(waitSec * 1000);
          continue;
        }

        // 4xx errors (except 429) are client errors - don't retry, they won't succeed
        if (fetchResponse.status >= 400 && fetchResponse.status < 500) {
          throw new Error(`Anthropic API error: ${fetchResponse.status} ${bodyText}`);
        }

        // 5xx errors (except 529) - retry with backoff
        if (fetchResponse.status >= 500 && attempt < RATE_LIMIT_MAX_RETRIES - 1) {
          const waitSec = Math.min(2 ** attempt * 2, 30);
          console.log(`[Anthropic] Server error ${fetchResponse.status}, waiting ${waitSec}s before retry ${attempt + 2}/${RATE_LIMIT_MAX_RETRIES}`);
          await sleep(waitSec * 1000);
          continue;
        }

        throw new Error(`Anthropic API error: ${fetchResponse.status} ${bodyText}`);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        // Only retry network errors, not API errors (which are already thrown above)
        const isNetworkError = !lastError.message.startsWith('Anthropic API error:');
        if (isNetworkError && attempt < RATE_LIMIT_MAX_RETRIES - 1) {
          const waitSec = Math.min(2 ** attempt * 2, 30);
          console.log(`[Anthropic] Network error, waiting ${waitSec}s before retry ${attempt + 2}/${RATE_LIMIT_MAX_RETRIES}`);
          await sleep(waitSec * 1000);
          continue;
        }
        throw lastError;
      }
    }

    if (!response) {
      throw lastError || new Error('Failed to get response after retries');
    }

    if (!response.body) {
      throw new Error('No response body from Anthropic API');
    }

    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    const decoder = new TextDecoder();
    let buffer = '';

    let content: string | null = null;
    const toolCalls: ToolCall[] = [];
    const contentBlocks: Map<number, { type: string; text: string; id?: string; name?: string; input: string }> = new Map();

    try {
      reader = response.body.getReader();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;

          try {
            const event = JSON.parse(data);

            switch (event.type) {
              case 'content_block_start': {
                const index = event.index;
                const block = event.content_block;
                contentBlocks.set(index, {
                  type: block.type,
                  text: block.text || block.thinking || '',
                  id: block.id,
                  name: block.name,
                  input: '',
                });

                if (block.type === 'thinking') {
                  yield { type: 'thinking_start' };
                } else if (block.type === 'text') {
                  yield { type: 'content_start' };
                } else if (block.type === 'tool_use') {
                  yield { type: 'tool_call_start', id: block.id, name: block.name };
                }
                break;
              }

              case 'content_block_delta': {
                const index = event.index;
                const delta = event.delta;
                const block = contentBlocks.get(index);

                if (delta.type === 'thinking_delta' && delta.thinking) {
                  if (block) block.text += delta.thinking;
                  yield { type: 'thinking_delta', text: delta.thinking };
                } else if (delta.type === 'text_delta' && delta.text) {
                  if (block) block.text += delta.text;
                  yield { type: 'content_delta', text: delta.text };
                } else if (delta.type === 'input_json_delta' && delta.partial_json) {
                  if (block) block.input += delta.partial_json;
                }
                break;
              }

              case 'content_block_stop': {
                const index = event.index;
                const block = contentBlocks.get(index);

                if (block?.type === 'thinking') {
                  yield { type: 'thinking_stop', text: block.text };
                } else if (block?.type === 'text') {
                  content = block.text;
                  yield { type: 'content_stop', text: block.text };
                } else if (block?.type === 'tool_use') {
                  const toolCall: ToolCall = {
                    id: block.id!,
                    name: block.name!,
                    arguments: block.input,
                  };
                  toolCalls.push(toolCall);
                  yield { type: 'tool_call_stop', toolCall };
                }
                break;
              }

              case 'message_stop': {
                yield { type: 'message_stop' };
                break;
              }

              case 'error': {
                throw new Error(`Anthropic stream error: ${JSON.stringify(event.error)}`);
              }
            }
          } catch (parseError) {
            if (!(parseError instanceof SyntaxError)) {
              throw parseError;
            }
          }
        }
      }
    } finally {
      if (reader) {
        try {
          reader.releaseLock();
        } catch {
          // Stream might already be closed
        }
      }
    }

    return { content, toolCalls };
  }
}
