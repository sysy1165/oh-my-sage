import assert from 'node:assert/strict';
import test from 'node:test';
import { completeQrLogin, startQrLogin, type QrLoginSession } from '../../src/core/cloud/qrLogin';
import { XiaomiCloudError } from '../../src/core/cloud/miHttp';

const SERVICE_LOCATION = 'https://account.xiaomi.com/fe/service/login?_json=true&_locale=zh_CN&sid=mijia'
    + '&qs=%253F_json%253Dtrue%2526sid%253Dmijia&callback=https%3A%2F%2Fsts.api.mijia.tech%2Fmijia%2Fsts'
    + '&_sign=sign-value&serviceParam=%7B%22checkSafePhone%22%3Afalse%7D';

function qrStartResponse(): Response {
    return new Response(`&&&START&&&${JSON.stringify({
        code: 70016,
        result: 'error',
        desc: '登录验证失败',
        location: SERVICE_LOCATION,
    })}`, { status: 200 });
}

function qrLoginResponse(): Response {
    return new Response(`&&&START&&&${JSON.stringify({
        code: 0,
        result: 'ok',
        loginUrl: 'https://ak.account.xiaomi.com/longPolling/login?ticket=lp_test',
        qr: 'https://account.xiaomi.com/pass/qr/login?ticket=lp_test',
        lp: 'https://ak.lp.account.xiaomi.com/lp/s?k=lp_test',
        timeout: 300,
        qrTips: '可使用小米手机或平板扫码登录',
    })}`, { status: 200 });
}

function sessionFixture(overrides: Partial<QrLoginSession> = {}): QrLoginSession {
    return {
        id: 'session-test',
        qrUrl: 'https://account.xiaomi.com/pass/qr/login?ticket=lp_test',
        loginUrl: 'https://ak.account.xiaomi.com/longPolling/login?ticket=lp_test',
        lp: 'https://ak.lp.account.xiaomi.com/lp/s?k=lp_test',
        deviceId: '0123456789abcdef',
        cookie: 'deviceId=0123456789abcdef; pass_o=0123456789abcdef; sdkVersion=3.4.1',
        timeoutMs: 300000,
        startedAt: Date.now(),
        ...overrides,
    };
}

test('获取二维码：解析 qr/lp/timeout，并在请求里携带设备 Cookie', async () => {
    const requests: Array<{ url: string; cookie: string }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        requests.push({ url, cookie: new Headers(init?.headers).get('cookie') || '' });
        if (url.includes('/pass/serviceLogin')) return qrStartResponse();
        if (url.includes('/longPolling/loginUrl')) return qrLoginResponse();
        throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;

    const session = await startQrLogin({ fetchImpl });

    assert.equal(session.qrUrl, 'https://account.xiaomi.com/pass/qr/login?ticket=lp_test');
    assert.equal(session.lp, 'https://ak.lp.account.xiaomi.com/lp/s?k=lp_test');
    assert.equal(session.timeoutMs, 300000);
    assert.equal(session.qrTips, '可使用小米手机或平板扫码登录');
    assert.match(session.deviceId, /^[0-9a-zA-Z_-]{16}$/);
    assert.match(session.cookie, /deviceId=/);
    assert.match(session.cookie, /pass_o=/);
    assert.equal(requests.length, 2);
    assert.match(requests[0].cookie, /deviceId=/);
    assert.match(requests[1].cookie, /deviceId=/);

    const qrRequest = new URL(requests[1].url);
    assert.equal(qrRequest.searchParams.get('sid'), 'mijia');
    assert.equal(qrRequest.searchParams.get('_qrsize'), '240');
    assert.equal(qrRequest.searchParams.get('_hasLogo'), 'false');
    assert.equal(qrRequest.searchParams.get('_sign'), 'sign-value');
    assert.equal(qrRequest.searchParams.get('callback'), 'https://sts.api.mijia.tech/mijia/sts');
    assert.equal(qrRequest.searchParams.get('serviceParam'), '{"checkSafePhone":false}');
});

test('等待扫码成功：从长轮询结果提取 passToken/userId/cUserId', async () => {
    const requests: Array<{ url: string; cookie: string }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        requests.push({ url, cookie: new Headers(init?.headers).get('cookie') || '' });
        return new Response(`&&&START&&&${JSON.stringify({
            code: 0,
            result: 'ok',
            passToken: 'pass-token',
            userId: 123,
            cUserId: 'cuid',
            ssecurity: 'c2VjdXJpdHk=',
            location: 'https://sts.api.mijia.tech/mijia/sts',
        })}`, { status: 200 });
    }) as typeof fetch;

    const credentials = await completeQrLogin(sessionFixture(), { fetchImpl });

    assert.equal(credentials.userId, '123');
    assert.equal(credentials.passToken, 'pass-token');
    assert.equal(credentials.cUserId, 'cuid');
    assert.equal(credentials.deviceId, '0123456789abcdef');
    assert.equal(credentials.source, 'qr');
    assert.ok(credentials.savedAt > 0);
    assert.equal(requests[0].url, 'https://ak.lp.account.xiaomi.com/lp/s?k=lp_test');
    assert.match(requests[0].cookie, /deviceId=0123456789abcdef/);
});

test('长轮询未返回 passToken 时从 callback Cookie 提取', async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes('ak.lp.account.xiaomi.com')) {
            return new Response(`&&&START&&&${JSON.stringify({
                code: 0,
                result: 'ok',
                userId: 123,
                cUserId: 'cuid',
                location: 'https://sts.api.mijia.tech/mijia/sts?x=1',
            })}`, { status: 200 });
        }
        if (url.includes('sts.api.mijia.tech')) {
            return new Response(null, {
                status: 302,
                headers: [
                    ['location', 'https://sts.api.mijia.tech/done'],
                    ['set-cookie', 'passToken=cookie-token; Path=/'],
                    ['set-cookie', 'userId=123; Path=/'],
                    ['set-cookie', 'cUserId=cuid; Path=/'],
                ],
            });
        }
        if (url.includes('/done')) return new Response('ok', { status: 200 });
        throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;

    const credentials = await completeQrLogin(sessionFixture(), { fetchImpl });
    assert.equal(credentials.passToken, 'cookie-token');
    assert.equal(credentials.userId, '123');
    assert.equal(credentials.cUserId, 'cuid');
});

test('二维码过期 / 长轮询失败归类为 qr-expired', async () => {
    const expiredFetch = (async () => new Response(`&&&START&&&${JSON.stringify({
        code: 1,
        desc: '二维码已过期',
    })}`, { status: 200 })) as typeof fetch;

    await assert.rejects(
        completeQrLogin(sessionFixture(), { fetchImpl: expiredFetch }),
        (error: unknown) => error instanceof XiaomiCloudError
            && error.code === 'qr-expired'
            && /二维码已过期/.test(error.message)
    );

    const unauthorizedFetch = (async () => new Response('expired', { status: 401 })) as typeof fetch;
    await assert.rejects(
        completeQrLogin(sessionFixture(), { fetchImpl: unauthorizedFetch }),
        (error: unknown) => error instanceof XiaomiCloudError && error.code === 'qr-expired'
    );

    const timeoutFetch = (async () => {
        throw new XiaomiCloudError('network', '请求小米服务器超时：ak.lp.account.xiaomi.com');
    }) as typeof fetch;
    await assert.rejects(
        completeQrLogin(sessionFixture(), { fetchImpl: timeoutFetch }),
        (error: unknown) => error instanceof XiaomiCloudError && error.code === 'qr-expired'
    );
});

test('扫码成功但缺少 passToken/userId 时返回 api 错误', async () => {
    const fetchImpl = (async () => new Response(`&&&START&&&${JSON.stringify({
        code: 0,
        result: 'ok',
    })}`, { status: 200 })) as typeof fetch;

    await assert.rejects(
        completeQrLogin(sessionFixture(), { fetchImpl }),
        (error: unknown) => error instanceof XiaomiCloudError
            && error.code === 'api'
            && /passToken\/userId/.test(error.message)
    );
});

test('二维码初始化失败时给出可读错误', async () => {
    const fetchImpl = (async () => new Response(`&&&START&&&${JSON.stringify({
        code: 70016,
        result: 'error',
        desc: '登录验证失败',
    })}`, { status: 200 })) as typeof fetch;

    await assert.rejects(
        startQrLogin({ fetchImpl }),
        (error: unknown) => error instanceof XiaomiCloudError
            && error.code === 'api'
            && /二维码登录地址/.test(error.message)
    );
});
