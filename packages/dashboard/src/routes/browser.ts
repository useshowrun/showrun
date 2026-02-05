import { Router, type Request, type Response } from 'express';
import type { DashboardContext } from '../types/context.js';
import { createTokenChecker } from '../helpers/auth.js';
import {
  startBrowserSession,
  gotoUrl,
  goBack,
  typeInElement,
  takeScreenshot,
  getLinks,
  getDomSnapshot,
  networkList,
  networkSearch,
  networkGet,
  networkGetResponse,
  networkReplay,
  networkClear,
  getLastActions,
  closeSession,
} from '../browserInspector.js';

export function createBrowserRouter(ctx: DashboardContext): Router {
  const router = Router();
  const requireToken = createTokenChecker(ctx.sessionToken);

  // REST API: Browser Inspector - Start session
  router.post('/api/teach/browser/start', async (req: Request, res: Response) => {
    if (!requireToken(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { headful } = req.body;

    try {
      const sessionId = await startBrowserSession(headful !== false);
      res.json({ sessionId });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // REST API: Browser Inspector - Goto URL
  router.post('/api/teach/browser/goto', async (req: Request, res: Response) => {
    if (!requireToken(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { sessionId, url } = req.body;

    if (!sessionId || !url) {
      return res.status(400).json({ error: 'sessionId and url are required' });
    }

    try {
      const currentUrl = await gotoUrl(sessionId, url);
      res.json({ url: currentUrl });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // REST API: Browser Inspector - Go back
  router.post('/api/teach/browser/go-back', async (req: Request, res: Response) => {
    if (!requireToken(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { sessionId } = req.body;

    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId is required' });
    }

    try {
      const result = await goBack(sessionId);
      res.json(result);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // REST API: Browser Inspector - Type in element
  router.post('/api/teach/browser/type', async (req: Request, res: Response) => {
    if (!requireToken(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { sessionId, text, label, selector, clear } = req.body;

    if (!sessionId || text === undefined) {
      return res.status(400).json({ error: 'sessionId and text are required' });
    }
    if (!label && !selector) {
      return res.status(400).json({ error: 'label or selector is required' });
    }

    try {
      const result = await typeInElement(sessionId, {
        text,
        label: label ?? undefined,
        selector: selector ?? undefined,
        clear: clear !== false,
      });
      res.json(result);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // REST API: Browser Inspector - Screenshot
  router.post('/api/teach/browser/screenshot', async (req: Request, res: Response) => {
    if (!requireToken(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { sessionId } = req.body;

    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId is required' });
    }

    try {
      const result = await takeScreenshot(sessionId);
      res.json(result);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // REST API: Browser Inspector - Get links
  router.post('/api/teach/browser/get-links', async (req: Request, res: Response) => {
    if (!requireToken(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { sessionId } = req.body;

    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId is required' });
    }

    try {
      const result = await getLinks(sessionId);
      res.json(result);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // REST API: Browser Inspector - Get DOM snapshot
  router.post('/api/teach/browser/dom-snapshot', async (req: Request, res: Response) => {
    if (!requireToken(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { sessionId, format, maxDepth } = req.body;

    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId is required' });
    }

    try {
      const result = await getDomSnapshot(sessionId, { format, maxDepth });
      // For YAML format, wrap the snapshot string in an object for consistency
      if (format === 'yaml' || (!format && 'snapshot' in result)) {
        res.json(result);
      } else {
        res.json(result);
      }
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // REST API: Browser Inspector - Network list
  router.post('/api/teach/browser/network-list', async (req: Request, res: Response) => {
    if (!requireToken(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const { sessionId, limit, filter, compact } = req.body;
    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId is required' });
    }
    try {
      // UI endpoint: default to 'all' filter and non-compact (full headers) for debugging
      const list = networkList(sessionId, {
        limit: limit ?? 50,
        filter: filter ?? 'all',
        compact: compact ?? false,
      });
      res.json(list);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // REST API: Browser Inspector - Network search
  router.post('/api/teach/browser/network-search', async (req: Request, res: Response) => {
    if (!requireToken(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const { sessionId, query, limit } = req.body;
    if (!sessionId || query == null) {
      return res.status(400).json({ error: 'sessionId and query are required' });
    }
    try {
      const list = networkSearch(sessionId, String(query).trim(), limit ?? 20);
      res.json(list);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // REST API: Browser Inspector - Network get
  router.post('/api/teach/browser/network-get', async (req: Request, res: Response) => {
    if (!requireToken(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const { sessionId, requestId } = req.body;
    if (!sessionId || !requestId) {
      return res.status(400).json({ error: 'sessionId and requestId are required' });
    }
    try {
      const result = networkGet(sessionId, requestId);
      res.json(result);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // REST API: Browser Inspector - Network get response body
  router.post('/api/teach/browser/network-get-response', async (req: Request, res: Response) => {
    if (!requireToken(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const { sessionId, requestId, full } = req.body;
    if (!sessionId || !requestId) {
      return res.status(400).json({ error: 'sessionId and requestId are required' });
    }
    try {
      const result = networkGetResponse(sessionId, requestId, full === true);
      res.json(result);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // REST API: Browser Inspector - Network replay
  router.post('/api/teach/browser/network-replay', async (req: Request, res: Response) => {
    if (!requireToken(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const { sessionId, requestId, overrides } = req.body;
    if (!sessionId || !requestId) {
      return res.status(400).json({ error: 'sessionId and requestId are required' });
    }
    try {
      const result = await networkReplay(sessionId, requestId, overrides);
      res.json(result);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // REST API: Browser Inspector - Network clear
  router.post('/api/teach/browser/network-clear', async (req: Request, res: Response) => {
    if (!requireToken(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const { sessionId } = req.body;
    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId is required' });
    }
    try {
      networkClear(sessionId);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // REST API: Browser Inspector - Last actions
  router.get('/api/teach/browser/:sessionId/actions', (req: Request, res: Response) => {
    const { sessionId } = req.params;
    const limit = parseInt(req.query.limit as string) || 10;

    try {
      const actions = getLastActions(sessionId, limit);
      res.json(actions);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // REST API: Browser Inspector - Close session
  router.delete('/api/teach/browser/:sessionId', async (req: Request, res: Response) => {
    if (!requireToken(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { sessionId } = req.params;

    try {
      await closeSession(sessionId);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return router;
}
