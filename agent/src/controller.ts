import fs from 'fs/promises';
import path from 'path';
import type { FrameLocator, Page } from 'playwright-core';
import { BrowserRuntimeManager, type DialogPolicy } from './browser.js';
import { ScreenshotService, type ScreenshotOptions } from './screenshot.js';
import {
  HighRiskActionError,
  detectHighRisk,
  resolveSafePath,
  sanitizeText,
  sanitizeUrl,
} from './security.js';

export class BrowserController {
  private readonly runtime: BrowserRuntimeManager;
  private readonly screenshots: ScreenshotService;
  private readonly downloadsDir: string;

  constructor(options: {
    runtime: BrowserRuntimeManager;
    screenshots: ScreenshotService;
    downloadsDir: string;
  }) {
    this.runtime = options.runtime;
    this.screenshots = options.screenshots;
    this.downloadsDir = path.resolve(options.downloadsDir);
  }

  private getScope(page: Page, frameSelector?: string): Page | FrameLocator {
    if (!frameSelector) return page;
    return page.frameLocator(frameSelector);
  }

  private async runWithAutoScreenshot<T>(actionName: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof HighRiskActionError) {
        throw err;
      }
      const screenshotPath = await this.screenshots.captureOnError(
        this.runtime.getCurrentPageUnsafe(),
        actionName
      );
      const wrapped = new Error(sanitizeText(err instanceof Error ? err.message : String(err))) as Error & {
        errorScreenshot?: string;
      };
      wrapped.errorScreenshot = screenshotPath;
      throw wrapped;
    }
  }

  public async status() {
    await this.runtime.connect();
    const diag = this.runtime.getDiagnostics();
    const page = await this.runtime.getActivePage();
    let title = '';
    try {
      title = await page.title();
    } catch {
      title = '';
    }
    return {
      ...diag,
      activeTab: {
        title,
        url: sanitizeUrl(page.url()),
      },
      profileDir: '/opt/browser-sandbox/data/chrome-profile',
      downloadsDir: '/opt/browser-sandbox/data/downloads',
      screenshotsDir: '/opt/browser-sandbox/data/screenshots',
    };
  }

  public async listTabs() {
    await this.runtime.ensureContext();
    const pages = this.runtime.getOpenPages();
    const active = this.runtime.getCurrentPageUnsafe();
    const tabs = await Promise.all(
      pages.map(async (page, index) => {
        let title = '';
        try {
          title = await page.title();
        } catch {
          title = '';
        }
        return {
          index,
          title,
          url: sanitizeUrl(page.url()),
          active: page === active,
        };
      })
    );
    return { count: tabs.length, tabs };
  }

  public async createTab(url?: string) {
    return this.runWithAutoScreenshot('createTab', async () => {
      const context = await this.runtime.ensureContext();
      const page = await context.newPage();
      this.runtime.setActivePage(page);
      await page.bringToFront();
      if (url) {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      }
      const pages = this.runtime.getOpenPages();
      return {
        index: pages.indexOf(page),
        title: await page.title().catch(() => ''),
        url: sanitizeUrl(page.url()),
      };
    });
  }

  public async switchTab(index: number) {
    return this.runWithAutoScreenshot('switchTab', async () => {
      const page = await this.runtime.getActivePage(index);
      return {
        index,
        title: await page.title().catch(() => ''),
        url: sanitizeUrl(page.url()),
      };
    });
  }

  public async closeTab(index: number) {
    return this.runWithAutoScreenshot('closeTab', async () => {
      const pages = this.runtime.getOpenPages();
      if (index < 0 || index >= pages.length) {
        throw new Error(`Invalid tab index ${index}`);
      }
      await pages[index].close();
      return this.listTabs();
    });
  }

  public async navigate(params: {
    url?: string;
    action?: 'goto' | 'back' | 'forward' | 'reload';
    waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit';
    timeout?: number;
    tabIndex?: number;
  }) {
    return this.runWithAutoScreenshot('navigate', async () => {
      const page = await this.runtime.getActivePage(params.tabIndex);
      await page.bringToFront();
      const timeout = params.timeout ?? 30000;
      const waitUntil = params.waitUntil ?? 'domcontentloaded';
      const action = params.action ?? 'goto';

      if (action === 'goto') {
        if (!params.url) throw new Error('url is required for navigate action "goto"');
        await page.goto(params.url, { waitUntil, timeout });
      } else if (action === 'back') {
        await page.goBack({ waitUntil, timeout });
      } else if (action === 'forward') {
        await page.goForward({ waitUntil, timeout });
      } else if (action === 'reload') {
        await page.reload({ waitUntil, timeout });
      }

      return {
        action,
        title: await page.title().catch(() => ''),
        url: sanitizeUrl(page.url()),
      };
    });
  }

  public async click(params: {
    selector?: string;
    x?: number;
    y?: number;
    button?: 'left' | 'right' | 'middle';
    clickCount?: number;
    frame?: string;
    timeout?: number;
    tabIndex?: number;
    confirmed?: boolean;
  }) {
    return this.runWithAutoScreenshot('click', async () => {
      const page = await this.runtime.getActivePage(params.tabIndex);
      await page.bringToFront();
      const timeout = params.timeout ?? 15000;
      const button = params.button ?? 'left';
      const clickCount = params.clickCount ?? 1;

      if (params.selector) {
        const scope = this.getScope(page, params.frame);
        const locator = scope.locator(params.selector).first();
        await locator.waitFor({ state: 'visible', timeout });

        if (!params.confirmed) {
          const innerText = (await locator.innerText({ timeout: 2000 }).catch(() => '')) || '';
          const ariaLabel = (await locator.getAttribute('aria-label').catch(() => '')) || '';
          const valueAttr = (await locator.getAttribute('value').catch(() => '')) || '';
          const inspectTarget = `${params.selector} ${innerText} ${ariaLabel} ${valueAttr}`;
          const matched = detectHighRisk(inspectTarget);
          if (matched) {
            const shot = await this.screenshots.captureOnError(page, 'high_risk_click');
            throw new HighRiskActionError(matched, sanitizeText(inspectTarget).slice(0, 120), shot);
          }
        }

        await locator.click({ button, clickCount, timeout });
        return {
          clicked: params.selector,
          title: await page.title().catch(() => ''),
          url: sanitizeUrl(page.url()),
        };
      }

      if (typeof params.x === 'number' && typeof params.y === 'number') {
        await page.mouse.click(params.x, params.y, { button, clickCount });
        return {
          clicked: { x: params.x, y: params.y },
          title: await page.title().catch(() => ''),
          url: sanitizeUrl(page.url()),
        };
      }

      throw new Error('Either "selector" or numeric "x" and "y" coordinates must be provided.');
    });
  }

  public async type(params: {
    selector: string;
    text: string;
    clear?: boolean;
    pressEnter?: boolean;
    delay?: number;
    frame?: string;
    timeout?: number;
    tabIndex?: number;
    sensitive?: boolean;
  }) {
    return this.runWithAutoScreenshot('type', async () => {
      const page = await this.runtime.getActivePage(params.tabIndex);
      await page.bringToFront();
      const timeout = params.timeout ?? 15000;
      const scope = this.getScope(page, params.frame);
      const locator = scope.locator(params.selector).first();
      await locator.waitFor({ state: 'visible', timeout });

      if (params.clear !== false) {
        await locator.fill('', { timeout });
      }
      if (params.delay && params.delay > 0) {
        await locator.pressSequentially(params.text, { delay: params.delay, timeout });
      } else if (params.clear !== false) {
        await locator.fill(params.text, { timeout });
      } else {
        await locator.type(params.text, { timeout });
      }

      if (params.pressEnter) {
        await locator.press('Enter', { timeout });
      }

      return {
        selector: params.selector,
        length: params.text.length,
        cleared: params.clear !== false,
        pressedEnter: Boolean(params.pressEnter),
        url: sanitizeUrl(page.url()),
      };
    });
  }

  public async keyboard(params: {
    action: 'press' | 'type' | 'down' | 'up';
    key?: string;
    text?: string;
    delay?: number;
    tabIndex?: number;
  }) {
    return this.runWithAutoScreenshot('keyboard', async () => {
      const page = await this.runtime.getActivePage(params.tabIndex);
      await page.bringToFront();

      if (params.action === 'press') {
        if (!params.key) throw new Error('key is required for keyboard press');
        await page.keyboard.press(params.key, { delay: params.delay });
      } else if (params.action === 'down') {
        if (!params.key) throw new Error('key is required for keyboard down');
        await page.keyboard.down(params.key);
      } else if (params.action === 'up') {
        if (!params.key) throw new Error('key is required for keyboard up');
        await page.keyboard.up(params.key);
      } else if (params.action === 'type') {
        if (typeof params.text !== 'string') throw new Error('text is required for keyboard type');
        await page.keyboard.type(params.text, { delay: params.delay });
      }

      return { action: params.action, key: params.key };
    });
  }

  public async mouse(params: {
    action: 'move' | 'click' | 'dblclick' | 'down' | 'up' | 'wheel';
    x?: number;
    y?: number;
    deltaX?: number;
    deltaY?: number;
    button?: 'left' | 'right' | 'middle';
    tabIndex?: number;
  }) {
    return this.runWithAutoScreenshot('mouse', async () => {
      const page = await this.runtime.getActivePage(params.tabIndex);
      await page.bringToFront();

      if (params.action === 'move') {
        await page.mouse.move(params.x ?? 0, params.y ?? 0);
      } else if (params.action === 'click') {
        await page.mouse.click(params.x ?? 0, params.y ?? 0, { button: params.button ?? 'left' });
      } else if (params.action === 'dblclick') {
        await page.mouse.dblclick(params.x ?? 0, params.y ?? 0, { button: params.button ?? 'left' });
      } else if (params.action === 'down') {
        await page.mouse.down({ button: params.button ?? 'left' });
      } else if (params.action === 'up') {
        await page.mouse.up({ button: params.button ?? 'left' });
      } else if (params.action === 'wheel') {
        await page.mouse.wheel(params.deltaX ?? 0, params.deltaY ?? 0);
      }

      return { action: params.action };
    });
  }

  public async scroll(params: {
    deltaX?: number;
    deltaY?: number;
    selector?: string;
    position?: 'top' | 'bottom';
    frame?: string;
    tabIndex?: number;
  }) {
    return this.runWithAutoScreenshot('scroll', async () => {
      const page = await this.runtime.getActivePage(params.tabIndex);
      await page.bringToFront();

      if (params.selector) {
        const scope = this.getScope(page, params.frame);
        await scope.locator(params.selector).first().scrollIntoViewIfNeeded({ timeout: 10000 });
      } else if (params.position === 'top') {
        await page.evaluate(() => window.scrollTo(0, 0));
      } else if (params.position === 'bottom') {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      } else {
        await page.mouse.wheel(params.deltaX ?? 0, params.deltaY ?? 600);
      }

      const scrollPos = await page.evaluate(() => ({
        x: window.scrollX,
        y: window.scrollY,
        scrollHeight: document.documentElement.scrollHeight,
      }));
      return scrollPos;
    });
  }

  public async screenshot(params: ScreenshotOptions & { tabIndex?: number }) {
    return this.runWithAutoScreenshot('screenshot', async () => {
      const page = await this.runtime.getActivePage(params.tabIndex);
      await page.bringToFront();
      return this.screenshots.capture(page, params);
    });
  }

  public async getPageInfo(params: {
    includeHtml?: boolean;
    includeText?: boolean;
    includeAccessibility?: boolean;
    maxLength?: number;
    frame?: string;
    tabIndex?: number;
  }) {
    return this.runWithAutoScreenshot('getPageInfo', async () => {
      const page = await this.runtime.getActivePage(params.tabIndex);
      const maxLength = Math.min(200000, Math.max(1000, params.maxLength ?? 50000));
      const scope = this.getScope(page, params.frame);

      const result: Record<string, unknown> = {
        title: await page.title().catch(() => ''),
        url: sanitizeUrl(page.url()),
      };

      if (params.includeText !== false) {
        const text = await scope.locator('body').innerText({ timeout: 5000 }).catch(() => '');
        result.text = text.slice(0, maxLength);
      }

      if (params.includeHtml) {
        const html = params.frame
          ? await scope.locator(':root').evaluate((el) => el.outerHTML)
          : await page.content();
        result.html = html.slice(0, maxLength);
      }

      if (params.includeAccessibility) {
        const aria = await scope.locator('body').ariaSnapshot({ timeout: 5000 }).catch(() => '');
        result.accessibility = aria.slice(0, maxLength);
      }

      return result;
    });
  }

  public async evaluate(params: {
    expression: string;
    frame?: string;
    tabIndex?: number;
    confirmed?: boolean;
  }) {
    return this.runWithAutoScreenshot('evaluate', async () => {
      const page = await this.runtime.getActivePage(params.tabIndex);

      if (!params.confirmed) {
        const matched = detectHighRisk(params.expression);
        if (matched) {
          const shot = await this.screenshots.captureOnError(page, 'high_risk_eval');
          throw new HighRiskActionError(matched, 'JavaScript evaluate expression', shot);
        }
      }

      const fn = new Function('expr', 'return eval(expr)');
      let value: unknown;
      if (params.frame) {
        const frameHandle = await page.locator(params.frame).first().elementHandle({ timeout: 10000 });
        const contentFrame = await frameHandle?.contentFrame();
        if (!contentFrame) throw new Error(`Iframe not found: ${params.frame}`);
        value = await contentFrame.evaluate(fn as (arg: string) => unknown, params.expression);
      } else {
        value = await page.evaluate(fn as (arg: string) => unknown, params.expression);
      }

      return { value };
    });
  }

  public async wait(params: {
    selector?: string;
    state?: 'attached' | 'detached' | 'visible' | 'hidden';
    loadState?: 'load' | 'domcontentloaded' | 'networkidle';
    ms?: number;
    frame?: string;
    timeout?: number;
    tabIndex?: number;
  }) {
    return this.runWithAutoScreenshot('wait', async () => {
      const page = await this.runtime.getActivePage(params.tabIndex);
      const timeout = params.timeout ?? 30000;

      if (params.selector) {
        const scope = this.getScope(page, params.frame);
        await scope.locator(params.selector).first().waitFor({
          state: params.state ?? 'visible',
          timeout,
        });
        return { waitedFor: params.selector, state: params.state ?? 'visible' };
      }

      if (params.loadState) {
        await page.waitForLoadState(params.loadState, { timeout });
        return { waitedFor: params.loadState };
      }

      const delay = Math.min(30000, Math.max(0, params.ms ?? 1000));
      await page.waitForTimeout(delay);
      return { waitedMs: delay };
    });
  }

  public async upload(params: {
    selector: string;
    files: string[];
    frame?: string;
    timeout?: number;
    tabIndex?: number;
  }) {
    return this.runWithAutoScreenshot('upload', async () => {
      const page = await this.runtime.getActivePage(params.tabIndex);
      const scope = this.getScope(page, params.frame);
      const safeFiles = params.files.map((f) => resolveSafePath(this.downloadsDir, path.basename(f)));
      await scope.locator(params.selector).first().setInputFiles(safeFiles, {
        timeout: params.timeout ?? 15000,
      });
      return { selector: params.selector, uploadedCount: safeFiles.length };
    });
  }

  public async listDownloads() {
    await fs.mkdir(this.downloadsDir, { recursive: true });
    const entries = await fs.readdir(this.downloadsDir, { withFileTypes: true });
    const files = await Promise.all(
      entries
        .filter((e) => e.isFile())
        .map(async (e) => {
          const fullPath = path.join(this.downloadsDir, e.name);
          const stat = await fs.stat(fullPath);
          return {
            filename: e.name,
            bytes: stat.size,
            modifiedAt: stat.mtime.toISOString(),
          };
        })
    );
    return {
      downloadsDir: '/opt/browser-sandbox/data/downloads',
      files,
      recentEvents: this.runtime.getRecordedDownloads(),
    };
  }

  public getLogs(limit?: number) {
    return this.runtime.getLogs(limit);
  }

  public configureDialog(policy: DialogPolicy) {
    return this.runtime.setDialogPolicy(policy);
  }

  public async executeAction(payload: { type: string; [key: string]: unknown }): Promise<unknown> {
    const { type, ...rest } = payload;
    switch (type) {
      case 'navigate':
        return this.navigate(rest as Parameters<BrowserController['navigate']>[0]);
      case 'click':
        return this.click(rest as Parameters<BrowserController['click']>[0]);
      case 'type':
        return this.type(rest as Parameters<BrowserController['type']>[0]);
      case 'keyboard':
        return this.keyboard(rest as Parameters<BrowserController['keyboard']>[0]);
      case 'mouse':
        return this.mouse(rest as Parameters<BrowserController['mouse']>[0]);
      case 'scroll':
        return this.scroll(rest as Parameters<BrowserController['scroll']>[0]);
      case 'screenshot':
        return this.screenshot(rest as Parameters<BrowserController['screenshot']>[0]);
      case 'page':
        return this.getPageInfo(rest as Parameters<BrowserController['getPageInfo']>[0]);
      case 'evaluate':
        return this.evaluate(rest as Parameters<BrowserController['evaluate']>[0]);
      case 'wait':
        return this.wait(rest as Parameters<BrowserController['wait']>[0]);
      case 'upload':
        return this.upload(rest as Parameters<BrowserController['upload']>[0]);
      case 'createTab':
        return this.createTab(rest.url as string | undefined);
      case 'switchTab':
        return this.switchTab(Number(rest.index));
      case 'closeTab':
        return this.closeTab(Number(rest.index));
      case 'tabs':
        return this.listTabs();
      case 'status':
        return this.status();
      default:
        throw new Error(`Unsupported action type: ${type}`);
    }
  }
}
