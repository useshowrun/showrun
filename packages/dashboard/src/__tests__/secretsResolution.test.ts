/**
 * Integration tests for secrets resolution in dashboard agent tools.
 * Tests the bug scenario where secrets fail to resolve in templates ({{secret.VAR_NAME}})
 * after pack creation, linking, and secret setting.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';

import { TaskPackLoader, resolveTemplates } from '@showrun/core';
import { executeAgentTool, type AgentToolContext } from '../agentTools.js';
import { TaskPackEditorWrapper } from '../mcpWrappers.js';
import { setSecretValue, getSecretNamesWithValues } from '../secretsUtils.js';

// Mock database module
vi.mock('../db.js', () => ({
  getConversation: vi.fn(),
  updateConversation: vi.fn(),
  initDatabase: vi.fn(),
  getDatabase: vi.fn(),
}));

// Mock browserInspector
vi.mock('../browserInspector.js', () => ({
  startBrowserSession: vi.fn().mockResolvedValue('mock-session'),
  gotoUrl: vi.fn().mockResolvedValue('https://example.com'),
  typeInElement: vi.fn().mockResolvedValue({ url: 'https://example.com', typed: true }),
  closeSession: vi.fn(),
  getSession: vi.fn().mockReturnValue(null),
  isSessionAlive: vi.fn().mockReturnValue(false), // Force new session creation
}));

// Mock contextManager
vi.mock('../contextManager.js', () => ({
  executePlanTool: vi.fn().mockReturnValue('{}'),
}));

describe('Secrets Resolution Integration', () => {
  let testDir: string;
  let packDir: string;
  let runsDir: string;
  let taskPackEditor: TaskPackEditorWrapper;

  const TEST_PACK_ID = 'test.secrets.pack';
  const CONVERSATION_ID = 'conv-123';

  beforeEach(async () => {
    // Create unique test directory
    testDir = join(tmpdir(), `showrun-test-${randomBytes(8).toString('hex')}`);
    packDir = join(testDir, 'taskpacks');
    runsDir = join(testDir, 'runs');

    mkdirSync(packDir, { recursive: true });
    mkdirSync(runsDir, { recursive: true });

    taskPackEditor = new TaskPackEditorWrapper([packDir], packDir, runsDir, false);

    // Setup database mocks
    const db = await import('../db.js');
    vi.mocked(db.getConversation).mockReturnValue({
      id: CONVERSATION_ID,
      title: 'Test',
      description: null,
      status: 'active',
      packId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    vi.mocked(db.updateConversation).mockImplementation((id, updates) => ({
      ...db.getConversation(id)!,
      ...updates,
      updatedAt: Date.now(),
    }));
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    vi.clearAllMocks();
  });

  describe('Direct template resolution', () => {
    it('should resolve {{secret.PASSWORD}} with resolveTemplates', () => {
      const secrets = { PASSWORD: 'secret123' };
      const resolved = resolveTemplates('{{secret.PASSWORD}}', {
        inputs: {},
        vars: {},
        secrets,
      });
      expect(resolved).toBe('secret123');
    });

    it('should resolve multiple secrets in a single template', () => {
      const secrets = { USERNAME: 'john', PASSWORD: 'secret123' };
      const resolved = resolveTemplates('User: {{secret.USERNAME}}, Pass: {{secret.PASSWORD}}', {
        inputs: {},
        vars: {},
        secrets,
      });
      expect(resolved).toBe('User: john, Pass: secret123');
    });

    it('should return empty string for undefined secrets', () => {
      const secrets = {};
      const resolved = resolveTemplates('{{secret.MISSING}}', {
        inputs: {},
        vars: {},
        secrets,
      });
      expect(resolved).toBe('');
    });
  });

  describe('TaskPackLoader.loadSecrets', () => {
    it('should load secrets from .secrets.json file', async () => {
      // Create pack first
      const createResult = await executeAgentTool(
        'editor_create_pack',
        { id: TEST_PACK_ID, name: 'Test Pack' },
        { taskPackEditor, conversationId: CONVERSATION_ID, packId: null }
      );
      const createData = JSON.parse(createResult.stringForLlm);
      const packPath = createData.path;

      // Set a secret
      setSecretValue(packPath, 'PASSWORD', 'secret123');

      // Load secrets using TaskPackLoader
      const secrets = TaskPackLoader.loadSecrets(packPath);
      expect(secrets.PASSWORD).toBe('secret123');
    });

    it('should return empty object for pack without secrets', async () => {
      // Create pack first
      const createResult = await executeAgentTool(
        'editor_create_pack',
        { id: 'test.no.secrets', name: 'Test Pack No Secrets' },
        { taskPackEditor, conversationId: CONVERSATION_ID, packId: null }
      );
      const createData = JSON.parse(createResult.stringForLlm);
      const packPath = createData.path;

      // Load secrets (should be empty)
      const secrets = TaskPackLoader.loadSecrets(packPath);
      expect(secrets).toEqual({});
    });
  });

  describe('Full workflow: create -> link -> secrets -> resolve', () => {
    it('should resolve {{secret.PASSWORD}} after setting secret in pack', async () => {
      // 1. Create pack
      const createResult = await executeAgentTool(
        'editor_create_pack',
        { id: TEST_PACK_ID, name: 'Test Pack' },
        { taskPackEditor, conversationId: CONVERSATION_ID, packId: null }
      );
      const createData = JSON.parse(createResult.stringForLlm);
      expect(createData.id).toBe(TEST_PACK_ID);
      const packPath = createData.path;

      // 2. Link pack to conversation
      const linkResult = await executeAgentTool(
        'conversation_link_pack',
        { packId: TEST_PACK_ID },
        { taskPackEditor, conversationId: CONVERSATION_ID, packId: null }
      );
      expect(JSON.parse(linkResult.stringForLlm).success).toBe(true);

      // 3. Set secret value
      setSecretValue(packPath, 'PASSWORD', 'secret123');

      // 4. Verify secret was stored
      const secrets = TaskPackLoader.loadSecrets(packPath);
      expect(secrets.PASSWORD).toBe('secret123');

      // 5. Test direct template resolution
      const resolved = resolveTemplates('{{secret.PASSWORD}}', {
        inputs: {},
        vars: {},
        secrets,
      });
      expect(resolved).toBe('secret123');
    });

    it('should resolve secrets in browser_type when packId is set in context', async () => {
      // Create pack and set secret
      const createResult = await executeAgentTool(
        'editor_create_pack',
        { id: TEST_PACK_ID, name: 'Test Pack' },
        { taskPackEditor, conversationId: CONVERSATION_ID, packId: null }
      );
      const packPath = JSON.parse(createResult.stringForLlm).path;
      setSecretValue(packPath, 'API_KEY', 'sk-test-123');

      // Context WITH packId set (critical for resolution)
      const ctx: AgentToolContext = {
        taskPackEditor,
        conversationId: CONVERSATION_ID,
        packId: TEST_PACK_ID, // MUST be set after linking for template resolution
      };

      // Call browser_type with template (sessionId is auto-injected)
      await executeAgentTool(
        'browser_type',
        { text: '{{secret.API_KEY}}', label: 'Key' },
        ctx
      );

      // Verify typeInElement was called with resolved secret
      // Session ID is auto-generated, so we use expect.any(String)
      const { typeInElement } = await import('../browserInspector.js');
      expect(typeInElement).toHaveBeenCalledWith(
        expect.any(String), // auto-generated session ID
        expect.objectContaining({ text: 'sk-test-123' })
      );
    });

    it('should NOT resolve secrets when packId is null (but should fail on missing conversationId)', async () => {
      // With the new architecture, browser tools require a conversation context
      // to manage the auto-session. This test verifies the error handling.
      const ctx: AgentToolContext = {
        taskPackEditor,
        conversationId: null as any, // No conversation - browser tools should fail
        packId: null, // No pack linked
      };

      const result = await executeAgentTool(
        'browser_type',
        { text: '{{secret.MISSING}}', label: 'Test' },
        ctx
      );

      // Without conversationId, browser tools should return an error
      const parsed = JSON.parse(result.stringForLlm);
      expect(parsed.error).toContain('Browser tools require a conversation context');
    });
  });

  describe('request_secrets tool', () => {
    it('returns secrets_request signal with correct structure', async () => {
      const result = await executeAgentTool(
        'request_secrets',
        {
          secrets: [{ name: 'API_KEY', required: true, description: 'The API key' }],
          message: 'Need API key to proceed',
        },
        { taskPackEditor, conversationId: CONVERSATION_ID, packId: TEST_PACK_ID }
      );

      const data = JSON.parse(result.stringForLlm);
      expect(data._type).toBe('secrets_request');
      expect(data.secrets).toHaveLength(1);
      expect(data.secrets[0].name).toBe('API_KEY');
      expect(data.secrets[0].required).toBe(true);
      expect(data.message).toBe('Need API key to proceed');
    });

    it('returns error for empty secrets array', async () => {
      const result = await executeAgentTool(
        'request_secrets',
        { secrets: [], message: 'Need secrets' },
        { taskPackEditor, conversationId: CONVERSATION_ID, packId: TEST_PACK_ID }
      );

      const data = JSON.parse(result.stringForLlm);
      expect(data.error).toBeDefined();
      expect(data.error).toContain('secrets array is required');
    });

    it('returns error for missing message', async () => {
      const result = await executeAgentTool(
        'request_secrets',
        { secrets: [{ name: 'KEY' }], message: '' },
        { taskPackEditor, conversationId: CONVERSATION_ID, packId: TEST_PACK_ID }
      );

      const data = JSON.parse(result.stringForLlm);
      expect(data.error).toBeDefined();
      expect(data.error).toContain('message is required');
    });
  });

  describe('editor_list_secrets tool', () => {
    it('lists secrets with hasValue status after setting', async () => {
      // Create pack
      const createResult = await executeAgentTool(
        'editor_create_pack',
        { id: TEST_PACK_ID, name: 'Test Pack' },
        { taskPackEditor, conversationId: CONVERSATION_ID, packId: null }
      );
      const packPath = JSON.parse(createResult.stringForLlm).path;

      // Set a secret
      setSecretValue(packPath, 'PASSWORD', 'secret123');

      // Verify using getSecretNamesWithValues
      const secretInfos = getSecretNamesWithValues(packPath);
      const passwordSecret = secretInfos.find((s) => s.name === 'PASSWORD');

      expect(passwordSecret).toBeDefined();
      expect(passwordSecret!.hasValue).toBe(true);
      expect(passwordSecret!.preview).toBe('se******'); // First 2 chars + asterisks
    });
  });

  describe('Context propagation after conversation_link_pack', () => {
    it('packId in conversation is updated after link_pack', async () => {
      const db = await import('../db.js');

      // Create pack
      await executeAgentTool(
        'editor_create_pack',
        { id: TEST_PACK_ID, name: 'Test Pack' },
        { taskPackEditor, conversationId: CONVERSATION_ID, packId: null }
      );

      // Link pack
      await executeAgentTool(
        'conversation_link_pack',
        { packId: TEST_PACK_ID },
        { taskPackEditor, conversationId: CONVERSATION_ID, packId: null }
      );

      // Verify updateConversation was called with packId
      expect(db.updateConversation).toHaveBeenCalledWith(
        CONVERSATION_ID,
        expect.objectContaining({ packId: TEST_PACK_ID })
      );
    });
  });

  /**
   * NEW ARCHITECTURE TEST: Automatic Pack Initialization
   *
   * With the new 1:1 conversation-pack architecture:
   * 1. Pack is created automatically BEFORE the main agent loop starts (via runPackInitializer)
   * 2. Context is created with effectivePackId already set
   * 3. Main agent does NOT have access to editor_create_pack or conversation_link_pack
   * 4. Secrets always resolve correctly because packId is set from the start
   */
  describe('NEW: Automatic pack initialization ensures secrets always resolve', () => {
    it('secrets resolve correctly when packId is set from the start (new architecture)', async () => {
      const { typeInElement } = await import('../browserInspector.js');
      vi.mocked(typeInElement).mockClear();

      // Create pack first (simulating what runPackInitializer does before agent loop)
      const createResult = await executeAgentTool(
        'editor_create_pack',
        { id: TEST_PACK_ID, name: 'Test Pack' },
        { taskPackEditor, conversationId: CONVERSATION_ID, packId: null }
      );
      const packPath = JSON.parse(createResult.stringForLlm).path;

      // Link pack to conversation (also done by runPackInitializer)
      await executeAgentTool(
        'conversation_link_pack',
        { packId: TEST_PACK_ID },
        { taskPackEditor, conversationId: CONVERSATION_ID, packId: null }
      );

      // User provides secret via UI
      setSecretValue(packPath, 'PASSWORD', 'my-secret-password');

      // NEW: In the new architecture, the main agent context has packId set from the start
      // This simulates the effectivePackId being set in server.ts BEFORE the agent loop
      const ctx: AgentToolContext = {
        taskPackEditor,
        conversationId: CONVERSATION_ID,
        packId: TEST_PACK_ID, // <-- Already set! Not null like before.
      };

      // Agent types the secret (sessionId is auto-injected)
      await executeAgentTool(
        'browser_type',
        { text: '{{secret.PASSWORD}}', label: 'Password' },
        ctx
      );

      // SUCCESS: typeInElement receives the resolved secret
      expect(typeInElement).toHaveBeenCalledWith(
        'mock-session',
        expect.objectContaining({ text: 'my-secret-password' })
      );
    });

    it('main agent tool list excludes pack creation/linking tools', async () => {
      // Import the filtered tool definitions
      const { MAIN_AGENT_TOOL_DEFINITIONS } = await import('../agentTools.js');

      // Verify editor_create_pack is NOT in the main agent's tool list
      const hasCreatePack = MAIN_AGENT_TOOL_DEFINITIONS.some(
        (t) => t.function.name === 'editor_create_pack'
      );
      expect(hasCreatePack).toBe(false);

      // Verify conversation_link_pack is NOT in the main agent's tool list
      const hasLinkPack = MAIN_AGENT_TOOL_DEFINITIONS.some(
        (t) => t.function.name === 'conversation_link_pack'
      );
      expect(hasLinkPack).toBe(false);

      // Verify other tools ARE in the list
      const hasReadPack = MAIN_AGENT_TOOL_DEFINITIONS.some(
        (t) => t.function.name === 'editor_read_pack'
      );
      expect(hasReadPack).toBe(true);

      // Verify browser_goto is in the list (browser_start_session was removed - sessions are auto-managed)
      const hasBrowserGoto = MAIN_AGENT_TOOL_DEFINITIONS.some(
        (t) => t.function.name === 'browser_goto'
      );
      expect(hasBrowserGoto).toBe(true);
    });

    it('editor_create_pack returns error when packId already linked', async () => {
      // Context with packId already set (like in new architecture)
      const ctx: AgentToolContext = {
        taskPackEditor,
        conversationId: CONVERSATION_ID,
        packId: 'existing.pack.id', // Already linked!
      };

      // Try to create another pack
      const result = await executeAgentTool(
        'editor_create_pack',
        { id: 'another.pack', name: 'Another Pack' },
        ctx
      );

      const parsed = JSON.parse(result.stringForLlm);
      expect(parsed.error).toContain('A pack is already linked');
      expect(parsed.existingPackId).toBe('existing.pack.id');
    });
  });

  describe('Edge cases', () => {
    it('handles TOTP secret with totp filter', async () => {
      // Note: This test just verifies the template syntax is preserved
      // Actual TOTP generation would require a valid base32 secret
      const secrets = { TOTP_KEY: 'JBSWY3DPEHPK3PXP' }; // Example base32 secret

      // Test that the filter exists and works with valid input
      const resolved = resolveTemplates('{{secret.TOTP_KEY | totp}}', {
        inputs: {},
        vars: {},
        secrets,
      });

      // TOTP generates a 6-digit code
      expect(resolved).toMatch(/^\d{6}$/);
    });

    it('handles nested templates with secrets and inputs', () => {
      const context = {
        inputs: { baseUrl: 'https://api.example.com' },
        vars: { endpoint: '/users' },
        secrets: { API_KEY: 'sk-123' },
      };

      const template = '{{inputs.baseUrl}}{{vars.endpoint}}?key={{secret.API_KEY}}';
      const resolved = resolveTemplates(template, context);
      expect(resolved).toBe('https://api.example.com/users?key=sk-123');
    });

    it('preserves non-template strings', () => {
      const result = resolveTemplates('no templates here', {
        inputs: {},
        vars: {},
        secrets: {},
      });
      expect(result).toBe('no templates here');
    });
  });
});
