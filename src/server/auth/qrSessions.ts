/**
 * Web - 扫码登录会话管理
 *
 * 二维码获取后立即在后台长轮询；浏览器只拿 sessionId / qrUrl 轮询状态。
 * 扫码成功后把 passToken 等凭据写入本机 .sessionstore/mijia-auth.json。
 */

import { completeQrLogin, startQrLogin, type QrLoginSession } from '@/core/cloud/qrLogin';
import { saveStoredCredentials } from '@/core/cloud/credentialStore';
import { XiaomiCloudError } from '@/core/cloud/miHttp';

export type QrSessionStatus = 'pending' | 'success' | 'expired' | 'error';

export interface QrSessionState extends QrLoginSession {
  status: QrSessionStatus;
  message?: string;
  completedAt?: number;
  /** 用户取消或会话被回收后，后台长轮询不再写入结果 */
  cancelled?: boolean;
}

const globalKey = '__oh_my_sage_qr_sessions__';
const MAX_SESSIONS = 5;
const PENDING_TTL_MS = 15 * 60 * 1000;
const COMPLETED_TTL_MS = 60 * 1000;

function getSessions(): Map<string, QrSessionState> {
  const globalStore = globalThis as Record<string, unknown>;
  let sessions = globalStore[globalKey] as Map<string, QrSessionState> | undefined;
  if (!sessions) {
    sessions = new Map();
    globalStore[globalKey] = sessions;
  }
  return sessions;
}

function prune(): void {
  const now = Date.now();
  const sessions = getSessions();
  for (const [id, state] of sessions) {
    if (state.status === 'pending') {
      if (now - state.startedAt > PENDING_TTL_MS) {
        state.cancelled = true;
        sessions.delete(id);
      }
      continue;
    }
    if (state.completedAt && now - state.completedAt > COMPLETED_TTL_MS) {
      sessions.delete(id);
    }
  }
}

/** 创建二维码并启动后台长轮询 */
export async function startQrSession(): Promise<QrSessionState> {
  prune();
  const sessions = getSessions();
  if (sessions.size >= MAX_SESSIONS) {
    const completed = [...sessions.values()]
      .filter((state) => state.status !== 'pending')
      .sort((a, b) => (a.completedAt || 0) - (b.completedAt || 0));
    if (completed.length > 0) {
      sessions.delete(completed[0].id);
    } else {
      throw new Error('二维码登录会话过多，请稍后再试');
    }
  }

  const session = await startQrLogin();
  const state: QrSessionState = { ...session, status: 'pending' };
  sessions.set(state.id, state);

  void completeQrLogin(session)
    .then((credentials) => {
      if (state.cancelled) return;
      saveStoredCredentials(credentials);
      state.status = 'success';
      state.completedAt = Date.now();
    })
    .catch((error: unknown) => {
      if (state.cancelled) return;
      state.status = error instanceof XiaomiCloudError && error.code === 'qr-expired'
        ? 'expired'
        : 'error';
      state.message = error instanceof Error ? error.message : String(error);
      state.completedAt = Date.now();
    });

  return state;
}

export function getQrSession(sessionId: string): QrSessionState | undefined {
  prune();
  if (!sessionId) return undefined;
  return getSessions().get(sessionId);
}

export function cancelQrSession(sessionId: string): void {
  const sessions = getSessions();
  const state = sessions.get(sessionId);
  if (!state) return;
  state.cancelled = true;
  sessions.delete(sessionId);
}
