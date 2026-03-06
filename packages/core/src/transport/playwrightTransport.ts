/**
 * Default replay transport using Playwright's page.request.fetch().
 * Shares cookies with the browser context automatically.
 */

import type { Page } from 'playwright';
import type { ReplayTransport, ReplayRequest, ReplayResponse } from './types.js';

const RESPONSE_BODY_MAX_STORE_BYTES = 5 * 1024 * 1024; // 5MB

function isTextOrJsonContentType(ct: string | undefined): boolean {
  if (!ct) return false;
  const lower = ct.toLowerCase();
  return lower.includes('application/json') || lower.includes('+json') || lower.includes('text/');
}

export class PlaywrightTransport implements ReplayTransport {
  readonly name = 'playwright' as const;

  constructor(private page: Page) {}

  async execute(request: ReplayRequest): Promise<ReplayResponse> {
    const requestContext = (this.page as { request?: {
      fetch: (url: string, options?: object) => Promise<{
        status: () => number;
        headers: () => Record<string, string>;
        body: () => Promise<Buffer>;
      }>;
    } }).request;

    if (!requestContext || typeof requestContext.fetch !== 'function') {
      throw new Error(
        'Browser context does not support API request (replay). Playwright version may be too old.'
      );
    }

    const response = await requestContext.fetch(request.url, {
      method: request.method,
      headers: request.headers,
      data: request.body,
    });

    const respBody = await response.body();
    const bodySize = respBody.length;
    const contentType = response.headers()['content-type'] ?? response.headers()['Content-Type'];
    const bodyText =
      bodySize <= RESPONSE_BODY_MAX_STORE_BYTES && isTextOrJsonContentType(contentType)
        ? respBody.toString('utf8')
        : respBody.toString('utf8').slice(0, 2048) + (bodySize > 2048 ? '...[truncated]' : '');

    return {
      status: response.status(),
      contentType,
      body: bodyText,
      bodySize,
    };
  }
}
