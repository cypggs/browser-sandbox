import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { BrowserRuntimeManager } from './browser.js';
import { BrowserController } from './controller.js';
import { createBrowserMcpServer } from './mcp.js';
import { ScreenshotService } from './screenshot.js';

async function main() {
  const cdpUrl = process.env.CDP_URL || 'http://127.0.0.1:9222';
  const downloadsDir = process.env.DOWNLOADS_DIR || '/opt/browser-sandbox/data/downloads';
  const screenshotsDir = process.env.SCREENSHOTS_DIR || '/opt/browser-sandbox/data/screenshots';

  const runtime = new BrowserRuntimeManager({ cdpUrl, downloadsDir });
  const screenshots = new ScreenshotService(screenshotsDir);
  const controller = new BrowserController({ runtime, screenshots, downloadsDir });
  const server = createBrowserMcpServer(controller);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('[mcp-stdio] Fatal error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
