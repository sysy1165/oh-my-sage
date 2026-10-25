/**
 * 认证 API
 * 负责网关认证；支持直接使用 6 位登录码，或从小米云自动取码
 */

import {NextRequest, NextResponse} from 'next/server';
import {clearStoredCredentials, credentialSource, readStoredCredentials} from '@/core/cloud/credentialStore';
import {getCentralLinkPasscode, isAutoLoginConfigured, XiaomiCloudError} from '@/core/cloud/passcode';
import {connectGateway, isGatewayConnected} from '@/server/gateway/shared';

export const runtime = 'nodejs';
// GET 依赖运行时的连接状态和环境变量，禁止构建期静态化
export const dynamic = 'force-dynamic';

/**
 * GET /api/auth
 * 登录页用于判断是否已连接、服务端是否配置了自动取码
 */
export async function GET() {
    const source = credentialSource();
    const stored = readStoredCredentials();
    return NextResponse.json({
        success: true,
        connected: isGatewayConnected(),
        autoLogin: source !== null,
        authSource: source,
        ...(source === 'stored' && stored?.savedAt ? {savedAt: stored.savedAt} : {}),
    });
}

/**
 * DELETE /api/auth
 * 清除本机保存的扫码登录态（环境变量不受影响）
 */
export async function DELETE() {
    clearStoredCredentials();
    return NextResponse.json({success: true, message: '已清除本机保存的小米登录态'});
}

/**
 * POST /api/auth
 * 登录并建立网关连接。不传 passcode 时尝试自动取码。
 */
export async function POST(request: NextRequest) {
    let auto = false;
    try {
        let body: {passcode?: unknown} = {};
        try {
            body = await request.json();
        } catch {
            // 空请求体等同于自动取码
        }

        const rawPasscode = body.passcode;
        if (rawPasscode !== undefined && rawPasscode !== null && typeof rawPasscode !== 'string') {
            return NextResponse.json({
                success: false,
                error: '登录码格式错误',
                message: '请提供6位数字登录码',
            }, {status: 400});
        }
        const passcode = typeof rawPasscode === 'string' ? rawPasscode.trim() : '';
        if (passcode && !/^\d{6}$/.test(passcode)) {
            return NextResponse.json({
                success: false,
                error: '登录码格式错误',
                message: '请提供6位数字登录码',
            }, {status: 400});
        }

        if (!process.env.GATEWAY_URL) {
            return NextResponse.json({success: false, error: '未配置网关地址', message: '请在服务端设置 GATEWAY_URL'}, {status: 400});
        }

        let code = passcode;
        let deviceDid: string | undefined;
        if (!code) {
            auto = true;
            const result = await getCentralLinkPasscode({gatewayUrl: process.env.GATEWAY_URL});
            code = result.passcode;
            deviceDid = result.deviceDid;
        }

        await connectGateway(code);

        return NextResponse.json({
            success: true,
            message: auto ? '已自动获取登录码并连接' : '成功连接到网关',
            ...(auto ? {auth: 'auto'} : {auth: 'passcode'}),
            ...(deviceDid ? {deviceDid} : {}),
        });
    } catch (error) {
        console.error(auto ? '自动登录失败:' : '认证失败:', error);
        const message = error instanceof Error ? error.message : '未知错误';
        const code = error instanceof XiaomiCloudError ? error.code : undefined;
        const status = code === 'not-configured' || code === 'device-not-found'
            ? 400
            : code === 'auth-expired'
                ? 401
                : /认证|登录码/.test(message) ? 401 : 502;
        return NextResponse.json({
            success: false,
            error: auto ? '自动登录失败' : '认证失败',
            message,
            ...(code ? {code} : {}),
        }, {status});
    }
}
