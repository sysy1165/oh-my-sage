/**
 * Core - 小米账号凭据解析
 * 支持 MIJIA_COOKIE 整段 Cookie，或单项 MIJIA_USER_ID / MIJIA_PASS_TOKEN 等。
 */

/** 小米账号凭据。passToken 等同于账号登录态，切勿提交到仓库。 */
export interface XiaomiCloudCredentials {
  userId: string;
  passToken: string;
  cUserId?: string;
  deviceId?: string;
}

export type EnvLike = Record<string, string | undefined>;

/** 解析 `a=1; b=2` 形式的 Cookie 头 */
export function parseCookieHeader(header: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name && value) cookies[name] = value;
  }
  return cookies;
}

/**
 * 从环境变量读取小米账号凭据。
 *
 * 支持两种写法：
 * - MIJIA_COOKIE：整段 Cookie（userId=...; passToken=...; ...），方便从浏览器复制
 * - MIJIA_USER_ID + MIJIA_PASS_TOKEN（必填），MIJIA_C_USER_ID / MIJIA_DEVICE_ID 可选
 *
 * 单项环境变量优先于 MIJIA_COOKIE 中的同名值。
 */
export function readCredentialsFromEnv(env: EnvLike = process.env): XiaomiCloudCredentials | null {
  const fromCookie = parseCookieHeader(env.MIJIA_COOKIE || '');
  const userId = (env.MIJIA_USER_ID || fromCookie.userId || '').trim();
  const passToken = (env.MIJIA_PASS_TOKEN || fromCookie.passToken || '').trim();
  if (!userId || !passToken) return null;

  const cUserId = (env.MIJIA_C_USER_ID || fromCookie.cUserId || '').trim();
  const deviceId = (env.MIJIA_DEVICE_ID || fromCookie.deviceId || '').trim();
  return {
    userId,
    passToken,
    ...(cUserId ? { cUserId } : {}),
    ...(deviceId ? { deviceId } : {}),
  };
}

/** 是否配置了环境变量形式的凭据（不读取本机保存的扫码登录态） */
export function isEnvCredentialsConfigured(env: EnvLike = process.env): boolean {
  return readCredentialsFromEnv(env) !== null;
}

/** 从环境变量读取签发登录码的设备 DID（可选） */
export function readDeviceDidFromEnv(env: EnvLike = process.env): string | undefined {
  const did = (env.MIJIA_ROUTER_DID || '').trim();
  return did || undefined;
}
