/**
 * Core - 小米云自动获取登录码
 *
 * 米家极客版的 6 位登录码是一次性的，正常需要从米家 App 获取。
 * 这里复用已登录小米账号的 passToken 走官方云端接口自动取码：
 *   1) serviceLogin(sid=mijia) 换取 serviceToken；
 *   2) 带签名调用 core.api.mijia.tech 的 miIO.get_central_link_passcode；
 *   3) 目标设备是签发登录码的路由器/中枢，可用 MIJIA_ROUTER_DID 指定，
 *      未指定时从云端设备列表按 localip == 网关主机名自动匹配。
 *
 * 凭据只发送到小米官方接口（account.xiaomi.com / sts.api.* / core.api.mijia.tech /
 * api.io.mi.com），不经过第三方。
 */

import { createHash, createHmac, randomBytes } from 'node:crypto';
import {
  XiaomiCloudError,
  cookieValue,
  makeContext,
  mergeSetCookies,
  parseMiJson,
  requestText,
  setCookieHeaders,
  sliceText,
  type CloudContext,
  type CloudRequestOptions,
  type XiaomiCloudErrorCode,
} from './miHttp';
import {
  readDeviceDidFromEnv,
  type EnvLike,
  type XiaomiCloudCredentials,
} from './credentials';
import { hasAutoLoginCredentials, resolveCredentials } from './credentialStore';

// 保持原有导出路径不变
export { XiaomiCloudError } from './miHttp';
export type { CloudRequestOptions, XiaomiCloudErrorCode } from './miHttp';
export { parseCookieHeader, readCredentialsFromEnv, readDeviceDidFromEnv } from './credentials';
export type { XiaomiCloudCredentials, EnvLike } from './credentials';

// ==================== 常量 ====================

const UA_APP = 'Android-7.1.1-1.0.0-ONEPLUS A3010-136-ABCDEFABCDEF0 APP/xiaomi.smarthome APPV/62830';
const ACCESS_KEY = 'IOS00026747c5acafc2';
const PASSCODE_HOST = 'https://core.api.mijia.tech';
const DEVICE_LIST_HOST = 'https://api.io.mi.com';
const DEVICE_LIST_PATH = '/app/home/device_list';
const DEVICE_LIST_SIGN_PATH = '/home/device_list';
const DEVICE_LIST_DATA = '{"getVirtualModel":true,"getHuamiDevices":1,"get_split_device":false,"support_smart_home":true}';
const LOGIN_HOST = 'https://account.xiaomi.com';
const MAX_REDIRECTS = 6;
const MAX_PASSCODE_DEVICES = 5;
/** 设备型号/名称里出现这些词时，视为可能签发登录码的路由器/中枢 */
const GATEWAY_LIKE = /gateway|hub|router|central|中枢|网关|路由/i;

// ==================== 类型 ====================

/** 云端设备列表中取码所需的最小字段 */
export interface CloudDevice {
  did: string;
  name?: string;
  model?: string;
  modelName?: string;
  localip?: string;
  isOnline?: boolean;
}

export interface AutoPasscodeOptions extends CloudRequestOptions {
  /** 网关地址，用于按 localip 自动匹配签发登录码的设备 */
  gatewayUrl?: string;
  /** 直接指定签发登录码的设备 DID，跳过设备列表匹配 */
  deviceDid?: string;
  /** 小米账号凭据；缺省时优先读取本机扫码登录态，再回退环境变量 */
  credentials?: XiaomiCloudCredentials;
  /** 读取凭据的环境变量来源，默认 process.env */
  env?: EnvLike;
}

export interface AutoPasscodeResult {
  passcode: string;
  deviceDid: string;
  userId: string;
}

export interface ServiceToken {
  serviceToken: string;
  ssecurity: string;
  userId: string;
  cUserId?: string;
}

/** 是否已有可用于自动取码的凭据（本机扫码登录态或环境变量） */
export function isAutoLoginConfigured(env: EnvLike = process.env): boolean {
  return hasAutoLoginCredentials(env);
}

// ==================== 加密与签名 ====================

function base64(data: Buffer): string {
  return data.toString('base64');
}

function fromBase64(text: string): Buffer {
  return Buffer.from(text, 'base64');
}

function sha256(data: Buffer): Buffer {
  return createHash('sha256').update(data).digest();
}

function sha1(data: Buffer): Buffer {
  return createHash('sha1').update(data).digest();
}

function hmacSha256(key: Buffer, data: Buffer): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

/** 与 Python urllib.parse.quote(safe='') 对齐的 URL 编码 */
function urlEnc(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

/** 12 字节 nonce：8 字节随机 + 4 字节当前分钟（大端） */
function newNonce(): string {
  const buffer = Buffer.alloc(12);
  randomBytes(8).copy(buffer, 0);
  buffer.writeUInt32BE(Math.floor(Date.now() / 60000) >>> 0, 8);
  return base64(buffer);
}

/** 小米云签名里的 sn = base64(sha256(ssecurity + nonce)) */
function signNonce(ssecurity: string, nonce: string): string {
  return base64(sha256(Buffer.concat([fromBase64(ssecurity), fromBase64(nonce)])));
}

/** RC4；小米云要求先空转 1024 字节再开始使用 */
function rc4Bytes(key: Buffer, data: Buffer, skip = 1024): Buffer {
  const state = new Uint8Array(256);
  for (let i = 0; i < 256; i++) state[i] = i;

  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + state[i] + key[i % key.length]) & 255;
    const tmp = state[i];
    state[i] = state[j];
    state[j] = tmp;
  }

  const output = Buffer.alloc(data.length);
  let i = 0;
  j = 0;
  const total = skip + data.length;
  for (let step = 0; step < total; step++) {
    i = (i + 1) & 255;
    j = (j + state[i]) & 255;
    const tmp = state[i];
    state[i] = state[j];
    state[j] = tmp;
    const keyByte = state[(state[i] + state[j]) & 255];
    if (step >= skip) output[step - skip] = data[step - skip] ^ keyByte;
  }
  return output;
}

// ==================== 网络 ====================

function hostnameOf(url?: string): string {
  if (!url) return '';
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return '';
  }
}

/** 云端设备列表里的 localip 不带 IPv6 方括号，比较前统一去掉 */
function normalizeIp(value: string | undefined): string {
  return (value || '').trim().replace(/^\[|\]$/g, '');
}

function cookieHeader(credentials: XiaomiCloudCredentials): string {
  const parts = [`userId=${credentials.userId}`, `passToken=${credentials.passToken}`];
  if (credentials.cUserId) parts.push(`cUserId=${credentials.cUserId}`);
  if (credentials.deviceId) parts.push(`deviceId=${credentials.deviceId}`);
  return parts.join('; ');
}

// ==================== serviceToken ====================

interface ServiceLoginPayload {
  result?: string;
  message?: string;
  location?: string;
  ssecurity?: string;
  userId?: string | number;
  cUserId?: string;
}

interface MintTokenOptions extends CloudRequestOptions {
  /** 小米服务 ID：mijia=极客版取码，xiaomiio=云端设备列表 */
  sid?: string;
}

/**
 * 用 passToken 换取指定 sid 的 serviceToken。
 * 登录 JSON 里明确返回 result != ok 才算登录态失效；非 JSON/5xx 视为网络问题，
 * 避免把网关抖动误报成需要重新登录。
 */
export async function mintServiceToken(
  credentials: XiaomiCloudCredentials,
  options: MintTokenOptions = {}
): Promise<ServiceToken> {
  const ctx = makeContext(options);
  const sid = options.sid || 'mijia';
  const loginUrl = `${LOGIN_HOST}/pass/serviceLogin?sid=${encodeURIComponent(sid)}&_json=true&_locale=zh_CN`;
  const baseCookie = cookieHeader(credentials);

  const login = await requestText(ctx, loginUrl, {
    method: 'GET',
    headers: { 'User-Agent': UA_APP, Cookie: baseCookie },
  });

  if (login.status >= 500) {
    throw new XiaomiCloudError(
      'network',
      `小米登录服务暂时不可用（HTTP ${login.status}）`,
      sliceText(login.text)
    );
  }
  if (login.status === 401 || login.status === 403) {
    throw new XiaomiCloudError(
      'auth-expired',
      `小米登录服务拒绝认证（HTTP ${login.status}）。请重新扫码登录或更新 MIJIA_PASS_TOKEN`,
      sliceText(login.text)
    );
  }

  let payload: ServiceLoginPayload;
  try {
    payload = parseMiJson<ServiceLoginPayload>(login.text);
  } catch {
    throw new XiaomiCloudError(
      'network',
      `小米登录服务返回了非 JSON 响应（HTTP ${login.status}）`,
      sliceText(login.text)
    );
  }

  if (payload.result !== 'ok' || !payload.location) {
    const result = String(payload.result || payload.message || 'unknown');
    const needsVerify = result === 'verify';
    throw new XiaomiCloudError(
      'auth-expired',
      needsVerify
        ? '小米账号需要安全验证，passToken 无法直接换取登录态。请重新扫码登录或更新 MIJIA_PASS_TOKEN'
        : `小米账号登录态无效或已过期（${result}）。请重新扫码登录或更新 MIJIA_PASS_TOKEN`,
      payload.message || result
    );
  }

  if (!payload.ssecurity) {
    throw new XiaomiCloudError('api', '小米登录服务未返回 ssecurity');
  }

  const serviceToken = await followToServiceToken(ctx, payload.location, baseCookie);
  if (!serviceToken) {
    throw new XiaomiCloudError(
      'api',
      '未能从小米登录服务获取 serviceToken（登录跳转未携带该 Cookie）'
    );
  }

  return {
    serviceToken,
    ssecurity: payload.ssecurity,
    userId: String(payload.userId || credentials.userId),
    ...(payload.cUserId || credentials.cUserId
      ? { cUserId: payload.cUserId || credentials.cUserId }
      : {}),
  };
}

async function followToServiceToken(
  ctx: CloudContext,
  location: string,
  initialCookie: string
): Promise<string> {
  let url = location;
  let cookie = initialCookie;

  for (let hop = 0; hop < MAX_REDIRECTS; hop++) {
    const response = await requestText(ctx, url, {
      method: 'GET',
      headers: { 'User-Agent': UA_APP, Cookie: cookie },
      redirect: 'manual',
    });

    const token = cookieValue(response.headers, 'serviceToken');
    if (token) return token;

    cookie = mergeSetCookies(cookie, response.headers);

    if (response.status < 300 || response.status >= 400) break;
    const next = response.headers.get('location');
    if (!next) break;
    url = new URL(next, url).toString();
  }

  return '';
}

// ==================== 取码 ====================

function passcodeCookie(token: ServiceToken): string {
  const parts = [`serviceToken=${token.serviceToken}`, `userId=${token.userId}`];
  if (token.cUserId) parts.push(`cUserId=${token.cUserId}`);
  return parts.join('; ');
}

/**
 * 调用云端接口获取指定设备签发的一次性登录码。
 * auth/signature 类错误标记为 auth-expired，方便上层重新换票或提示重新登录。
 */
export async function fetchPasscode(
  deviceDid: string,
  token: ServiceToken,
  options: CloudRequestOptions = {}
): Promise<string> {
  const ctx = makeContext(options);
  const path = `/app/home/rpc/${deviceDid}`;
  const data = JSON.stringify({
    id: 2,
    method: 'miIO.get_central_link_passcode',
    accessKey: ACCESS_KEY,
    params: {},
  });

  const nonce = newNonce();
  const sn = signNonce(token.ssecurity, nonce);
  const signStr = [path.replace('/app/', '/'), sn, nonce, `data=${data}`].join('&');
  const signature = base64(hmacSha256(fromBase64(sn), Buffer.from(signStr, 'utf8')));
  const body = `_nonce=${urlEnc(nonce)}&data=${urlEnc(data)}&signature=${urlEnc(signature)}`;

  const response = await requestText(ctx, PASSCODE_HOST + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': UA_APP,
      Accept: '*/*',
      'X-XIAOMI-PROTOCAL-FLAG-CLI': 'PROTOCAL-HTTP2',
      'domain-refer': 'core.api.mijia.tech',
      'miot-request-model': 'xiaomi.gateway.hub1',
      Cookie: passcodeCookie(token),
    },
    body,
  });

  let payload: {
    result?: { passcode?: string | number };
    message?: string;
    error?: { message?: string };
  };
  if (response.status === 401 || response.status === 403) {
    throw new XiaomiCloudError(
      'auth-expired',
      `取码接口拒绝认证（HTTP ${response.status}）。请重新扫码登录或更新 MIJIA_PASS_TOKEN`,
      sliceText(response.text)
    );
  }
  try {
    payload = JSON.parse(response.text);
  } catch {
    throw new XiaomiCloudError(
      'api',
      `取码接口返回非 JSON（HTTP ${response.status}）`,
      sliceText(response.text)
    );
  }

  const raw = payload.result?.passcode;
  if (typeof raw === 'string' && /^\d{6}$/.test(raw)) return raw;
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= 999999) {
    return String(raw).padStart(6, '0');
  }

  const message = String(
    payload.message || payload.error?.message || `HTTP ${response.status}`
  );
  const authLike =
    response.status === 401 ||
    response.status === 403 ||
    /auth|signature|token|expired|登录|过期/i.test(message);
  throw new XiaomiCloudError(
    authLike ? 'auth-expired' : 'api',
    `取码失败：${message}`,
    sliceText(response.text)
  );
}

// ==================== 云端设备列表 ====================

/**
 * 拉取小米云设备列表（api.io.mi.com，需要 sid=xiaomiio 的 serviceToken）。
 * 该接口要求 RC4 + SHA-1 双层签名，参数顺序与签名串必须与米家 App 一致。
 */
export async function listCloudDevices(
  credentials: XiaomiCloudCredentials,
  options: CloudRequestOptions = {}
): Promise<CloudDevice[]> {
  const ctx = makeContext(options);
  const token = await mintServiceToken(credentials, { ...options, sid: 'xiaomiio' });

  const nonce = newNonce();
  const sn = signNonce(token.ssecurity, nonce);
  const key = fromBase64(sn);

  const hashInput = `POST&${DEVICE_LIST_SIGN_PATH}&data=${DEVICE_LIST_DATA}&${sn}`;
  const contentHash = base64(sha1(Buffer.from(hashInput, 'utf8')));
  const encryptedData = base64(rc4Bytes(key, Buffer.from(DEVICE_LIST_DATA, 'utf8')));
  const encryptedHash = base64(rc4Bytes(key, Buffer.from(contentHash, 'utf8')));

  const signInput = `POST&${DEVICE_LIST_SIGN_PATH}&data=${encryptedData}&rc4_hash__=${encryptedHash}&${sn}`;
  const signature = base64(sha1(Buffer.from(signInput, 'utf8')));

  const body = [
    `data=${urlEnc(encryptedData)}`,
    `rc4_hash__=${urlEnc(encryptedHash)}`,
    `signature=${urlEnc(signature)}`,
    `ssecurity=${urlEnc(token.ssecurity)}`,
    `_nonce=${urlEnc(nonce)}`,
  ].join('&');

  const cookie = [
    `userId=${token.userId}`,
    `yetAnotherServiceToken=${token.serviceToken}`,
    `serviceToken=${token.serviceToken}`,
    'locale=zh_CN',
    'timezone=GMT+8:00',
    'is_daylight=0',
    'dst_offset=0',
    'channel=MI_APP_STORE',
  ].join('; ');

  const response = await requestText(ctx, DEVICE_LIST_HOST + DEVICE_LIST_PATH, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept-Encoding': 'identity',
      'x-xiaomi-protocal-flag-cli': 'PROTOCAL-HTTP2',
      'MIOT-ENCRYPT-ALGORITHM': 'ENCRYPT-RC4',
      'User-Agent': UA_APP,
      Cookie: cookie,
    },
    body,
  });

  // 正常响应是 RC4 加密后的 base64；鉴权失败等场景可能直接返回明文 JSON
  const rawText = response.text.trim();
  if (response.status === 401 || response.status === 403) {
    throw new XiaomiCloudError(
      'auth-expired',
      `获取云端设备列表被拒绝认证（HTTP ${response.status}）。请重新扫码登录或更新 MIJIA_PASS_TOKEN`,
      sliceText(rawText)
    );
  }
  const plain = rawText.startsWith('{') || rawText.startsWith('[')
    ? rawText
    : rc4Bytes(key, fromBase64(rawText)).toString('utf8');
  let payload: {
    code?: number;
    message?: string;
    result?: { list?: Array<Record<string, unknown>> };
  };
  try {
    payload = JSON.parse(plain);
  } catch {
    throw new XiaomiCloudError(
      'api',
      `设备列表返回异常（HTTP ${response.status}）`,
      sliceText(plain)
    );
  }

  if (payload.code !== 0) {
    const message = String(payload.message || (payload.code === undefined ? '未知错误' : payload.code));
    const authLike = /auth|token|expired|login|登录|过期/i.test(message);
    throw new XiaomiCloudError(
      authLike ? 'auth-expired' : 'api',
      `获取云端设备列表失败：${message}`,
      sliceText(plain)
    );
  }

  const list = payload.result?.list;
  if (!Array.isArray(list)) {
    throw new XiaomiCloudError('api', '设备列表格式异常：缺少 result.list');
  }

  const devices: CloudDevice[] = [];
  for (const item of list) {
    const did = item?.did === undefined || item?.did === null ? '' : String(item.did);
    if (!did) continue;
    devices.push({
      did,
      name: typeof item.name === 'string' ? item.name : undefined,
      model: typeof item.model === 'string' ? item.model : undefined,
      modelName: typeof item.modelName === 'string' ? item.modelName : undefined,
      localip: typeof item.localip === 'string' ? item.localip : undefined,
      isOnline: Boolean(item.isOnline),
    });
  }
  return devices;
}

/**
 * 按优先级排出可能签发登录码的设备：
 * 1. localip 与网关主机名完全一致（在线优先）
 * 2. 在线的路由器/中枢类设备
 */
export function resolveGatewayCandidates(devices: CloudDevice[], gatewayUrl?: string): string[] {
  const host = hostnameOf(gatewayUrl);
  const result: string[] = [];
  const seen = new Set<string>();
  const add = (list: CloudDevice[]): void => {
    for (const device of list) {
      if (seen.has(device.did)) continue;
      seen.add(device.did);
      result.push(device.did);
    }
  };

  if (host) {
    const exact = devices.filter((device) => normalizeIp(device.localip) === host);
    add(exact.filter((device) => device.isOnline));
    add(exact.filter((device) => !device.isOnline));
  }

  add(
    devices.filter(
      (device) =>
        device.isOnline &&
        GATEWAY_LIKE.test(`${device.model || ''} ${device.modelName || ''} ${device.name || ''}`)
    )
  );

  return result;
}

/** 设备列表为空/匹配不到时，给出少量设备名方便用户填写 MIJIA_ROUTER_DID */
function describeDevices(devices: CloudDevice[]): string {
  const sample = devices.slice(0, 8).map((device) => `${device.name || '未命名'}(${device.did})`);
  return sample.length > 0 ? `云端设备示例：${sample.join('、')}` : '云端设备列表为空';
}

// ==================== 总入口 ====================

/**
 * 自动获取一次性登录码。
 *
 * 优先使用显式传入的 deviceDid / MIJIA_ROUTER_DID；
 * 否则拉取云端设备列表，按网关地址匹配签发设备。
 */
export async function getCentralLinkPasscode(
  options: AutoPasscodeOptions = {}
): Promise<AutoPasscodeResult> {
  const env = options.env || process.env;
  const credentials = options.credentials || resolveCredentials(env);
  if (!credentials) {
    throw new XiaomiCloudError(
      'not-configured',
      '未配置小米账号登录态。请先在 Web 登录页扫码登录，或设置 MIJIA_USER_ID 和 MIJIA_PASS_TOKEN（或 MIJIA_COOKIE），或改为手动提供 6 位登录码'
    );
  }

  const ctxOptions: CloudRequestOptions = {
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  };

  const deviceDid = options.deviceDid || readDeviceDidFromEnv(env);
  let candidates: string[] = [];
  if (deviceDid) {
    candidates = [deviceDid];
  } else {
    const devices = await listCloudDevices(credentials, ctxOptions);
    candidates = resolveGatewayCandidates(devices, options.gatewayUrl);
    if (candidates.length === 0) {
      throw new XiaomiCloudError(
        'device-not-found',
        `无法从云端设备列表确定签发登录码的设备。请设置 MIJIA_ROUTER_DID，或确认 GATEWAY_URL 与设备的局域网 IP 一致。${describeDevices(devices)}`
      );
    }
  }

  const token = await mintServiceToken(credentials, ctxOptions);
  let lastError: unknown;

  for (const candidate of candidates.slice(0, MAX_PASSCODE_DEVICES)) {
    try {
      const passcode = await fetchPasscode(candidate, token, ctxOptions);
      return { passcode, deviceDid: candidate, userId: token.userId };
    } catch (error) {
      lastError = error;

      if (error instanceof XiaomiCloudError && error.code === 'auth-expired') {
        // 票刚换过仍然被拒：再换一次，成功后只重试当前设备
        const fresh = await mintServiceToken(credentials, ctxOptions);
        const passcode = await fetchPasscode(candidate, fresh, ctxOptions);
        return { passcode, deviceDid: candidate, userId: fresh.userId };
      }

      if (error instanceof XiaomiCloudError && error.code === 'network') throw error;
      // 设备不匹配等 API 错误：继续尝试下一个候选设备
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new XiaomiCloudError('api', '取码失败：没有可用的候选设备');
}
