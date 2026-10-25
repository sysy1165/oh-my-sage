/**
 * Core - 小米账号扫码登录
 *
 * 流程（与 mijiaAPI / xiaomi-auth-sdk 一致）：
 *   1) serviceLogin 拿到二维码登录 location；
 *   2) longPolling/loginUrl 拿到二维码图片 URL、长轮询地址和有效期；
 *   3) 长轮询等待米家 App 扫码，结果里直接带 passToken / userId / cUserId；
 *   4) 保存为长期登录态，后续用 passToken 自动换取 serviceToken 并取码。
 *
 * 平台只提供二维码图片 URL 和会话 ID；lp 地址与设备 Cookie 只留在服务端。
 */

import { randomBytes, randomUUID } from 'node:crypto';
import {
  XiaomiCloudError,
  cookieValue,
  makeContext,
  mergeSetCookies,
  parseMiJson,
  requestText,
  sliceText,
  type CloudRequestOptions,
  type CloudContext,
} from './miHttp';
import { parseCookieHeader } from './credentials';
import type { StoredXiaomiCredentials } from './credentialStore';

// ==================== 常量 ====================

const LOGIN_HOST = 'https://account.xiaomi.com';
const SERVICE_LOGIN_URL = `${LOGIN_HOST}/pass/serviceLogin?_json=true&sid=mijia&_locale=zh_CN`;
const QR_LOGIN_PATH = '/longPolling/loginUrl';
const QR_UA = 'Mozilla/5.0 (Linux; Android 14; 23127PN0CC Build/UKQ1.230804.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.0.0 Mobile Safari/537.36';
const DEVICE_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_-';
const PASS_O_ALPHABET = '0123456789abcdef';
const FALLBACK_TIMEOUT_MS = 300_000;
const MAX_QR_TIMEOUT_MS = 600_000;
const MAX_CALLBACK_REDIRECTS = 5;

// ==================== 类型 ====================

export interface QrLoginSession {
  id: string;
  /** 小米返回的二维码图片 URL（可直接作为 img src） */
  qrUrl: string;
  /** 二维码里编码的登录链接；仅服务端保留，便于排障 */
  loginUrl: string;
  /** 长轮询地址；仅服务端使用，绝不下发给浏览器 */
  lp: string;
  deviceId: string;
  /** 扫码请求使用的设备 Cookie；仅服务端使用 */
  cookie: string;
  timeoutMs: number;
  qrTips?: string;
  startedAt: number;
}

interface QrStartPayload {
  code?: number;
  result?: string;
  desc?: string;
  description?: string;
  location?: string;
  qr?: string;
  loginUrl?: string;
  lp?: string;
  timeout?: number | string;
  qrTips?: string;
}

interface QrResultPayload {
  code?: number;
  result?: string;
  desc?: string;
  description?: string;
  passToken?: string;
  userId?: string | number;
  cUserId?: string;
  ssecurity?: string;
  location?: string;
  expireTime?: number;
}

// ==================== 工具 ====================

function randomString(alphabet: string, length: number): string {
  const bytes = randomBytes(length);
  let result = '';
  for (let i = 0; i < length; i++) result += alphabet[bytes[i] % alphabet.length];
  return result;
}

function textOf(data: { desc?: string; description?: string; result?: string; code?: number }): string {
  return data.desc || data.description || data.result || (data.code === undefined ? 'unknown' : String(data.code));
}

function normalizeExpireTime(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return value < 1e12 ? value * 1000 : value;
}

// ==================== 开始扫码 ====================

/**
 * 获取一张新的登录二维码。
 * 不要求已有登录态；用户用米家 App 扫码即可。
 */
export async function startQrLogin(options: CloudRequestOptions = {}): Promise<QrLoginSession> {
  const ctx = makeContext(options);
  const deviceId = randomString(DEVICE_ALPHABET, 16);
  const passO = randomString(PASS_O_ALPHABET, 16);
  const cookie = `deviceId=${deviceId}; pass_o=${passO}; sdkVersion=3.4.1`;
  const headers = {
    'User-Agent': QR_UA,
    Accept: '*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    Cookie: cookie,
  };

  const service = await requestText(ctx, SERVICE_LOGIN_URL, { method: 'GET', headers });
  if (service.status >= 500) {
    throw new XiaomiCloudError(
      'network',
      `小米登录服务暂时不可用（HTTP ${service.status}）`,
      sliceText(service.text)
    );
  }
  if (service.status === 401 || service.status === 403) {
    throw new XiaomiCloudError(
      'auth-expired',
      `小米登录服务拒绝请求（HTTP ${service.status}），请稍后重试`,
      sliceText(service.text)
    );
  }

  let serviceData: QrStartPayload;
  try {
    serviceData = parseMiJson<QrStartPayload>(service.text);
  } catch {
    throw new XiaomiCloudError(
      'api',
      `小米登录服务返回非 JSON（HTTP ${service.status}）`,
      sliceText(service.text)
    );
  }

  // 未登录时 serviceLogin 通常返回 code=70016 / result=error，但 location 仍然有效
  const location = typeof serviceData.location === 'string' ? serviceData.location : '';
  if (!location) {
    throw new XiaomiCloudError(
      'api',
      `小米登录服务未返回二维码登录地址（${textOf(serviceData)}）`,
      sliceText(service.text)
    );
  }

  let locationUrl: URL;
  try {
    locationUrl = new URL(location);
  } catch {
    throw new XiaomiCloudError('api', '二维码登录地址格式异常', sliceText(location));
  }

  const params = new URLSearchParams(locationUrl.search);
  params.set('theme', '');
  params.set('bizDeviceType', '');
  params.set('_hasLogo', 'false');
  params.set('_qrsize', '240');
  params.set('_dc', String(Date.now()));

  const qrResponse = await requestText(ctx, `${LOGIN_HOST}${QR_LOGIN_PATH}?${params.toString()}`, {
    method: 'GET',
    headers,
  });
  if (qrResponse.status >= 500) {
    throw new XiaomiCloudError(
      'network',
      `小米二维码服务暂时不可用（HTTP ${qrResponse.status}）`,
      sliceText(qrResponse.text)
    );
  }

  let qrData: QrStartPayload;
  try {
    qrData = parseMiJson<QrStartPayload>(qrResponse.text);
  } catch {
    throw new XiaomiCloudError(
      'api',
      `二维码接口返回非 JSON（HTTP ${qrResponse.status}）`,
      sliceText(qrResponse.text)
    );
  }

  if (qrData.code !== 0 || typeof qrData.qr !== 'string' || typeof qrData.lp !== 'string') {
    throw new XiaomiCloudError(
      'api',
      `获取二维码失败：${textOf(qrData)}`,
      sliceText(qrResponse.text)
    );
  }

  const timeoutSeconds = Number(qrData.timeout);
  const timeoutMs = Number.isFinite(timeoutSeconds) && timeoutSeconds > 0
    ? Math.min(timeoutSeconds * 1000, MAX_QR_TIMEOUT_MS)
    : FALLBACK_TIMEOUT_MS;

  return {
    id: randomUUID(),
    qrUrl: qrData.qr,
    loginUrl: typeof qrData.loginUrl === 'string' ? qrData.loginUrl : '',
    lp: qrData.lp,
    deviceId,
    cookie,
    timeoutMs,
    ...(typeof qrData.qrTips === 'string' && qrData.qrTips ? { qrTips: qrData.qrTips } : {}),
    startedAt: Date.now(),
  };
}

// ==================== 等待扫码 ====================

/**
 * 长轮询等待扫码完成，返回可持久化的长期凭据。
 * 二维码过期/超时统一抛 qr-expired，便于前端提示刷新。
 */
export async function completeQrLogin(
  session: QrLoginSession,
  options: CloudRequestOptions = {}
): Promise<StoredXiaomiCredentials> {
  const ctx = makeContext({
    ...options,
    timeoutMs: Math.max(15_000, session.timeoutMs + 15_000),
  });
  const headers = {
    'User-Agent': QR_UA,
    Connection: 'keep-alive',
    'Accept-Encoding': 'gzip',
    Cookie: session.cookie,
  };

  try {
    const response = await requestText(ctx, session.lp, { method: 'GET', headers });
    if (response.status === 401 || response.status === 403) {
      throw new XiaomiCloudError('qr-expired', '二维码已过期，请刷新后重试');
    }

    let data: QrResultPayload;
    try {
      data = parseMiJson<QrResultPayload>(response.text);
    } catch {
      throw new XiaomiCloudError(
        'api',
        `扫码登录返回非 JSON（HTTP ${response.status}）`,
        sliceText(response.text)
      );
    }

    if (data.code !== 0) {
      throw new XiaomiCloudError(
        'qr-expired',
        `扫码登录未完成：${textOf(data)}`,
        sliceText(response.text)
      );
    }

    let passToken = typeof data.passToken === 'string' ? data.passToken.trim() : '';
    let userId = data.userId === undefined || data.userId === null ? '' : String(data.userId);
    let cUserId = typeof data.cUserId === 'string' ? data.cUserId.trim() : '';

    passToken = passToken || cookieValue(response.headers, 'passToken');
    userId = userId || cookieValue(response.headers, 'userId');
    cUserId = cUserId || cookieValue(response.headers, 'cUserId');

    // 登录成功后 callback 可能更新/下发长期 Cookie；尽力跟随一次，
    // 失败时仍保留长轮询 JSON 里已有的凭据。
    if (typeof data.location === 'string' && data.location) {
      let callbackCookie = session.cookie;
      if (passToken) callbackCookie += `; passToken=${passToken}`;
      if (userId) callbackCookie += `; userId=${userId}`;
      try {
        const jar = await followLoginCallback(
          makeContext(options),
          data.location,
          headers,
          callbackCookie
        );
        passToken = jar.passToken || passToken;
        userId = jar.userId || userId;
        cUserId = jar.cUserId || cUserId;
      } catch {
        // callback 失败不影响已经拿到的登录态
      }
    }

    if (!passToken || !userId) {
      throw new XiaomiCloudError(
        'api',
        '扫码成功但小米未返回 passToken/userId，请刷新二维码重试',
        sliceText(response.text)
      );
    }

    const expireTime = normalizeExpireTime(data.expireTime);
    return {
      userId,
      passToken,
      ...(cUserId ? { cUserId } : {}),
      deviceId: session.deviceId,
      source: 'qr',
      savedAt: Date.now(),
      ...(expireTime ? { expireTime } : {}),
    };
  } catch (error) {
    if (error instanceof XiaomiCloudError) {
      if (error.code === 'network' && /超时/.test(error.message)) {
        throw new XiaomiCloudError('qr-expired', '二维码已过期，请刷新后重试');
      }
      throw error;
    }
    throw new XiaomiCloudError(
      'api',
      `扫码登录失败：${error instanceof Error ? error.message : String(error)}`
    );
  }
}

interface LoginCallbackCookies {
  passToken?: string;
  userId?: string;
  cUserId?: string;
}

/** 跟随登录成功后的 callback，收集 Set-Cookie 里的长期凭据 */
async function followLoginCallback(
  ctx: CloudContext,
  location: string,
  headers: Record<string, string>,
  initialCookie: string
): Promise<LoginCallbackCookies> {
  let url = location;
  let cookie = initialCookie;

  for (let hop = 0; hop < MAX_CALLBACK_REDIRECTS; hop++) {
    const response = await requestText(ctx, url, {
      method: 'GET',
      headers: { ...headers, Cookie: cookie },
      redirect: 'manual',
    });
    cookie = mergeSetCookies(cookie, response.headers);
    if (response.status < 300 || response.status >= 400) break;
    const next = response.headers.get('location');
    if (!next) break;
    url = new URL(next, url).toString();
  }

  const jar = parseCookieHeader(cookie);
  return {
    ...(jar.passToken ? { passToken: jar.passToken } : {}),
    ...(jar.userId ? { userId: jar.userId } : {}),
    ...(jar.cUserId ? { cUserId: jar.cUserId } : {}),
  };
}
