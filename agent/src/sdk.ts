import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';

export interface SandboxClientConfig {
  baseUrl: string;
  apiToken: string;
  timeoutMs?: number;
}

/**
 * HTTP SDK client for controlling the Browser Sandbox from any remote or local AI agent.
 */
export class BrowserSandboxClient {
  private readonly baseUrl: string;
  private readonly apiToken: string;
  private readonly timeoutMs: number;

  constructor(config: SandboxClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.apiToken = config.apiToken;
    this.timeoutMs = config.timeoutMs ?? 30000;
  }

  private async request<T>(method: string, route: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${route}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          'Content-Type': 'application/json',
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const json = (await res.json()) as { ok: boolean; data?: T; error?: string; code?: string };
      if (!res.ok || !json.ok) {
        throw new Error(`BrowserSandbox API ${res.status} (${json.code || 'ERROR'}): ${json.error || res.statusText}`);
      }
      return json.data as T;
    } finally {
      clearTimeout(timer);
    }
  }

  public health() {
    return this.request('GET', '/health');
  }

  public status() {
    return this.request('GET', '/browser/status');
  }

  public listTabs() {
    return this.request('GET', '/browser/tabs');
  }

  public createTab(url?: string) {
    return this.request('POST', '/browser/tabs', { url });
  }

  public switchTab(index: number) {
    return this.request('POST', '/browser/tabs/switch', { index });
  }

  public closeTab(index: number) {
    return this.request('DELETE', `/browser/tabs/${index}`);
  }

  public navigate(url: string, options: { waitUntil?: string; timeout?: number; tabIndex?: number } = {}) {
    return this.request('POST', '/browser/navigate', { url, action: 'goto', ...options });
  }

  public click(params: { selector?: string; x?: number; y?: number; frame?: string; confirmed?: boolean; tabIndex?: number }) {
    return this.request('POST', '/browser/click', params);
  }

  public type(selector: string, text: string, options: { clear?: boolean; pressEnter?: boolean; frame?: string; tabIndex?: number } = {}) {
    return this.request('POST', '/browser/type', { selector, text, ...options });
  }

  public scroll(params: { deltaX?: number; deltaY?: number; selector?: string; position?: 'top' | 'bottom'; tabIndex?: number }) {
    return this.request('POST', '/browser/scroll', params);
  }

  public screenshot(params: { fullPage?: boolean; selector?: string; name?: string; returnBase64?: boolean; tabIndex?: number } = {}) {
    return this.request('POST', '/browser/screenshot', params);
  }

  public getPage(options: { html?: boolean; text?: boolean; accessibility?: boolean; tabIndex?: number } = {}) {
    const qs = new URLSearchParams();
    if (options.html) qs.set('html', 'true');
    if (options.text === false) qs.set('text', 'false');
    if (options.accessibility === false) qs.set('accessibility', 'false');
    if (options.tabIndex !== undefined) qs.set('tabIndex', String(options.tabIndex));
    const query = qs.toString();
    return this.request('GET', `/browser/page${query ? `?${query}` : ''}`);
  }

  public evaluate(expression: string, options: { frame?: string; confirmed?: boolean; tabIndex?: number } = {}) {
    return this.request('POST', '/browser/evaluate', { expression, ...options });
  }

  public wait(params: { selector?: string; state?: string; loadState?: string; ms?: number; tabIndex?: number }) {
    return this.request('POST', '/browser/wait', params);
  }

  public action(payload: Record<string, unknown>) {
    return this.request('POST', '/browser/action', payload);
  }

  public logs(limit = 50) {
    return this.request('GET', `/browser/logs?limit=${limit}`);
  }
}

/**
 * Direct local Playwright SDK helper connecting to the exact same live Chromium instance over localhost CDP.
 * Note: Never call browser.close() if you want the live Chromium session to stay open; only disconnect when finished.
 */
export async function connectSandboxCDP(cdpUrl = 'http://127.0.0.1:9222'): Promise<{
  browser: Browser;
  context: BrowserContext;
  page: Page;
}> {
  const browser = await chromium.connectOverCDP(cdpUrl);
  const context = browser.contexts()[0];
  if (!context) {
    throw new Error('No persistent browser context found on CDP endpoint.');
  }
  const page = context.pages()[0] ?? (await context.newPage());
  return { browser, context, page };
}
