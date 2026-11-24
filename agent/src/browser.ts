import dns from 'dns/promises';
import net from 'net';
import path from 'path';
import fs from 'fs/promises';
import { chromium, type Browser, type BrowserContext, type Dialog, type Page } from 'playwright-core';
import { sanitizeText, sanitizeUrl } from './security.js';

export interface ConsoleLogEntry {
  timestamp: string;
  type: string;
  text: string;
  url: string;
}

export interface PageErrorEntry {
  timestamp: string;
  message: string;
  url: string;
}

export interface NetworkEventEntry {
  timestamp: string;
  method: string;
  url: string;
  status?: number;
  failure?: string;
  resourceType: string;
}

export interface DownloadEntry {
  timestamp: string;
  filename: string;
  path: string;
  url: string;
}

export interface DialogEntry {
  timestamp: string;
  type: string;
  message: string;
  action: 'accepted' | 'dismissed';
}

export interface DialogPolicy {
  mode: 'manual' | 'accept' | 'dismiss';
  promptText?: string;
}

const MAX_LOG_ITEMS = 200;

export class BrowserRuntimeManager {
  private readonly cdpUrl: string;
  private readonly downloadsDir: string;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private activePage: Page | null = null;
  private connectingPromise: Promise<Browser> | null = null;
  private trackedPages = new WeakSet<Page>();
  private dialogListeners = new WeakMap<Page, (dialog: Dialog) => void>();

  private consoleLogs: ConsoleLogEntry[] = [];
  private pageErrors: PageErrorEntry[] = [];
  private networkEvents: NetworkEventEntry[] = [];
  private downloads: DownloadEntry[] = [];
  private dialogs: DialogEntry[] = [];
  private dialogPolicy: DialogPolicy = { mode: 'manual' };
  private connectedAt: string | null = null;
  private browserVersion: string | null = null;

  constructor(options: { cdpUrl: string; downloadsDir: string }) {
    this.cdpUrl = options.cdpUrl;
    this.downloadsDir = path.resolve(options.downloadsDir);
  }

  private pushBounded<T>(arr: T[], item: T): void {
    arr.push(item);
    if (arr.length > MAX_LOG_ITEMS) {
      arr.splice(0, arr.length - MAX_LOG_ITEMS);
    }
  }

  public isConnected(): boolean {
    return Boolean(this.browser && this.browser.isConnected());
  }

  private async resolveCdpEndpoint(): Promise<string> {
    try {
      const parsed = new URL(this.cdpUrl);
      if (parsed.hostname !== 'localhost' && net.isIP(parsed.hostname) === 0) {
        const { address } = await dns.lookup(parsed.hostname, { family: 4 });
        parsed.hostname = address;
      }
      return parsed.toString().replace(/\/$/, '');
    } catch {
      return this.cdpUrl;
    }
  }

  public async connect(): Promise<Browser> {
    if (this.browser && this.browser.isConnected()) {
      return this.browser;
    }
    if (this.connectingPromise) {
      return this.connectingPromise;
    }

    this.connectingPromise = (async () => {
      let lastError: unknown;
      for (let attempt = 1; attempt <= 5; attempt++) {
        try {
          const endpoint = await this.resolveCdpEndpoint();
          const browser = await chromium.connectOverCDP(endpoint, { timeout: 10000 });
          this.browser = browser;
          this.browserVersion = browser.version();
          this.connectedAt = new Date().toISOString();

          browser.on('disconnected', () => {
            this.browser = null;
            this.context = null;
            this.activePage = null;
            this.connectedAt = null;
          });

          const contexts = browser.contexts();
          if (contexts.length === 0) {
            throw new Error('Connected to Chromium over CDP, but no default persistent context was found.');
          }

          // Always bind to the live persistent default context displayed in Xvfb/noVNC
          this.context = contexts[0];
          this.context.on('page', (page) => {
            this.attachPageListeners(page);
            this.activePage = page;
          });

          for (const page of this.context.pages()) {
            this.attachPageListeners(page);
          }

          if (this.context.pages().length > 0) {
            this.activePage = this.context.pages()[0];
          } else {
            this.activePage = await this.context.newPage();
          }

          return browser;
        } catch (err) {
          lastError = err;
          await new Promise((r) => setTimeout(r, 1000 * attempt));
        }
      }
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    })();

    try {
      return await this.connectingPromise;
    } finally {
      this.connectingPromise = null;
    }
  }

  private attachPageListeners(page: Page): void {
    if (this.trackedPages.has(page)) {
      return;
    }
    this.trackedPages.add(page);

    page.on('console', (msg) => {
      this.pushBounded(this.consoleLogs, {
        timestamp: new Date().toISOString(),
        type: msg.type(),
        text: sanitizeText(msg.text()).slice(0, 1000),
        url: sanitizeUrl(page.url()),
      });
    });

    page.on('pageerror', (err) => {
      this.pushBounded(this.pageErrors, {
        timestamp: new Date().toISOString(),
        message: sanitizeText(err.message || String(err)).slice(0, 1000),
        url: sanitizeUrl(page.url()),
      });
    });

    page.on('requestfailed', (req) => {
      this.pushBounded(this.networkEvents, {
        timestamp: new Date().toISOString(),
        method: req.method(),
        url: sanitizeUrl(req.url()),
        failure: req.failure()?.errorText || 'failed',
        resourceType: req.resourceType(),
      });
    });

    page.on('response', (res) => {
      if (res.status() >= 400) {
        this.pushBounded(this.networkEvents, {
          timestamp: new Date().toISOString(),
          method: res.request().method(),
          url: sanitizeUrl(res.url()),
          status: res.status(),
          resourceType: res.request().resourceType(),
        });
      }
    });

    page.on('download', async (download) => {
      try {
        await fs.mkdir(this.downloadsDir, { recursive: true });
        const suggested = path.basename(download.suggestedFilename() || `download-${Date.now()}`);
        const savePath = path.join(this.downloadsDir, suggested);
        await download.saveAs(savePath);
        this.pushBounded(this.downloads, {
          timestamp: new Date().toISOString(),
          filename: suggested,
          path: savePath,
          url: sanitizeUrl(download.url()),
        });
      } catch (err) {
        this.pushBounded(this.pageErrors, {
          timestamp: new Date().toISOString(),
          message: `Download save failed: ${sanitizeText(String(err))}`,
          url: sanitizeUrl(page.url()),
        });
      }
    });

    page.on('close', () => {
      if (this.activePage === page) {
        const remaining = this.getOpenPages().filter((p) => p !== page);
        this.activePage = remaining[0] ?? null;
      }
    });

    this.applyDialogListener(page);
  }

  private applyDialogListener(page: Page): void {
    const existing = this.dialogListeners.get(page);
    if (existing) {
      page.off('dialog', existing);
      this.dialogListeners.delete(page);
    }

    if (this.dialogPolicy.mode === 'manual') {
      // Do not attach a Playwright dialog handler in manual mode so humans can interact via noVNC
      return;
    }

    const handler = async (dialog: Dialog) => {
      const action = this.dialogPolicy.mode === 'accept' ? 'accepted' : 'dismissed';
      try {
        if (this.dialogPolicy.mode === 'accept') {
          await dialog.accept(this.dialogPolicy.promptText);
        } else {
          await dialog.dismiss();
        }
        this.pushBounded(this.dialogs, {
          timestamp: new Date().toISOString(),
          type: dialog.type(),
          message: sanitizeText(dialog.message()).slice(0, 500),
          action,
        });
      } catch {
        // Dialog may already be handled by human in noVNC
      }
    };

    this.dialogListeners.set(page, handler);
    page.on('dialog', handler);
  }

  public setDialogPolicy(policy: DialogPolicy): DialogPolicy {
    this.dialogPolicy = { ...policy };
    for (const page of this.getOpenPages()) {
      this.applyDialogListener(page);
    }
    return this.dialogPolicy;
  }

  public getDialogPolicy(): DialogPolicy {
    return { ...this.dialogPolicy };
  }

  public async ensureContext(): Promise<BrowserContext> {
    await this.connect();
    if (!this.context) {
      throw new Error('Browser persistent context is unavailable.');
    }
    return this.context;
  }

  public getOpenPages(): Page[] {
    if (!this.context) return [];
    return this.context.pages().filter((p) => !p.isClosed());
  }

  public async getActivePage(tabIndex?: number): Promise<Page> {
    const context = await this.ensureContext();
    let pages = this.getOpenPages();
    if (pages.length === 0) {
      const created = await context.newPage();
      this.attachPageListeners(created);
      this.activePage = created;
      return created;
    }

    if (typeof tabIndex === 'number') {
      if (tabIndex < 0 || tabIndex >= pages.length) {
        throw new Error(`Invalid tabIndex ${tabIndex}. Open tabs: 0..${pages.length - 1}`);
      }
      this.activePage = pages[tabIndex];
      await this.activePage.bringToFront();
      return this.activePage;
    }

    if (!this.activePage || this.activePage.isClosed() || !pages.includes(this.activePage)) {
      this.activePage = pages[0];
    }
    return this.activePage;
  }

  public setActivePage(page: Page): void {
    this.activePage = page;
  }

  public getCurrentPageUnsafe(): Page | null {
    return this.activePage && !this.activePage.isClosed() ? this.activePage : null;
  }

  public getDiagnostics() {
    return {
      connected: this.isConnected(),
      connectedAt: this.connectedAt,
      browserVersion: this.browserVersion,
      cdpEndpoint: this.cdpUrl,
      openTabsCount: this.getOpenPages().length,
      consoleLogsCount: this.consoleLogs.length,
      pageErrorsCount: this.pageErrors.length,
      networkErrorsCount: this.networkEvents.length,
      downloadsCount: this.downloads.length,
      dialogPolicy: this.dialogPolicy,
    };
  }

  public getLogs(limit = 50) {
    const n = Math.max(1, Math.min(200, limit));
    return {
      console: this.consoleLogs.slice(-n),
      pageErrors: this.pageErrors.slice(-n),
      networkErrors: this.networkEvents.slice(-n),
      dialogs: this.dialogs.slice(-n),
    };
  }

  public getRecordedDownloads(): DownloadEntry[] {
    return [...this.downloads];
  }

  public async close(): Promise<void> {
    if (this.browser) {
      // Only disconnect Playwright CDP client — do NOT terminate the live Chromium browser!
      await this.browser.close().catch(() => undefined);
      this.browser = null;
      this.context = null;
      this.activePage = null;
    }
  }
}
