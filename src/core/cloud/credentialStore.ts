/**
 * Core - 本机小米登录态存储
 *
 * 扫码登录成功后把 passToken / userId / cUserId / deviceId 保存到
 * .sessionstore/mijia-auth.json（可用 MIJIA_AUTH_FILE 覆盖），后续自动取码直接复用，
 * 只有登录态失效时才需要重新扫码。
 *
 * 文件只保存长期凭据，不保存 serviceToken / ssecurity。读取时不会记录或打印内容。
 */

import fs from 'node:fs';
import path from 'node:path';
import { readCredentialsFromEnv, type EnvLike, type XiaomiCloudCredentials } from './credentials';

export interface StoredXiaomiCredentials extends XiaomiCloudCredentials {
  source: 'qr' | 'manual';
  savedAt: number;
  expireTime?: number;
}

export const DEFAULT_AUTH_FILE = path.join('.sessionstore', 'mijia-auth.json');

/** 登录态文件路径：MIJIA_AUTH_FILE 优先，否则为当前工作目录下的 .sessionstore/mijia-auth.json */
export function resolveAuthFile(env: EnvLike = process.env): string {
  const custom = (env.MIJIA_AUTH_FILE || '').trim();
  return path.resolve(process.cwd(), custom || DEFAULT_AUTH_FILE);
}

function normalizeStored(data: unknown): StoredXiaomiCredentials | null {
  if (!data || typeof data !== 'object') return null;
  const raw = data as Record<string, unknown>;
  const userId = typeof raw.userId === 'string' ? raw.userId.trim() : '';
  const passToken = typeof raw.passToken === 'string' ? raw.passToken.trim() : '';
  if (!userId || !passToken) return null;

  const cUserId = typeof raw.cUserId === 'string' ? raw.cUserId.trim() : '';
  const deviceId = typeof raw.deviceId === 'string' ? raw.deviceId.trim() : '';
  const savedAt = typeof raw.savedAt === 'number' && Number.isFinite(raw.savedAt) ? raw.savedAt : 0;
  const expireTime = typeof raw.expireTime === 'number' && Number.isFinite(raw.expireTime)
    ? raw.expireTime
    : undefined;

  return {
    userId,
    passToken,
    ...(cUserId ? { cUserId } : {}),
    ...(deviceId ? { deviceId } : {}),
    source: raw.source === 'manual' ? 'manual' : 'qr',
    savedAt,
    ...(expireTime ? { expireTime } : {}),
  };
}

/** 读取本机保存的扫码登录态；文件不存在或损坏时返回 null */
export function readStoredCredentials(env: EnvLike = process.env): StoredXiaomiCredentials | null {
  try {
    const raw = fs.readFileSync(resolveAuthFile(env), 'utf8');
    return normalizeStored(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** 保存扫码登录态（尽量以 0600 权限写入，原子替换） */
export function saveStoredCredentials(credentials: StoredXiaomiCredentials, env: EnvLike = process.env): void {
  const file = resolveAuthFile(env);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const payload = {
    userId: credentials.userId,
    passToken: credentials.passToken,
    ...(credentials.cUserId ? { cUserId: credentials.cUserId } : {}),
    ...(credentials.deviceId ? { deviceId: credentials.deviceId } : {}),
    source: credentials.source,
    savedAt: credentials.savedAt || Date.now(),
    ...(credentials.expireTime ? { expireTime: credentials.expireTime } : {}),
  };
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;

  fs.writeFileSync(tmp, text, { mode: 0o600 });
  try {
    fs.renameSync(tmp, file);
  } catch {
    // Windows 上目标文件已存在时 rename 可能失败，退化为覆盖写入
    fs.copyFileSync(tmp, file);
  } finally {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      // 清理临时文件失败不影响主流程
    }
  }
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Windows 不支持 POSIX 权限，忽略
  }
}

/** 删除本机保存的登录态（用于登录失效后回退到环境变量或重新扫码） */
export function clearStoredCredentials(env: EnvLike = process.env): void {
  try {
    fs.unlinkSync(resolveAuthFile(env));
  } catch {
    // 文件不存在或不可删除时忽略
  }
}

/** 凭据优先级：本机扫码登录态 > 环境变量 */
export function resolveCredentials(env: EnvLike = process.env): XiaomiCloudCredentials | null {
  return readStoredCredentials(env) || readCredentialsFromEnv(env);
}

/** 是否已有可用于自动取码的凭据（扫码保存或环境变量） */
export function hasAutoLoginCredentials(env: EnvLike = process.env): boolean {
  return resolveCredentials(env) !== null;
}

/** 当前凭据来源，供登录页/状态工具展示 */
export function credentialSource(env: EnvLike = process.env): 'stored' | 'env' | null {
  if (readStoredCredentials(env)) return 'stored';
  if (readCredentialsFromEnv(env)) return 'env';
  return null;
}
