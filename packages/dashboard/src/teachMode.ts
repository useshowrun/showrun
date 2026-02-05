/**
 * Teach Mode API
 * Orchestrates AI-assisted step proposal using LLM and MCP servers
 */

import type { LlmProvider } from './llm/index.js';
import type { DslStep, Target } from '@showrun/core';

// ElementFingerprint type (matches browser-inspector-mcp)
export interface ElementFingerprint {
  text?: { visibleText?: string; exactCandidates: string[] };
  role?: { role: string; name?: string };
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

export type UserIntent = 'click' | 'fill' | 'extract_text' | 'extract_attribute' | 'wait_for';

export interface ProposeStepRequest {
  packId: string;
  userIntent: UserIntent;
  elementFingerprint: ElementFingerprint;
  extraParams?: {
    out?: string; // For extract steps
    attr?: string; // For extract_attribute (value for params.attribute)
    fillValue?: string; // For fill
  };
}

export interface ProposeStepResponse {
  step: DslStep;
  insertionIndex?: number;
  collectiblesDelta?: Array<{ name: string; type: 'string' | 'number' | 'boolean'; description?: string }>;
}

/**
 * Redacts sensitive data from element fingerprint
 * Never send cookies, localStorage, or full HTML to LLM
 */
function redactFingerprint(fingerprint: ElementFingerprint): ElementFingerprint {
  // Create a safe copy, removing any potentially sensitive data
  const safe: ElementFingerprint = {
    ...fingerprint,
    // Ensure we don't include any sensitive attributes
    attributes: {
      id: fingerprint.attributes.id,
      name: fingerprint.attributes.name,
      type: fingerprint.attributes.type,
      ariaLabel: fingerprint.attributes.ariaLabel,
      dataTestid: fingerprint.attributes.dataTestid,
      // Explicitly exclude: value, data-* (except data-testid), etc.
    },
    // Limit text length to prevent sending large content
    text: fingerprint.text
      ? {
          visibleText:
            fingerprint.text.visibleText && fingerprint.text.visibleText.length > 200
              ? fingerprint.text.visibleText.substring(0, 200) + '...'
              : fingerprint.text.visibleText,
          exactCandidates: fingerprint.text.exactCandidates.map((c) =>
            c.length > 200 ? c.substring(0, 200) + '...' : c
          ),
        }
      : undefined,
  };

  return safe;
}

/**
 * Proposes a DSL step using LLM based on element fingerprint and user intent
 */
export async function proposeStep(
  llmProvider: LlmProvider,
  request: ProposeStepRequest
): Promise<ProposeStepResponse> {
  const { userIntent, elementFingerprint, extraParams } = request;

  // Redact sensitive data before sending to LLM
  const safeFingerprint = redactFingerprint(elementFingerprint);

  // Build target candidates (prefer role/text/label, css as fallback)
  const targetCandidates = elementFingerprint.candidates || [];
  let target: Target | { anyOf: Target[] };

  if (targetCandidates.length === 0) {
    // Fallback to CSS if no candidates
    target = {
      kind: 'css',
      selector: elementFingerprint.attributes.id
        ? `#${elementFingerprint.attributes.id}`
        : elementFingerprint.tagName,
    };
  } else if (targetCandidates.length === 1) {
    target = targetCandidates[0];
  } else {
    // Use anyOf for fallback
    target = { anyOf: targetCandidates };
  }

  // Build system prompt
  const systemPrompt = `You are a DSL step generator for browser automation. Your task is to generate a single DSL step JSON object based on user intent and element fingerprint.

Rules:
- Output JSON only, no prose
- Use human-stable targets (role/text/label first, css as fallback)
- Include fallbacks via anyOf when multiple candidates exist
- Keep step minimal and focused
- Never include secrets or sensitive data
- Keep step IDs stable and readable (use descriptive names like "click_login_button")
- For extract steps, ensure the 'out' key matches a collectible name
- For fill steps, use a template value like "{{fillValue}}" if fillValue is provided

DSL Step Types:
- click: { type: "click", params: { target } }
- fill: { type: "fill", params: { target, value } }
- extract_text: { type: "extract_text", params: { target, out } }
- extract_attribute: { type: "extract_attribute", params: { target, attribute, out } }
- wait_for: { type: "wait_for", params: { target, visible: true } }
- All step types support optional "once" field: { "once": "session" | "profile" } - marks steps as run-once (skipped on subsequent runs when auth is valid)

Target format:
- { kind: "role", role: string, name?: string, exact?: boolean }
- { kind: "text", text: string, exact?: boolean }
- { kind: "label", text: string, exact?: boolean }
- { kind: "placeholder", text: string, exact?: boolean }
- { kind: "altText", text: string, exact?: boolean }
- { kind: "css", selector: string }
- { kind: "testId", id: string }
- { anyOf: Target[] } for fallbacks`;

  // Build user prompt (using redacted fingerprint)
  let userPrompt = `Generate a ${userIntent} step for this element:\n\n`;
  userPrompt += `Element fingerprint:\n${JSON.stringify(safeFingerprint, null, 2)}\n\n`;

  if (extraParams) {
    userPrompt += `Extra parameters:\n${JSON.stringify(extraParams, null, 2)}\n\n`;
  }

  userPrompt += `Generate the step JSON.`;

  // Define output schema
  const outputSchema = {
    type: 'object',
    properties: {
      step: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          type: { type: 'string' },
          label: { type: 'string' },
          params: { type: 'object' },
        },
        required: ['id', 'type', 'params'],
      },
      insertionIndex: { type: 'number' },
      collectiblesDelta: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            type: { type: 'string', enum: ['string', 'number', 'boolean'] },
            description: { type: 'string' },
          },
          required: ['name', 'type'],
        },
      },
    },
    required: ['step'],
  };

  // Call LLM
  const response = await llmProvider.generateJson<ProposeStepResponse>({
    system: systemPrompt,
    prompt: userPrompt,
    schema: outputSchema,
  });

  // Ensure step has proper structure
  if (!response.step || !response.step.id || !response.step.type) {
    throw new Error('Invalid step structure from LLM');
  }

  // Set default insertionIndex if not provided
  if (response.insertionIndex === undefined) {
    response.insertionIndex = -1; // -1 means append
  }

  return response;
}
