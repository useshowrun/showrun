import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { createServer, request as httpRequest } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import {
  closeDatabase,
  createConversation,
  getConversation,
  initDatabase,
  updateConversation,
} from '../db.js';
import { createConversationsRouter } from '../routes/conversations.js';
import { createPacksRouter } from '../routes/packs.js';
import type { DashboardContext } from '../types/context.js';

const openHttpServers: ReturnType<typeof createServer>[] = [];
const openIoServers: SocketIOServer[] = [];

function createTestContext(workspaceDir: string): DashboardContext {
  const httpServer = createServer();
  const io = new SocketIOServer(httpServer);
  openHttpServers.push(httpServer);
  openIoServers.push(io);

  return {
    sessionToken: 'test-token',
    packDirs: [workspaceDir],
    workspaceDir,
    baseRunDir: join(workspaceDir, 'runs'),
    headful: false,
    debug: false,
    transcriptLogging: false,
    packMap: new Map(),
    runManager: { getAllRuns: () => [] } as any,
    concurrencyLimiter: {} as any,
    mcpServer: { handle: null, packIds: [], runIdMap: new Map() },
    io,
    resultStores: new Map(),
    taskPackEditor: {} as any,
    llmProvider: null,
    systemPrompt: 'test',
    pendingSecretsRequests: new Map(),
    techniqueManager: null,
  };
}

function createJsonDslPack(workspaceDir: string, packId: string) {
  const packDir = join(workspaceDir, packId);
  mkdirSync(packDir, { recursive: true });
  writeFileSync(join(packDir, 'taskpack.json'), JSON.stringify({
    id: packId,
    name: `Pack ${packId}`,
    version: '0.1.0',
    description: 'Test pack',
    kind: 'json-dsl',
  }, null, 2));
  writeFileSync(join(packDir, 'flow.json'), JSON.stringify({
    inputs: {},
    collectibles: [],
    flow: [],
  }, null, 2));
  return packDir;
}

async function requestJson(
  app: express.Express,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not resolve test server address'));
        return;
      }

      const bodyText = init.body == null
        ? undefined
        : typeof init.body === 'string'
          ? init.body
          : JSON.stringify(init.body);

      const finish = (callback: () => void) => {
        server.close(() => callback());
      };

      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: address.port,
          path,
          method: init.method || 'GET',
          headers: {
            connection: 'close',
            ...(bodyText ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(bodyText) } : {}),
            ...(init.headers as Record<string, string> | undefined),
          },
        },
        (res) => {
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            data += chunk;
          });
          res.on('end', () => {
            finish(() => {
              const body = data ? JSON.parse(data) : null;
              resolve({ status: res.statusCode || 500, body });
            });
          });
        }
      );
      req.on('error', (error) => {
        finish(() => reject(error));
      });
      if (bodyText) req.write(bodyText);
      req.end();
    });
  });
}

describe('shared pack lifecycle routes', () => {
  let testDir: string;
  let workspaceDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `showrun-shared-pack-${randomBytes(8).toString('hex')}`);
    workspaceDir = join(testDir, 'workspace');
    mkdirSync(workspaceDir, { recursive: true });
    initDatabase(testDir);
  });

  afterEach(async () => {
    for (const io of openIoServers.splice(0)) {
      io.close();
    }
    for (const server of openHttpServers.splice(0)) {
      if (!server.listening) continue;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    closeDatabase();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('deleting a conversation keeps the linked pack intact', async () => {
    const ctx = createTestContext(workspaceDir);
    const packDir = createJsonDslPack(workspaceDir, 'shared-pack');
    ctx.packMap.set('shared-pack', {
      pack: { metadata: { id: 'shared-pack', name: 'Shared Pack', version: '0.1.0' } } as any,
      path: packDir,
    });

    const conversation = createConversation('Conversation A');
    updateConversation(conversation.id, { packId: 'shared-pack' });

    const app = express();
    app.use(express.json());
    app.use(createConversationsRouter(ctx));

    const { status, body } = await requestJson(app, `/api/conversations/${conversation.id}`, {
      method: 'DELETE',
      headers: { 'x-showrun-token': 'test-token' },
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(getConversation(conversation.id)).toBeNull();
    expect(existsSync(packDir)).toBe(true);
    expect(ctx.packMap.has('shared-pack')).toBe(true);
  });

  it('deleting a pack unlinks all conversations that use it', async () => {
    const ctx = createTestContext(workspaceDir);
    const packDir = createJsonDslPack(workspaceDir, 'shared-pack');
    ctx.packMap.set('shared-pack', {
      pack: { metadata: { id: 'shared-pack', name: 'Shared Pack', version: '0.1.0' } } as any,
      path: packDir,
    });

    const conversationA = createConversation('Conversation A');
    const conversationB = createConversation('Conversation B');
    updateConversation(conversationA.id, { packId: 'shared-pack' });
    updateConversation(conversationB.id, { packId: 'shared-pack' });

    const app = express();
    app.use(express.json());
    app.use(createPacksRouter(ctx));

    const usage = await requestJson(app, '/api/packs/shared-pack/usage', {
      headers: { 'x-showrun-token': 'test-token' },
    });
    expect(usage.status).toBe(200);
    expect(usage.body.conversations).toHaveLength(2);

    const deletion = await requestJson(app, '/api/packs/shared-pack', {
      method: 'DELETE',
      headers: { 'x-showrun-token': 'test-token' },
    });

    expect(deletion.status).toBe(200);
    expect(deletion.body.success).toBe(true);
    expect(deletion.body.unlinkedConversationCount).toBe(2);
    expect(getConversation(conversationA.id)?.packId).toBeNull();
    expect(getConversation(conversationB.id)?.packId).toBeNull();
    expect(existsSync(packDir)).toBe(false);
    expect(ctx.packMap.has('shared-pack')).toBe(false);
  });
});
