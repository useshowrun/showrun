import { Router, type Request, type Response } from 'express';
import { rmSync } from 'fs';
import type { DashboardContext } from '../types/context.js';
import { createTokenChecker } from '../helpers/auth.js';
import { TaskPackLoader, validatePathInAllowedDir } from '@showrun/core';
import {
  createConversation,
  getConversation,
  getAllConversations,
  updateConversation,
  deleteConversation,
  addMessage,
  getMessagesForConversation,
  exportConversationForDebug,
} from '../db.js';
import {
  getConversationBrowserSession,
  setConversationBrowserSession,
} from '../agentTools.js';
import { closeSession } from '../browserInspector.js';

export function createConversationsRouter(ctx: DashboardContext): Router {
  const router = Router();
  const requireToken = createTokenChecker(ctx.sessionToken);

  // List all conversations
  router.get('/api/conversations', (_req: Request, res: Response) => {
    const conversations = getAllConversations();
    res.json(conversations);
  });

  // Create new conversation
  router.post('/api/conversations', (req: Request, res: Response) => {
    if (!requireToken(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { title, description, packId } = req.body;
    const conversationTitle = title || 'New Conversation';

    try {
      const conversation = createConversation(conversationTitle, description || null);

      // If packId provided, link it to the new conversation immediately
      if (packId) {
        updateConversation(conversation.id, { packId });
        conversation.packId = packId;
      }

      ctx.io.emit('conversations:updated', getAllConversations());
      res.json(conversation);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Get conversation with messages
  router.get('/api/conversations/:id', (req: Request, res: Response) => {
    const { id } = req.params;
    const conversation = getConversation(id);

    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const messages = getMessagesForConversation(id);
    // Strip agentContext from response — it can be very large and is only used internally
    const messagesWithoutContext = messages.map(({ agentContext, ...rest }) => rest);
    res.json({
      ...conversation,
      messages: messagesWithoutContext,
    });
  });

  // Update conversation
  router.put('/api/conversations/:id', (req: Request, res: Response) => {
    if (!requireToken(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { id } = req.params;
    const { title, description, status, packId } = req.body;

    try {
      const updated = updateConversation(id, {
        ...(title !== undefined && { title }),
        ...(description !== undefined && { description }),
        ...(status !== undefined && { status }),
        ...(packId !== undefined && { packId }),
      });

      if (!updated) {
        return res.status(404).json({ error: 'Conversation not found' });
      }

      ctx.io.emit('conversations:updated', getAllConversations());
      res.json(updated);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Delete conversation (and its linked pack if any)
  router.delete('/api/conversations/:id', async (req: Request, res: Response) => {
    if (!requireToken(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { id } = req.params;

    try {
      // Get conversation first to check for linked pack
      const conversation = getConversation(id);
      if (!conversation) {
        return res.status(404).json({ error: 'Conversation not found' });
      }

      // Close any active browser session for this conversation
      const existingSessionId = getConversationBrowserSession(id);
      if (existingSessionId) {
        console.log(`[BrowserAuto] Closing browser for deleted conversation ${id}`);
        await closeSession(existingSessionId);
        setConversationBrowserSession(id, null);
      }

      // If conversation has a linked pack, delete it too (1:1 relationship)
      let packDeleted = false;
      if (conversation.packId) {
        const packInfo = ctx.packMap.get(conversation.packId);
        if (packInfo && ctx.workspaceDir) {
          try {
            // Only delete JSON-DSL packs in workspace directory
            const manifest = TaskPackLoader.loadManifest(packInfo.path);
            if (manifest.kind === 'json-dsl') {
              validatePathInAllowedDir(packInfo.path, ctx.workspaceDir);
              rmSync(packInfo.path, { recursive: true, force: true });
              ctx.packMap.delete(conversation.packId);
              packDeleted = true;
              console.log(`[Dashboard] Pack deleted with conversation: ${conversation.packId}`);
            }
          } catch (packErr) {
            // Log but don't fail - pack might be outside workspace or not JSON-DSL
            console.warn(`[Dashboard] Could not delete pack ${conversation.packId}:`, packErr);
          }
        }
      }

      // Delete the conversation
      const deleted = deleteConversation(id);
      if (!deleted) {
        return res.status(404).json({ error: 'Conversation not found' });
      }

      ctx.io.emit('conversations:updated', getAllConversations());
      if (packDeleted) {
        ctx.io.emit('packs:updated', ctx.packMap.size);
      }
      res.json({ success: true, packDeleted });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Get messages for conversation
  router.get('/api/conversations/:id/messages', (req: Request, res: Response) => {
    const { id } = req.params;
    const conversation = getConversation(id);

    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const messages = getMessagesForConversation(id);
    // Strip agentContext from response — it can be very large and is only used internally
    const messagesWithoutContext = messages.map(({ agentContext, ...rest }) => rest);
    res.json(messagesWithoutContext);
  });

  // Export conversation for debugging (includes all messages, tool calls, runs, etc.)
  router.get('/api/conversations/:id/export', (req: Request, res: Response) => {
    const { id } = req.params;
    const format = req.query.format as string | undefined; // 'json' (default) or 'download'

    try {
      const exportData = exportConversationForDebug(id);

      if (!exportData) {
        return res.status(404).json({ error: 'Conversation not found' });
      }

      // Add pack info if linked
      let packInfo: { id: string; name: string; path: string } | null = null;
      if (exportData.conversation.packId) {
        const pack = ctx.packMap.get(exportData.conversation.packId);
        if (pack) {
          packInfo = {
            id: pack.pack.metadata.id,
            name: pack.pack.metadata.name,
            path: pack.path,
          };
        }
      }

      const fullExport = {
        ...exportData,
        packInfo,
      };

      if (format === 'download') {
        // Send as downloadable file
        const filename = `conversation-debug-${id.slice(0, 8)}-${Date.now()}.json`;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(JSON.stringify(fullExport, null, 2));
      } else {
        // Return as regular JSON response
        res.json(fullExport);
      }
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Add message to conversation
  router.post('/api/conversations/:id/messages', (req: Request, res: Response) => {
    if (!requireToken(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { id } = req.params;
    const { role, content, toolCalls, thinkingContent } = req.body;

    if (!role) {
      return res.status(400).json({ error: 'role is required' });
    }

    // Allow empty content if there are tool calls (AI might only use tools without text response)
    const hasToolCalls = Array.isArray(toolCalls) && toolCalls.length > 0;
    if (!content && !hasToolCalls) {
      return res.status(400).json({ error: 'content is required (unless toolCalls are provided)' });
    }

    if (!['user', 'assistant', 'system'].includes(role)) {
      return res.status(400).json({ error: 'role must be user, assistant, or system' });
    }

    const conversation = getConversation(id);
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    try {
      const message = addMessage(id, role, content, toolCalls, thinkingContent);
      res.json(message);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return router;
}
