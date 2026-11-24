import fs from 'fs/promises';
import path from 'path';
import type { Page } from 'playwright-core';
import { resolveSafePath } from './security.js';

export interface ScreenshotOptions {
  fullPage?: boolean;
  selector?: string;
  format?: 'png' | 'jpeg';
  quality?: number;
  name?: string;
  returnBase64?: boolean;
}

export interface ScreenshotResult {
  filename: string;
  path: string;
  format: 'png' | 'jpeg';
  bytes: number;
  base64?: string;
}

export class ScreenshotService {
  private readonly screenshotsDir: string;

  constructor(screenshotsDir: string) {
    this.screenshotsDir = path.resolve(screenshotsDir);
  }

  private sanitizeFilename(name: string, ext: string): string {
    const clean = name.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '');
    const withExt = clean.endsWith(`.${ext}`) ? clean : `${clean}.${ext}`;
    return withExt.slice(0, 120);
  }

  public async capture(page: Page, options: ScreenshotOptions = {}): Promise<ScreenshotResult> {
    await fs.mkdir(this.screenshotsDir, { recursive: true });
    const format: 'png' | 'jpeg' = options.format === 'jpeg' ? 'jpeg' : 'png';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const rawName = options.name ? this.sanitizeFilename(options.name, format) : `shot-${stamp}.${format}`;
    const targetPath = resolveSafePath(this.screenshotsDir, rawName);

    const shotOptions: {
      path: string;
      type: 'png' | 'jpeg';
      fullPage?: boolean;
      quality?: number;
      timeout: number;
    } = {
      path: targetPath,
      type: format,
      timeout: 15000,
    };

    if (format === 'jpeg') {
      shotOptions.quality = Math.min(100, Math.max(10, options.quality ?? 80));
    }

    let buffer: Buffer;
    if (options.selector) {
      buffer = await page.locator(options.selector).first().screenshot(shotOptions);
    } else {
      shotOptions.fullPage = Boolean(options.fullPage);
      buffer = await page.screenshot(shotOptions);
    }

    const result: ScreenshotResult = {
      filename: path.basename(targetPath),
      path: targetPath,
      format,
      bytes: buffer.length,
    };

    if (options.returnBase64) {
      result.base64 = buffer.toString('base64');
    }

    return result;
  }

  public async captureOnError(page: Page | null, actionName: string): Promise<string | undefined> {
    if (!page || page.isClosed()) {
      return undefined;
    }
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const safeAction = actionName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
      const res = await this.capture(page, {
        name: `error-${safeAction}-${stamp}.png`,
        format: 'png',
        fullPage: false,
      });
      return res.path;
    } catch {
      return undefined;
    }
  }
}
