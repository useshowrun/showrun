/**
 * Types for Browser Inspector MCP
 */

import type { Target } from '@showrun/core';

/**
 * Element fingerprint returned by pick_element
 */
export interface ElementFingerprint {
  text?: {
    visibleText?: string;
    exactCandidates: string[];
  };
  role?: {
    role: string;
    name?: string;
  };
  label?: string;
  placeholder?: string;
  altText?: string;
  tagName: string;
  attributes: {
    id?: string;
    name?: string;
    type?: string;
    ariaLabel?: string;
    dataTestid?: string;
  };
  domPathHint?: string;
  candidates: Target[];
}

/**
 * Action log entry
 */
export interface ActionLog {
  timestamp: number;
  action: string;
  details?: Record<string, unknown>;
}

/**
 * Network request/response entry (headers redacted)
 */
export interface NetworkEntry {
  id: string;
  ts: number;
  method: string;
  url: string;
  resourceType?: string;
  requestHeaders: Record<string, string>;
  status?: number;
  responseHeaders?: Record<string, string>;
  postData?: string;
  isLikelyApi?: boolean;
  /** First 2000 chars of response body (if captured) */
  responseBodySnippet?: string;
}
