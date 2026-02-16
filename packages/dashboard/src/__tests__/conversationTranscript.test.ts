/**
 * End-to-end tests for conversation transcript logging.
 * Mocks the LLM provider and heavy dependencies, uses a real SQLite DB,
 * and hits the /api/teach/agent endpoint to verify transcripts are saved
 * (or not) based on the transcriptLogging flag.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'path';
import { mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';

// Mock heavy dependencies before importing the module under test
vi.mock('../agentTools.js', () => ({
  MAIN_AGENT_TOOL_DEFINITIONS: [],
  EXPLORATION_AGENT_TOOLS: [
    { type: 'function', function: { name: 'browser_goto', description: 'Go to URL', parameters: { type: 'object', properties: {} } } },
  ],
  executeAgentTool: vi.fn(),
}));

vi.mock('../mcpWrappers.js', () => ({
  TaskPackEditorWrapper: vi.fn().mockImplementation(() => ({
    readPack: vi.fn().mockResolvedValue({ flowJson: { inputs: [], flow: [] } }),
    createPack: vi.fn().mockResolvedValue({ path: '/tmp/fake' }),
    listPacks: vi.fn().mockResolvedValue([]),
    applyFlowPatch: vi.fn(),
    validateFlow: vi.fn().mockResolvedValue({ ok: true, errors: [], warnings: [] }),
  })),
}));

vi.mock('../contextManager.js', () => ({
  summarizeIfNeeded: vi.fn().mockResolvedValue({ wasSummarized: false, messages: [], tokensBefore: 0, tokensAfter: 0 }),
  estimateTotalTokens: vi.fn().mockReturnValue(1000),
  forceSummarize: vi.fn(),
}));

vi.mock('../agents/editorAgent.js', () => ({
  runEditorAgent: vi.fn(),
}));

vi.mock('@showrun/mcp-server', () => ({
  discoverPacks: vi.fn().mockResolvedValue([]),
  ConcurrencyLimiter: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../teachMode.js', () => ({
  proposeStep: vi.fn(),
}));

import express from 'express';
import { Server as SocketIOServer } from 'socket.io';
import { createServer } from 'http';
import {
  initDatabase,
  closeDatabase,
  createConversation,
  getTranscriptByConversationId,
  getAllTranscripts,
} from '../db.js';
import { createTeachRouter } from '../routes/teach.js';
import type { DashboardContext } from '../types/context.js';
import type { LlmProvider } from '../llm/provider.js';

/** Create a mock LLM provider that returns a simple text response (no tool calls) */
function createMockLlmProvider(): LlmProvider {
  return {
    name: 'mock',
    generateJson: vi.fn().mockResolvedValue({}),
    chat: vi.fn().mockResolvedValue('mock response'),
    chatWithTools: vi.fn().mockResolvedValue({
      content: 'Here is my response to your request.',
      toolCalls: [], // No tool calls => agent loop exits at normal completion
    }),
  };
}

function buildContext(overrides: Partial<DashboardContext>): DashboardContext {
  const httpServer = createServer();
  const io = new SocketIOServer(httpServer);

  return {
    sessionToken: 'test-token',
    packDirs: ['/tmp/fake-packs'],
    workspaceDir: '/tmp/fake-workspace',
    baseRunDir: '/tmp/fake-runs',
    headful: false,
    debug: false,
    transcriptLogging: false,
    packMap: new Map(),
    runManager: { getAllRuns: () => [] } as any,
    concurrencyLimiter: {} as any,
    mcpServer: { handle: null, packIds: [], runIdMap: new Map() },
    io,
    taskPackEditor: {
      readPack: vi.fn().mockResolvedValue({ flowJson: { inputs: [], flow: [] } }),
      createPack: vi.fn().mockResolvedValue({ path: '/tmp/fake' }),
      listPacks: vi.fn().mockResolvedValue([]),
      applyFlowPatch: vi.fn(),
      validateFlow: vi.fn().mockResolvedValue({ ok: true, errors: [], warnings: [] }),
    } as any,
    llmProvider: createMockLlmProvider(),
    systemPrompt: 'You are a test agent.',
    pendingSecretsRequests: new Map(),
    techniqueManager: null,
    ...overrides,
  };
}

/** Helper: make a POST request to the Express app (JSON response) */
async function postAgent(
  app: express.Express,
  body: Record<string, unknown>,
  token = 'test-token'
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      const url = `http://127.0.0.1:${addr.port}/api/teach/agent`;

      fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-showrun-token': token,
        },
        body: JSON.stringify(body),
      })
        .then(async (res) => {
          const json = await res.json().catch(() => null);
          resolve({ status: res.status, body: json });
        })
        .catch(reject)
        .finally(() => server.close());
    });
  });
}

/** Helper: make a POST request expecting NDJSON streaming response */
async function postAgentStreaming(
  app: express.Express,
  body: Record<string, unknown>,
  token = 'test-token'
): Promise<{ status: number; events: any[] }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      const url = `http://127.0.0.1:${addr.port}/api/teach/agent`;

      fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-showrun-token': token,
        },
        body: JSON.stringify({ ...body, stream: true }),
      })
        .then(async (res) => {
          const text = await res.text();
          const events = text
            .split('\n')
            .filter((line) => line.trim())
            .map((line) => {
              try { return JSON.parse(line); } catch { return null; }
            })
            .filter(Boolean);
          resolve({ status: res.status, events });
        })
        .catch(reject)
        .finally(() => server.close());
    });
  });
}

describe('Conversation Transcript Logging (E2E)', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `showrun-transcript-e2e-${randomBytes(8).toString('hex')}`);
    mkdirSync(testDir, { recursive: true });
    initDatabase(testDir);
  });

  afterEach(() => {
    closeDatabase();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('saves a transcript when transcriptLogging is enabled', async () => {
    const conv = createConversation('Test conversation');
    const ctx = buildContext({ transcriptLogging: true });
    const app = express();
    app.use(express.json());
    app.use(createTeachRouter(ctx));

    const { status, body } = await postAgent(app, {
      messages: [{ role: 'user', content: 'Build me a scraper for example.com' }],
      conversationId: conv.id,
      packId: 'some-pack',
    });

    expect(status).toBe(200);
    expect(body.assistantMessage).toBeDefined();
    expect(body.assistantMessage.content).toBe('Here is my response to your request.');

    // Verify transcript was saved
    const transcript = getTranscriptByConversationId(conv.id);
    expect(transcript).not.toBeNull();
    expect(transcript!.conversationId).toBe(conv.id);
    expect(transcript!.packId).toBe('some-pack');
    expect(transcript!.agentIterations).toBe(1);

    // Verify the transcript content contains the user message
    const messages = JSON.parse(transcript!.transcript);
    expect(messages).toBeInstanceOf(Array);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toBe('Build me a scraper for example.com');
  });

  it('does NOT save a transcript when transcriptLogging is disabled', async () => {
    const conv = createConversation('No logging conversation');
    const ctx = buildContext({ transcriptLogging: false });
    const app = express();
    app.use(express.json());
    app.use(createTeachRouter(ctx));

    const { status } = await postAgent(app, {
      messages: [{ role: 'user', content: 'Do something' }],
      conversationId: conv.id,
      packId: 'some-pack',
    });

    expect(status).toBe(200);

    // Verify NO transcript was saved
    const transcript = getTranscriptByConversationId(conv.id);
    expect(transcript).toBeNull();

    const all = getAllTranscripts();
    expect(all).toHaveLength(0);
  });

  it('saves transcript on error path when transcriptLogging is enabled', async () => {
    const conv = createConversation('Error conversation');
    const mockProvider = createMockLlmProvider();
    // Make chatWithTools throw an error
    (mockProvider.chatWithTools as any).mockRejectedValue(new Error('LLM API unavailable'));

    const ctx = buildContext({ transcriptLogging: true, llmProvider: mockProvider });
    const app = express();
    app.use(express.json());
    app.use(createTeachRouter(ctx));

    const { status } = await postAgent(app, {
      messages: [{ role: 'user', content: 'This will fail' }],
      conversationId: conv.id,
      packId: 'error-pack',
    });

    expect(status).toBe(500);

    // Even on error, transcript should be saved
    const transcript = getTranscriptByConversationId(conv.id);
    expect(transcript).not.toBeNull();
    expect(transcript!.conversationId).toBe(conv.id);
    expect(transcript!.packId).toBe('error-pack');
  });

  it('saves transcript with conversationStatus from the DB', async () => {
    const conv = createConversation('Status check');
    // conv.status is 'active' by default
    const ctx = buildContext({ transcriptLogging: true });
    const app = express();
    app.use(express.json());
    app.use(createTeachRouter(ctx));

    await postAgent(app, {
      messages: [{ role: 'user', content: 'Hello' }],
      conversationId: conv.id,
      packId: 'status-pack',
    });

    const transcript = getTranscriptByConversationId(conv.id);
    expect(transcript).not.toBeNull();
    expect(transcript!.conversationStatus).toBe('active');
  });

  it('saves toolTrace in the transcript when tools are called', async () => {
    const conv = createConversation('Tool trace conversation');

    // LLM first returns a tool call, then a final response
    const mockProvider = createMockLlmProvider();
    let callCount = 0;
    (mockProvider.chatWithTools as any).mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          content: 'Let me check the site.',
          toolCalls: [{ id: 'tc-1', name: 'browser_goto', arguments: '{"url":"https://example.com"}' }],
        });
      }
      return Promise.resolve({
        content: 'I found the page. Here is what I see.',
        toolCalls: [],
      });
    });

    // Mock executeAgentTool to return a success result
    const { executeAgentTool } = await import('../agentTools.js');
    (executeAgentTool as any).mockResolvedValue({
      stringForLlm: JSON.stringify({ ok: true, url: 'https://example.com' }),
    });

    const ctx = buildContext({ transcriptLogging: true, llmProvider: mockProvider });
    const app = express();
    app.use(express.json());
    app.use(createTeachRouter(ctx));

    const { status } = await postAgent(app, {
      messages: [{ role: 'user', content: 'Go to example.com' }],
      conversationId: conv.id,
      packId: 'tool-pack',
    });

    expect(status).toBe(200);

    const transcript = getTranscriptByConversationId(conv.id);
    expect(transcript).not.toBeNull();
    expect(transcript!.agentIterations).toBe(2);

    // Verify tool trace is saved
    const trace = JSON.parse(transcript!.toolTrace!);
    expect(trace).toBeInstanceOf(Array);
    expect(trace.length).toBe(1);
    expect(trace[0].tool).toBe('browser_goto');
    expect(trace[0].success).toBe(true);
  });

  it('captures thinking output in the transcript when streaming', async () => {
    const conv = createConversation('Thinking conversation');

    const mockProvider = createMockLlmProvider();
    // Add chatWithToolsStream as an async generator that yields thinking events
    (mockProvider as any).chatWithToolsStream = async function* () {
      yield { type: 'thinking_start' };
      yield { type: 'thinking_delta', text: 'I need to analyze ' };
      yield { type: 'thinking_delta', text: 'what the user wants.' };
      yield { type: 'thinking_stop', text: 'I need to analyze what the user wants.' };
      yield { type: 'content_start' };
      yield { type: 'content_delta', text: 'Here is my thoughtful response.' };
      yield { type: 'content_stop', text: 'Here is my thoughtful response.' };
      yield { type: 'message_stop' };
      return { content: 'Here is my thoughtful response.', toolCalls: [] };
    };

    const ctx = buildContext({ transcriptLogging: true, llmProvider: mockProvider });
    const app = express();
    app.use(express.json());
    app.use(createTeachRouter(ctx));

    const { status, events } = await postAgentStreaming(app, {
      messages: [{ role: 'user', content: 'Think about this carefully' }],
      conversationId: conv.id,
      packId: 'thinking-pack',
    });

    expect(status).toBe(200);

    // Verify thinking events were streamed to the client
    const thinkingEvents = events.filter((e) => e.type === 'thinking_delta' || e.type === 'thinking_start' || e.type === 'thinking_stop');
    expect(thinkingEvents.length).toBeGreaterThan(0);

    const thinkingStopEvent = events.find((e) => e.type === 'thinking_stop');
    expect(thinkingStopEvent).toBeDefined();
    expect(thinkingStopEvent.text).toBe('I need to analyze what the user wants.');

    // Verify transcript was saved with thinking content
    const transcript = getTranscriptByConversationId(conv.id);
    expect(transcript).not.toBeNull();

    const messages = JSON.parse(transcript!.transcript);
    expect(messages.length).toBeGreaterThanOrEqual(1);

    // The user message should be first
    expect(messages[0].role).toBe('user');

    // Find the done event which contains the assistant message
    const doneEvent = events.find((e) => e.type === 'done');
    expect(doneEvent).toBeDefined();
    expect(doneEvent.assistantMessage.content).toBe('Here is my thoughtful response.');

    // The transcript should NOT include a separate assistant message since no tool calls happened
    // (the agent loop exits before pushing an assistant message when there are no tool calls)
    // But the thinking text should be retrievable — check that it would be on the assistant entry
    // if tool calls had been made. For the no-tool-call path, verify the thinking was at least
    // captured in the stream events above.
    // With tool calls, thinking IS captured on the assistant message — let's test that path too.
  });

  it('captures thinking on assistant message in transcript when tools are called', async () => {
    const conv = createConversation('Thinking with tools');

    const mockProvider = createMockLlmProvider();
    let callCount = 0;
    // First call: streaming with thinking + tool call; Second call: plain response
    (mockProvider as any).chatWithToolsStream = async function* () {
      callCount++;
      if (callCount === 1) {
        yield { type: 'thinking_start' };
        yield { type: 'thinking_stop', text: 'I should navigate to the site first.' };
        yield { type: 'content_start' };
        yield { type: 'content_stop', text: 'Let me check the site.' };
        yield { type: 'tool_call_start', id: 'tc-1', name: 'browser_goto' };
        yield { type: 'tool_call_stop', toolCall: { id: 'tc-1', name: 'browser_goto', arguments: '{"url":"https://example.com"}' } };
        yield { type: 'message_stop' };
        return {
          content: 'Let me check the site.',
          toolCalls: [{ id: 'tc-1', name: 'browser_goto', arguments: '{"url":"https://example.com"}' }],
        };
      }
      // Second call: no thinking, just final response
      yield { type: 'content_start' };
      yield { type: 'content_stop', text: 'The page loaded successfully.' };
      yield { type: 'message_stop' };
      return { content: 'The page loaded successfully.', toolCalls: [] };
    };

    // Mock executeAgentTool
    const { executeAgentTool } = await import('../agentTools.js');
    (executeAgentTool as any).mockResolvedValue({
      stringForLlm: JSON.stringify({ ok: true, url: 'https://example.com' }),
    });

    const ctx = buildContext({ transcriptLogging: true, llmProvider: mockProvider });
    const app = express();
    app.use(express.json());
    app.use(createTeachRouter(ctx));

    const { status } = await postAgentStreaming(app, {
      messages: [{ role: 'user', content: 'Navigate to example.com' }],
      conversationId: conv.id,
      packId: 'thinking-tools-pack',
    });

    expect(status).toBe(200);

    // Verify transcript was saved
    const transcript = getTranscriptByConversationId(conv.id);
    expect(transcript).not.toBeNull();

    const messages = JSON.parse(transcript!.transcript);

    // Find the assistant message that has tool_calls (first LLM response)
    const assistantWithTools = messages.find(
      (m: any) => m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0
    );
    expect(assistantWithTools).toBeDefined();
    expect(assistantWithTools.thinking).toBe('I should navigate to the site first.');
    expect(assistantWithTools.content).toBe('Let me check the site.');
    expect(assistantWithTools.tool_calls).toHaveLength(1);
    expect(assistantWithTools.tool_calls[0].name).toBe('browser_goto');
  });
});
