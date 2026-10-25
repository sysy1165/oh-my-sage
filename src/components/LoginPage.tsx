'use client';

import React, {useState, useCallback, useEffect, useRef} from 'react';
import {Input, Button, message, Typography, Spin} from 'antd';
import {LockOutlined, ThunderboltFilled} from '@ant-design/icons';

const {Text} = Typography;

interface LoginPageProps {
    onLoginSuccess: (passcode: string) => void;
}

interface LoginOutcome {
    success: boolean;
    code?: string;
    message?: string;
}

type QrStatus = 'idle' | 'loading' | 'pending' | 'success' | 'expired' | 'error';

function formatCountdown(seconds: number): string {
    const safe = Math.max(0, seconds);
    const mm = Math.floor(safe / 60);
    const ss = String(safe % 60).padStart(2, '0');
    return `${mm}:${ss}`;
}

export default function LoginPage({onLoginSuccess}: LoginPageProps) {
    const [passcode, setPasscode] = useState('');
    const [loading, setLoading] = useState(false);
    const [autoLoading, setAutoLoading] = useState(false);
    const [autoLogin, setAutoLogin] = useState(false);
    const [autoError, setAutoError] = useState('');

    const [showQr, setShowQr] = useState(false);
    const [qrStatus, setQrStatus] = useState<QrStatus>('idle');
    const [qrUrl, setQrUrl] = useState('');
    const [qrSessionId, setQrSessionId] = useState('');
    const [qrMessage, setQrMessage] = useState('');
    const [qrTips, setQrTips] = useState('');
    const [qrExpiresAt, setQrExpiresAt] = useState(0);
    const [qrSecondsLeft, setQrSecondsLeft] = useState(0);

    const isLoggingRef = useRef(false);
    const autoAttemptedRef = useRef(false);
    const onLoginSuccessRef = useRef(onLoginSuccess);
    const qrBusyRef = useRef(false);
    const qrSessionIdRef = useRef('');

    useEffect(() => {
        onLoginSuccessRef.current = onLoginSuccess;
    }, [onLoginSuccess]);

    useEffect(() => {
        qrSessionIdRef.current = qrSessionId;
    }, [qrSessionId]);

    const doLogin = useCallback(async (code?: string): Promise<LoginOutcome> => {
        if (isLoggingRef.current) return {success: false, message: '正在登录中'};
        if (code !== undefined && code.length !== 6) return {success: false, message: '登录码格式错误'};
        isLoggingRef.current = true;
        setLoading(true);
        setAutoError('');
        if (code === undefined) setAutoLoading(true);
        try {
            const response = await fetch('/api/auth', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(code ? {passcode: code} : {}),
            });
            const result = await response.json();
            if (result.success) {
                message.success(result.auth === 'auto' ? '已自动获取登录码并连接' : '连接成功');
                onLoginSuccessRef.current(code || '');
                return {success: true};
            }
            const text = result.message || result.error || '连接失败';
            message.error(text);
            if (!code) setAutoError(text);
            isLoggingRef.current = false;
            return {
                success: false,
                code: typeof result.code === 'string' ? result.code : undefined,
                message: text,
            };
        } catch (error) {
            const text = '连接失败: ' + String(error);
            message.error(text);
            if (!code) setAutoError(text);
            isLoggingRef.current = false;
            return {success: false, message: text};
        } finally {
            setLoading(false);
            setAutoLoading(false);
        }
    }, []);

    const startQr = useCallback(async (notice?: string) => {
        if (qrBusyRef.current) return;
        qrBusyRef.current = true;

        const previous = qrSessionIdRef.current;
        if (previous) {
            qrSessionIdRef.current = '';
            void fetch(`/api/auth/qr?sessionId=${encodeURIComponent(previous)}`, {method: 'DELETE'}).catch(() => undefined);
        }

        setShowQr(true);
        setQrStatus('loading');
        setQrUrl('');
        setQrSessionId('');
        setQrTips('');
        setQrExpiresAt(0);
        setQrSecondsLeft(0);
        setQrMessage(notice || '正在获取二维码…');

        try {
            const response = await fetch('/api/auth/qr', {method: 'POST'});
            const result = await response.json();
            if (!response.ok || !result.success) {
                throw new Error(result.message || result.error || '获取二维码失败');
            }
            setQrUrl(result.qrUrl);
            setQrSessionId(result.sessionId);
            qrSessionIdRef.current = result.sessionId;
            setQrTips(result.qrTips || '');
            const expiresIn = Number(result.expiresIn) || 0;
            setQrExpiresAt(Date.now() + expiresIn);
            setQrSecondsLeft(Math.ceil(expiresIn / 1000));
            setQrStatus('pending');
            setQrMessage('');
        } catch (error) {
            setQrStatus('error');
            setQrMessage(error instanceof Error ? error.message : String(error));
        } finally {
            qrBusyRef.current = false;
        }
    }, []);

    const exitQr = useCallback(() => {
        const id = qrSessionIdRef.current;
        if (id && qrStatus === 'pending') {
            void fetch(`/api/auth/qr?sessionId=${encodeURIComponent(id)}`, {method: 'DELETE'}).catch(() => undefined);
        }
        qrSessionIdRef.current = '';
        setQrSessionId('');
        setQrStatus('idle');
        setShowQr(false);
    }, [qrStatus]);

    // 打开页面时：已连接则直接进入；有登录态则自动取码；失效则提示扫码
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const response = await fetch('/api/auth');
                const result = await response.json();
                if (cancelled) return;
                if (result.connected) {
                    onLoginSuccessRef.current('');
                    return;
                }
                if (!result.autoLogin) {
                    setAutoLogin(false);
                    return;
                }
                setAutoLogin(true);
                if (!autoAttemptedRef.current) {
                    autoAttemptedRef.current = true;
                    const outcome = await doLogin();
                    // StrictMode 下第一次 effect 可能被取消，这里的扫码提示仍然需要生效
                    if (!outcome.success && (outcome.code === 'auth-expired' || outcome.code === 'not-configured')) {
                        setShowQr(true);
                        void startQr(outcome.code === 'auth-expired'
                            ? '登录态已过期，请用米家 App 重新扫码。登录后会保存在本机，下次打开无需再扫。'
                            : '请用米家 App 扫码登录小米账号。登录后会保存在本机，下次打开无需再扫。');
                    }
                }
            } catch {
                if (!cancelled) setAutoLogin(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [doLogin, startQr]);

    // 轮询扫码状态；成功后直接用保存的登录态取码并连接
    useEffect(() => {
        if (!qrSessionId || qrStatus !== 'pending') return;
        let cancelled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const poll = async () => {
            try {
                const response = await fetch(`/api/auth/qr?sessionId=${encodeURIComponent(qrSessionId)}`, {cache: 'no-store'});
                const result = await response.json();
                if (cancelled) return;

                if (result.status === 'success') {
                    setQrStatus('success');
                    setQrMessage('扫码成功，正在连接网关…');
                    setAutoLogin(true);
                    const outcome = await doLogin();
                    // 这里不能用 cancelled 判断：切到 success 会触发本 effect 清理，
                    // 但连接失败仍需要反馈给用户。
                    if (!outcome.success) {
                        setQrStatus('error');
                        setQrMessage(outcome.message || '扫码成功，但连接网关失败');
                    }
                    return;
                }

                if (result.status === 'expired' || result.status === 'error' || result.status === 'missing') {
                    setQrStatus(result.status === 'expired' ? 'expired' : 'error');
                    setQrMessage(result.message || '二维码已过期，请刷新');
                    return;
                }
            } catch {
                // 网络抖动时继续轮询，二维码本身有有效期
            }
            if (!cancelled) timer = setTimeout(poll, 2000);
        };

        timer = setTimeout(poll, 1500);
        return () => {
            cancelled = true;
            if (timer) clearTimeout(timer);
        };
    }, [qrSessionId, qrStatus, doLogin]);

    // 二维码倒计时
    useEffect(() => {
        if (qrStatus !== 'pending' || !qrExpiresAt) return;
        const update = () => setQrSecondsLeft(Math.max(0, Math.ceil((qrExpiresAt - Date.now()) / 1000)));
        update();
        const timer = setInterval(update, 1000);
        return () => clearInterval(timer);
    }, [qrStatus, qrExpiresAt]);

    const handlePasscodeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value.replace(/\D/g, '');
        setPasscode(value);
        if (value.length === 6) {
            setTimeout(() => doLogin(value), 0);
        }
    };

    const qrStatusText = (): string => {
        if (qrStatus === 'loading') return '正在获取二维码…';
        if (qrStatus === 'success') return qrMessage || '扫码成功，正在连接网关…';
        if (qrStatus === 'expired') return '二维码已过期，请刷新后重新扫码';
        if (qrStatus === 'error') return qrMessage || '二维码登录失败，请刷新重试';
        if (qrStatus === 'pending') return `二维码有效期 ${formatCountdown(qrSecondsLeft)}；登录态会保存在本机，下次打开无需再扫`;
        return '';
    };

    return (
        <div style={{
            height: '100vh', display: 'flex', justifyContent: 'center', alignItems: 'center',
            background: 'var(--bg-deep)',
            position: 'relative', overflow: 'hidden',
        }}>
            {/* 动态背景光效 */}
            <div style={{
                position: 'absolute', width: 600, height: 600,
                borderRadius: '50%', filter: 'blur(120px)', opacity: 0.15,
                background: 'var(--gradient-primary)',
                top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
                animation: 'gradientShift 8s ease infinite',
                backgroundSize: '200% 200%',
            }}/>
            <div style={{
                position: 'absolute', width: 400, height: 400,
                borderRadius: '50%', filter: 'blur(100px)', opacity: 0.1,
                background: 'var(--gradient-accent)',
                top: '30%', left: '60%',
                animation: 'gradientShift 10s ease infinite reverse',
                backgroundSize: '200% 200%',
            }}/>

            {/* 登录卡片 */}
            <div
                className="glass-panel"
                style={{
                    width: 380, padding: showQr ? '28px 32px' : '40px 36px',
                    borderRadius: 'var(--radius-xl)',
                    textAlign: 'center',
                    position: 'relative', zIndex: 1,
                    boxShadow: 'var(--shadow-lg)',
                    animation: 'fadeInUp 0.6s var(--ease-out)',
                    maxHeight: '92vh', overflowY: 'auto',
                }}
            >
                {/* Logo */}
                <div style={{
                    width: 64, height: 64, margin: '0 auto 24px',
                    borderRadius: 'var(--radius-lg)',
                    background: 'var(--gradient-primary)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    boxShadow: '0 0 40px rgba(99,102,241,0.3)',
                }}>
                    <ThunderboltFilled style={{fontSize: 28, color: '#fff'}}/>
                </div>

                <h1 className="gradient-text" style={{
                    fontSize: 26, fontWeight: 800, margin: '0 0 6px',
                    letterSpacing: -0.5,
                }}>
                    Oh My Sage
                </h1>
                <Text style={{color: 'var(--text-muted)', fontSize: 13, display: 'block', marginBottom: showQr ? 18 : 32}}>
                    米家自动化极客版 AI Agent
                </Text>

                {showQr ? (
                    <>
                        <Text style={{color: 'var(--text)', fontSize: 15, fontWeight: 600, display: 'block', marginBottom: 6}}>
                            扫码登录小米账号
                        </Text>
                        <Text style={{color: 'var(--text-muted)', fontSize: 11, display: 'block', marginBottom: 16}}>
                            登录一次后保存在本机，失效前无需重复扫码
                        </Text>

                        <div style={{
                            width: 240, height: 240, margin: '0 auto 14px',
                            borderRadius: 12, background: '#fff',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            overflow: 'hidden',
                        }}>
                            {qrUrl ? (
                                // 一次性登录二维码，不能走 next/image 的缓存与优化
                                // eslint-disable-next-line @next/next/no-img-element
                                <img
                                    src={qrUrl}
                                    alt="米家扫码登录二维码"
                                    width={240}
                                    height={240}
                                    referrerPolicy="no-referrer"
                                    style={{display: 'block'}}
                                    onError={() => {
                                        setQrStatus('error');
                                        setQrMessage('二维码图片加载失败，请刷新');
                                    }}
                                />
                            ) : (
                                <Spin tip="正在获取二维码..."><div style={{width: 200, height: 80}}/></Spin>
                            )}
                        </div>

                        <Text style={{
                            color: qrStatus === 'expired' || qrStatus === 'error' ? '#d93025' : 'var(--text-muted)',
                            fontSize: 12, display: 'block', marginBottom: 8, minHeight: 20,
                        }}>
                            {qrStatusText()}
                        </Text>

                        {qrStatus === 'pending' && qrTips && (
                            <Text style={{color: 'var(--text-muted)', fontSize: 11, display: 'block', marginBottom: 12}}>
                                {qrTips}
                            </Text>
                        )}

                        {(qrStatus === 'expired' || qrStatus === 'error') && (
                            <Button
                                type="primary"
                                block
                                onClick={() => void startQr()}
                                style={{borderRadius: 'var(--radius-md)', height: 42, fontSize: 14, fontWeight: 600, marginBottom: 8}}
                            >
                                刷新二维码
                            </Button>
                        )}

                        {qrStatus !== 'success' && (
                            <Button type="link" onClick={exitQr} style={{fontSize: 12}}>
                                返回手动输入登录码
                            </Button>
                        )}
                    </>
                ) : (
                    <>
                        {autoLogin ? (
                            <>
                                <Button
                                    size="large"
                                    block
                                    onClick={() => void doLogin()}
                                    loading={loading}
                                    disabled={loading}
                                    style={{
                                        borderRadius: 'var(--radius-md)',
                                        height: 44, fontSize: 14, fontWeight: 600,
                                        marginBottom: 16,
                                    }}
                                >
                                    {autoLoading ? '正在自动获取登录码...' : '自动获取登录码并连接'}
                                </Button>
                                <div style={{
                                    display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16,
                                }}>
                                    <div style={{flex: 1, height: 1, background: 'rgba(128,128,128,0.25)'}}/>
                                    <Text style={{color: 'var(--text-muted)', fontSize: 11}}>或手动输入</Text>
                                    <div style={{flex: 1, height: 1, background: 'rgba(128,128,128,0.25)'}}/>
                                </div>
                            </>
                        ) : (
                            <>
                                <Button
                                    size="large"
                                    block
                                    onClick={() => void startQr()}
                                    disabled={loading}
                                    style={{
                                        borderRadius: 'var(--radius-md)',
                                        height: 44, fontSize: 14, fontWeight: 600,
                                        marginBottom: 16,
                                    }}
                                >
                                    扫码登录小米账号（推荐）
                                </Button>
                                <div style={{
                                    display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16,
                                }}>
                                    <div style={{flex: 1, height: 1, background: 'rgba(128,128,128,0.25)'}}/>
                                    <Text style={{color: 'var(--text-muted)', fontSize: 11}}>或手动输入登录码</Text>
                                    <div style={{flex: 1, height: 1, background: 'rgba(128,128,128,0.25)'}}/>
                                </div>
                            </>
                        )}

                        <div style={{marginBottom: 20}}>
                            <Input
                                prefix={<LockOutlined style={{color: 'var(--text-muted)'}}/>}
                                placeholder="输入 6 位米家登录码"
                                maxLength={6}
                                size="large"
                                value={passcode}
                                onChange={handlePasscodeChange}
                                disabled={loading}
                                style={{
                                    textAlign: 'center', letterSpacing: 6, fontSize: 18, fontWeight: 600,
                                    borderRadius: 'var(--radius-md)',
                                }}
                            />
                            <Text style={{color: 'var(--text-muted)', fontSize: 11, marginTop: 8, display: 'block'}}>
                                {autoLogin
                                    ? '已配置小米账号登录态，打开页面会自动取码；失效后才需要重新扫码'
                                    : '输入 6 位后自动连接'}
                            </Text>
                            {autoError && (
                                <Text style={{color: '#d93025', fontSize: 11, marginTop: 8, display: 'block'}}>
                                    {autoError}
                                </Text>
                            )}
                        </div>

                        <Button
                            type="primary"
                            size="large"
                            block
                            onClick={() => void doLogin(passcode)}
                            loading={loading && !autoLoading}
                            disabled={passcode.length !== 6}
                            style={{
                                borderRadius: 'var(--radius-md)',
                                height: 44, fontSize: 15, fontWeight: 600,
                            }}
                        >
                            {loading && !autoLoading ? '正在连接网关...' : '连接网关'}
                        </Button>

                        {autoLogin && (
                            <Button
                                type="link"
                                onClick={() => void startQr()}
                                disabled={loading}
                                style={{marginTop: 8, fontSize: 12.5}}
                            >
                                登录态失效？重新扫码登录
                            </Button>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}
