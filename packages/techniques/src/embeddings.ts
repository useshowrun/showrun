/**
 * EmbeddingProvider — OpenAI-compatible embedding generation.
 *
 * Uses the dedicated EMBEDDING_API_KEY / EMBEDDING_MODEL config,
 * independent from the chat LLM provider.
 */

import type { EmbeddingConfig } from './types.js';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_DIMENSIONS = 1536;
const MAX_BATCH_SIZE = 100;

interface EmbeddingResponse {
  data: Array<{ embedding: number[]; index: number }>;
  model: string;
  usage: { prompt_tokens: number; total_tokens: number };
}

export class EmbeddingProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly dimensions: number;

  constructor(config: EmbeddingConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.dimensions = config.dimensions ?? DEFAULT_DIMENSIONS;
  }

  /** Generate embedding for a single text. */
  async embed(text: string): Promise<number[]> {
    const [result] = await this.embedBatch([text]);
    return result;
  }

  /** Generate embeddings for multiple texts (batched). */
  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const results: number[][] = new Array(texts.length);

    // Process in chunks of MAX_BATCH_SIZE
    for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
      const batch = texts.slice(i, i + MAX_BATCH_SIZE);
      const response = await this.callEmbeddingsApi(batch);

      for (const item of response.data) {
        results[i + item.index] = item.embedding;
      }
    }

    return results;
  }

  /** Get the configured dimensions. */
  getDimensions(): number {
    return this.dimensions;
  }

  private async callEmbeddingsApi(input: string[]): Promise<EmbeddingResponse> {
    const url = `${this.baseUrl}/embeddings`;

    const body: Record<string, unknown> = {
      model: this.model,
      input,
    };
    // Only send dimensions if it's not the default (some providers don't support it)
    if (this.dimensions !== DEFAULT_DIMENSIONS) {
      body.dimensions = this.dimensions;
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errorText = await res.text().catch(() => 'unknown');
      throw new Error(
        `Embedding API error (${res.status}): ${errorText.slice(0, 500)}`,
      );
    }

    return (await res.json()) as EmbeddingResponse;
  }
}
