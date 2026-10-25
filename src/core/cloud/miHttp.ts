/**
 * Core - 小米云 HTTP 基础工具
 * 统一请求超时、错误分类、Cookie 提取与 &&&START&&& 响应解析。
 */

// ==================== 错误 ====================

export type XiaomiCloudErrorCode =
  | 'not-configured'
  | 'auth-expired'
  | 'network'
  | 'device-not-found'
  | 'qr-expired'
  | 'api';

export class XiaomiCloudError extends Error {
  readonly code: XiaomiCloudErrorCode;
  readonly detail?: string;

  constructor(code: XiaomiCloudErrorCode, message: string, detail?: string) {
    super(message);
    this.name = 'XiaomiCloudError';
    this.code = code;
    this.detail = detail;
  }
}

// ==================== 请求 ====================

export interface CloudRequestOptions {
  /** 注入 fetch，便于测试；默认使用全局 fetch */
  fetchImpl?: typeof fetch;
  /** 单次请求超时（毫秒），默认 15 秒 */
  timeoutMs?: number;
}

export interface CloudContext {
  fetchImpl: typeof fetch;
  timeoutMs: number;
}

const DEFAULT_TIMEOUT_MS = 15000;

export function makeContext(options: CloudRequestOptions): CloudContext {
  const timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  return { fetchImpl: options.fetchImpl || globalThis.fetch, timeoutMs };
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function sliceText(text: string, max = 300): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export interface TextResponse {
  status: number;
  text: string;
  headers: Headers;
}

export async function requestText(
  ctx: CloudContext,
  url: string,
  init: RequestInit
): Promise<TextResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ctx.timeoutMs);
  try {
    const response = await ctx.fetchImpl(url, { ...init, signal: controller.signal });
    const text = await response.text();
    return { status: response.status, text, headers: response.headers };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new XiaomiCloudError('network', `请求小米服务器超时：${hostOf(url)}`);
    }
    throw new XiaomiCloudError(
      'network',
      `请求小米服务器失败（${hostOf(url)}）：${messageOf(error)}`
    );
  } finally {
    clearTimeout(timer);
  }
}

// ==================== Cookie / 响应 ====================

export function setCookieHeaders(headers: Headers): string[] {
  const extended = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof extended.getSetCookie === 'function') return extended.getSetCookie();
  const raw = headers.get('set-cookie');
  return raw ? [raw] : [];
}

export function cookieValue(headers: Headers, name: string): string {
  const safeName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?:^|[,;]\\s*)${safeName}=([^;,\\s]+)`);
  for (const header of setCookieHeaders(headers)) {
    const match = pattern.exec(header);
    if (match) return match[1];
  }
  return '';
}

/** 把响应里的 Set-Cookie 简单并入后续请求的 Cookie 头（同名覆盖） */
export function mergeSetCookies(cookie: string, headers: Headers): string {
  let merged = cookie;
  for (const header of setCookieHeaders(headers)) {
    const pair = header.split(';', 1)[0].trim();
    const index = pair.indexOf('=');
    if (index <= 0) continue;
    const name = pair.slice(0, index);
    const parts = merged
      .split(';')
      .map((part) => part.trim())
      .filter((part) => part && !part.startsWith(`${name}=`));
    parts.push(pair);
    merged = parts.join('; ');
  }
  return merged;
}

/** 小米接口常在 JSON 前加 &&&START&&& 前缀 */
export function parseMiJson<T = unknown>(text: string): T {
  return JSON.parse(text.replace('&&&START&&&', '').trim()) as T;
}
