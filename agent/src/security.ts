import crypto from 'crypto';
import path from 'path';
import type { Request, Response, NextFunction } from 'express';

const SENSITIVE_QUERY_KEYS = new Set([
  'token',
  'access_token',
  'refresh_token',
  'auth',
  'authorization',
  'key',
  'api_key',
  'apikey',
  'secret',
  'password',
  'passwd',
  'pwd',
  'session',
  'sessionid',
  'cookie',
  'sid',
  'sig',
  'signature',
]);

const HIGH_RISK_PATTERNS: RegExp[] = [
  /转账|汇款|付款|支付|确认支付|立即支付|提交订单|确认下单|确认购买|结账/i,
  /永久删除|彻底删除|确认删除|注销账号|删除账户|清空数据/i,
  /立即发布|确认发布|群发消息|发送全部/i,
  /\b(transfer|wire\s*transfer|pay\s*now|confirm\s*payment|place\s*order|submit\s*order|checkout|purchase\s*now)\b/i,
  /\b(delete\s*account|permanently\s*delete|confirm\s*delete|drop\s*table|destroy)\b/i,
  /\b(publish\s*now|confirm\s*publish)\b/i,
];

export class HighRiskActionError extends Error {
  public readonly statusCode = 409;
  public readonly code = 'CONFIRMATION_REQUIRED';
  public readonly matchedRule: string;
  public readonly targetSummary: string;
  public screenshotPath?: string;

  constructor(matchedRule: string, targetSummary: string, screenshotPath?: string) {
    super(
      `High-risk action blocked pending human confirmation (${matchedRule}). Re-submit with "confirmed": true after review.`
    );
    this.name = 'HighRiskActionError';
    this.matchedRule = matchedRule;
    this.targetSummary = targetSummary;
    this.screenshotPath = screenshotPath;
  }
}

export function sanitizeUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) {
        parsed.searchParams.set(key, '[REDACTED]');
      }
    }
    if (parsed.password) {
      parsed.password = '[REDACTED]';
    }
    return parsed.toString();
  } catch {
    return sanitizeText(rawUrl);
  }
}

export function sanitizeText(input: string): string {
  if (!input) return '';
  return input
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
    .replace(/(Cookie\s*[:=]\s*)[^\r\n;]+/gi, '$1[REDACTED]')
    .replace(/(Set-Cookie\s*[:=]\s*)[^\r\n;]+/gi, '$1[REDACTED]')
    .replace(/(Authorization\s*[:=]\s*)[^\r\n]+/gi, '$1[REDACTED]')
    .replace(/("?(?:password|passwd|token|secret|api_?key|cookie)"?\s*[:=]\s*"?)[^",\s}]+/gi, '$1[REDACTED]');
}

export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

export function createAuthMiddleware(apiToken: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!apiToken) {
      res.status(500).json({ ok: false, error: 'Server misconfigured: API token missing' });
      return;
    }

    const authHeader = req.header('authorization') || '';
    const apiKeyHeader = req.header('x-api-key') || '';

    let provided = '';
    if (authHeader.toLowerCase().startsWith('bearer ')) {
      provided = authHeader.slice(7).trim();
    } else if (apiKeyHeader) {
      provided = apiKeyHeader.trim();
    }

    if (!provided || !safeEqual(provided, apiToken)) {
      res.status(401).json({
        ok: false,
        code: 'UNAUTHORIZED',
        error: 'Valid Bearer token or X-API-Key header is required.',
      });
      return;
    }

    next();
  };
}

export function detectHighRisk(textToInspect: string): string | null {
  if (!textToInspect) return null;
  for (const pattern of HIGH_RISK_PATTERNS) {
    const match = textToInspect.match(pattern);
    if (match) {
      return match[0];
    }
  }
  return null;
}

export function resolveSafePath(baseDir: string, relativeOrName: string): string {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(resolvedBase, relativeOrName);
  if (resolvedTarget !== resolvedBase && !resolvedTarget.startsWith(resolvedBase + path.sep)) {
    throw new Error(`Path traversal rejected: ${relativeOrName}`);
  }
  return resolvedTarget;
}
