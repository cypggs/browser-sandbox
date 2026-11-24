import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BrowserController } from './controller.js';

export function createBrowserMcpServer(controller: BrowserController): McpServer {
  const server = new McpServer({
    name: 'browser-sandbox',
    version: '1.0.0',
  });

  server.tool(
    'browser_status',
    'Get current Browser Sandbox status, active tab, and diagnostics.',
    {},
    async () => {
      const data = await controller.status();
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    'browser_tabs',
    'List open tabs, create a new tab, switch tab, or close a tab.',
    {
      action: z.enum(['list', 'create', 'switch', 'close']).default('list'),
      index: z.number().int().min(0).optional(),
      url: z.string().optional(),
    },
    async ({ action, index, url }) => {
      let data: unknown;
      if (action === 'create') data = await controller.createTab(url);
      else if (action === 'switch') data = await controller.switchTab(index ?? 0);
      else if (action === 'close') data = await controller.closeTab(index ?? 0);
      else data = await controller.listTabs();
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    'browser_navigate',
    'Navigate the live Chromium browser to a URL or go back/forward/reload.',
    {
      url: z.string().optional(),
      action: z.enum(['goto', 'back', 'forward', 'reload']).default('goto'),
      waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle', 'commit']).default('domcontentloaded'),
      tabIndex: z.number().int().min(0).optional(),
    },
    async (args) => {
      const data = await controller.navigate(args);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    'browser_click',
    'Click an element by CSS/Playwright selector or x/y coordinates. High-risk buttons require confirmed=true.',
    {
      selector: z.string().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      frame: z.string().optional(),
      confirmed: z.boolean().optional(),
      tabIndex: z.number().int().min(0).optional(),
    },
    async (args) => {
      const data = await controller.click(args);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    'browser_type',
    'Type or fill text into an input element.',
    {
      selector: z.string(),
      text: z.string(),
      clear: z.boolean().default(true),
      pressEnter: z.boolean().default(false),
      frame: z.string().optional(),
      tabIndex: z.number().int().min(0).optional(),
    },
    async (args) => {
      const data = await controller.type(args);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    'browser_scroll',
    'Scroll the page by deltaX/deltaY, to a selector, or to top/bottom.',
    {
      deltaX: z.number().optional(),
      deltaY: z.number().optional(),
      selector: z.string().optional(),
      position: z.enum(['top', 'bottom']).optional(),
      tabIndex: z.number().int().min(0).optional(),
    },
    async (args) => {
      const data = await controller.scroll(args);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    'browser_get_page',
    'Read page title, URL, visible text, Accessibility snapshot, and optionally HTML DOM.',
    {
      includeText: z.boolean().default(true),
      includeAccessibility: z.boolean().default(true),
      includeHtml: z.boolean().default(false),
      frame: z.string().optional(),
      tabIndex: z.number().int().min(0).optional(),
    },
    async (args) => {
      const data = await controller.getPageInfo(args);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    'browser_screenshot',
    'Capture a screenshot of the current page or element and return metadata (and optional image).',
    {
      fullPage: z.boolean().default(false),
      selector: z.string().optional(),
      returnImage: z.boolean().default(true),
      tabIndex: z.number().int().min(0).optional(),
    },
    async ({ fullPage, selector, returnImage, tabIndex }) => {
      const res = await controller.screenshot({
        fullPage,
        selector,
        format: 'png',
        returnBase64: returnImage,
        tabIndex,
      });
      const content: Array<
        { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
      > = [
        {
          type: 'text',
          text: JSON.stringify({ filename: res.filename, path: res.path, bytes: res.bytes }, null, 2),
        },
      ];
      if (returnImage && res.base64) {
        content.push({ type: 'image', data: res.base64, mimeType: 'image/png' });
      }
      return { content };
    }
  );

  server.tool(
    'browser_wait',
    'Wait for a selector, page load state, or timeout milliseconds.',
    {
      selector: z.string().optional(),
      state: z.enum(['attached', 'detached', 'visible', 'hidden']).optional(),
      loadState: z.enum(['load', 'domcontentloaded', 'networkidle']).optional(),
      ms: z.number().int().min(0).max(30000).optional(),
      tabIndex: z.number().int().min(0).optional(),
    },
    async (args) => {
      const data = await controller.wait(args);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    'browser_keyboard',
    'Send keyboard events (press, type, down, up).',
    {
      action: z.enum(['press', 'type', 'down', 'up']),
      key: z.string().optional(),
      text: z.string().optional(),
      tabIndex: z.number().int().min(0).optional(),
    },
    async (args) => {
      const data = await controller.keyboard(args);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    'browser_evaluate',
    'Execute JavaScript in the active browser page.',
    {
      expression: z.string(),
      frame: z.string().optional(),
      confirmed: z.boolean().optional(),
      tabIndex: z.number().int().min(0).optional(),
    },
    async (args) => {
      const data = await controller.evaluate(args);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    'browser_logs',
    'Retrieve recent sanitized console logs, page errors, network errors, and dialogs.',
    {
      limit: z.number().int().min(1).max(200).default(50),
    },
    async ({ limit }) => {
      const data = controller.getLogs(limit);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  return server;
}
