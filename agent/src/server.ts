import express, { type Request, type Response, type NextFunction } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { BrowserRuntimeManager } from './browser.js';
import { BrowserController } from './controller.js';
import { createBrowserMcpServer } from './mcp.js';
import { ScreenshotService } from './screenshot.js';
import { HighRiskActionError, createAuthMiddleware, sanitizeText } from './security.js';

const HOST = process.env.AGENT_HOST || '0.0.0.0';
const PORT = Number(process.env.AGENT_PORT || '3800');
const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';
const DOWNLOADS_DIR = process.env.DOWNLOADS_DIR || '/data/downloads';
const SCREENSHOTS_DIR = process.env.SCREENSHOTS_DIR || '/data/screenshots';
const API_TOKEN = process.env.API_TOKEN || '';

if (!API_TOKEN) {
  console.error('[agent] ERROR: API_TOKEN environment variable must be set.');
  process.exit(1);
}

const runtime = new BrowserRuntimeManager({ cdpUrl: CDP_URL, downloadsDir: DOWNLOADS_DIR });
const screenshots = new ScreenshotService(SCREENSHOTS_DIR);
const controller = new BrowserController({ runtime, screenshots, downloadsDir: DOWNLOADS_DIR });

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '5mb' }));

// Minimal sanitized request logging (never logs headers, cookies, or request bodies)
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    console.log(`[agent] ${req.method} ${req.path} -> ${res.statusCode} (${ms}ms)`);
  });
  next();
});

const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  async (req: Request, res: Response): Promise<void> => {
    try {
      const data = await fn(req, res);
      if (!res.headersSent) {
        res.json({ ok: true, data });
      }
    } catch (err) {
      if (err instanceof HighRiskActionError) {
        res.status(err.statusCode).json({
          ok: false,
          code: err.code,
          error: err.message,
          matchedRule: err.matchedRule,
          targetSummary: err.targetSummary,
          screenshotPath: err.screenshotPath,
        });
        return;
      }
      const typedErr = err as Error & { errorScreenshot?: string };
      res.status(400).json({
        ok: false,
        error: sanitizeText(typedErr.message || String(err)),
        errorScreenshot: typedErr.errorScreenshot,
      });
    }
  };

// Health endpoint (minimal info, no auth required for Docker/Nginx health checks)
app.get(
  '/health',
  wrap(async () => {
    let browserConnected = runtime.isConnected();
    if (!browserConnected) {
      try {
        await runtime.connect();
        browserConnected = true;
      } catch {
        browserConnected = false;
      }
    }
    return {
      status: browserConnected ? 'ok' : 'degraded',
      browserConnected,
      timestamp: new Date().toISOString(),
    };
  })
);

// All /browser/* and /mcp endpoints require Bearer token or X-API-Key
const requireAuth = createAuthMiddleware(API_TOKEN);

app.get('/browser/status', requireAuth, wrap(async () => controller.status()));
app.get('/browser/tabs', requireAuth, wrap(async () => controller.listTabs()));
app.post('/browser/tabs', requireAuth, wrap(async (req) => controller.createTab(req.body?.url)));
app.post(
  '/browser/tabs/switch',
  requireAuth,
  wrap(async (req) => controller.switchTab(Number(req.body?.index)))
);
app.delete(
  '/browser/tabs/:index',
  requireAuth,
  wrap(async (req) => controller.closeTab(Number(req.params.index)))
);

app.post('/browser/navigate', requireAuth, wrap(async (req) => controller.navigate(req.body || {})));
app.post('/browser/click', requireAuth, wrap(async (req) => controller.click(req.body || {})));
app.post('/browser/type', requireAuth, wrap(async (req) => controller.type(req.body || {})));
app.post('/browser/keyboard', requireAuth, wrap(async (req) => controller.keyboard(req.body || {})));
app.post('/browser/mouse', requireAuth, wrap(async (req) => controller.mouse(req.body || {})));
app.post('/browser/scroll', requireAuth, wrap(async (req) => controller.scroll(req.body || {})));
app.post('/browser/screenshot', requireAuth, wrap(async (req) => controller.screenshot(req.body || {})));

app.get(
  '/browser/page',
  requireAuth,
  wrap(async (req) =>
    controller.getPageInfo({
      includeHtml: req.query.html === 'true',
      includeText: req.query.text !== 'false',
      includeAccessibility: req.query.accessibility !== 'false',
      maxLength: req.query.maxLength ? Number(req.query.maxLength) : undefined,
      frame: typeof req.query.frame === 'string' ? req.query.frame : undefined,
      tabIndex: req.query.tabIndex !== undefined ? Number(req.query.tabIndex) : undefined,
    })
  )
);

app.post('/browser/evaluate', requireAuth, wrap(async (req) => controller.evaluate(req.body || {})));
app.post('/browser/wait', requireAuth, wrap(async (req) => controller.wait(req.body || {})));
app.post('/browser/upload', requireAuth, wrap(async (req) => controller.upload(req.body || {})));
app.get('/browser/downloads', requireAuth, wrap(async () => controller.listDownloads()));
app.get(
  '/browser/logs',
  requireAuth,
  wrap(async (req) => controller.getLogs(req.query.limit ? Number(req.query.limit) : 50))
);
app.post(
  '/browser/dialog',
  requireAuth,
  wrap(async (req) =>
    controller.configureDialog({
      mode: req.body?.mode || 'manual',
      promptText: req.body?.promptText,
    })
  )
);

app.post(
  '/browser/action',
  requireAuth,
  wrap(async (req) => {
    if (Array.isArray(req.body?.actions)) {
      const results = [];
      for (const step of req.body.actions) {
        results.push(await controller.executeAction(step));
      }
      return { results };
    }
    return controller.executeAction(req.body || {});
  })
);

// Stateless Streamable HTTP MCP endpoint for AI agents
app.post('/mcp', requireAuth, async (req: Request, res: Response) => {
  try {
    const mcpServer = createBrowserMcpServer(controller);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on('close', () => {
      transport.close().catch(() => undefined);
      mcpServer.close().catch(() => undefined);
    });
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: sanitizeText(err instanceof Error ? err.message : String(err)) },
        id: null,
      });
    }
  }
});

const server = app.listen(PORT, HOST, () => {
  console.log(`[agent] AI Control API & MCP server listening on http://${HOST}:${PORT}`);
  runtime
    .connect()
    .then(() => console.log('[agent] Connected to live Chromium instance over CDP.'))
    .catch((err) => console.warn('[agent] Initial CDP connect pending:', err instanceof Error ? err.message : String(err)));
});

const shutdown = async () => {
  console.log('[agent] Shutting down...');
  server.close();
  await runtime.close();
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
