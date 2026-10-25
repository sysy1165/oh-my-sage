/**
 * 扫码登录 API
 * POST   创建二维码并开始等待扫码
 * GET    查询扫码状态（浏览器轮询）
 * DELETE 取消当前二维码会话
 */

import { NextRequest, NextResponse } from 'next/server';
import { XiaomiCloudError } from '@/core/cloud/miHttp';
import { cancelQrSession, getQrSession, startQrSession } from '@/server/auth/qrSessions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  try {
    const state = await startQrSession();
    return NextResponse.json({
      success: true,
      sessionId: state.id,
      qrUrl: state.qrUrl,
      expiresIn: state.timeoutMs,
      ...(state.qrTips ? { qrTips: state.qrTips } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误';
    const code = error instanceof XiaomiCloudError ? error.code : undefined;
    const status = message.includes('会话过多') ? 429 : 502;
    console.error('获取扫码登录二维码失败:', error);
    return NextResponse.json({
      success: false,
      error: '获取二维码失败',
      message,
      ...(code ? { code } : {}),
    }, { status });
  }
}

export async function GET(request: NextRequest) {
  const sessionId = request.nextUrl.searchParams.get('sessionId') || '';
  const state = getQrSession(sessionId);
  if (!state) {
    return NextResponse.json({
      success: false,
      status: 'missing',
      message: '二维码会话不存在或已过期，请刷新',
    }, { status: 404 });
  }

  const expiresIn = Math.max(0, state.startedAt + state.timeoutMs - Date.now());
  return NextResponse.json({
    success: true,
    status: state.status,
    ...(state.status === 'pending' ? { expiresIn } : {}),
    ...(state.message ? { message: state.message } : {}),
    ...(state.status === 'success' ? { saved: true } : {}),
  });
}

export async function DELETE(request: NextRequest) {
  const sessionId = request.nextUrl.searchParams.get('sessionId') || '';
  cancelQrSession(sessionId);
  return NextResponse.json({ success: true });
}
