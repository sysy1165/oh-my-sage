import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { saveStoredCredentials } from '../../src/core/cloud/credentialStore';
import {
    getCentralLinkPasscode,
    isAutoLoginConfigured,
    readCredentialsFromEnv,
    readDeviceDidFromEnv,
    resolveGatewayCandidates,
    XiaomiCloudError,
    type XiaomiCloudCredentials,
} from '../../src/core/cloud/passcode';

const NONEXISTENT_AUTH_FILE = path.join(os.tmpdir(), `oh-my-sage-auth-missing-${process.pid}.json`);
const CREDENTIALS: XiaomiCloudCredentials = { userId: '100', passToken: 'pass-token' };
const IO_SECURITY = Buffer.from('io-ssecurity-0123456789').toString('base64');
const MIJIA_SECURITY = Buffer.from('mijia-ssecurity-012345').toString('base64');
const DEVICE_LIST_DATA = '{"getVirtualModel":true,"getHuamiDevices":1,"get_split_device":false,"support_smart_home":true}';

/** 测试侧独立实现的 RC4，用来构造云端设备列表响应 */
function testRc4(key: Buffer, data: Buffer, skip = 1024): Buffer {
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
    for (let step = 0; step < skip + data.length; step++) {
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

function loginResponse(sid: string): Response {
    const security = sid === 'xiaomiio' ? IO_SECURITY : MIJIA_SECURITY;
    const location = sid === 'xiaomiio'
        ? 'https://sts.api.io.mi.com/pass/serviceLogin?sid=xiaomiio'
        : 'https://sts.api.mijia.tech/pass/serviceLogin?sid=mijia';
    return new Response(`&&&START&&&${JSON.stringify({
        result: 'ok',
        location,
        ssecurity: security,
        userId: 100,
        cUserId: 'cuid',
    })}`, { status: 200 });
}

function serviceTokenRedirect(host: string, token: string): Response {
    return new Response(null, {
        status: 302,
        headers: {
            location: `https://${host}/done`,
            'set-cookie': `serviceToken=${token}; Path=/`,
        },
    });
}

test('凭据解析：MIJIA_COOKIE 与单项环境变量', () => {
    assert.deepEqual(
        readCredentialsFromEnv({ MIJIA_COOKIE: 'userId=100; passToken=abc; cUserId=c; deviceId=d' }),
        { userId: '100', passToken: 'abc', cUserId: 'c', deviceId: 'd' }
    );
    assert.deepEqual(
        readCredentialsFromEnv({
            MIJIA_COOKIE: 'userId=100; passToken=abc',
            MIJIA_USER_ID: '200',
            MIJIA_PASS_TOKEN: 'override',
        }),
        { userId: '200', passToken: 'override' }
    );
    assert.equal(readCredentialsFromEnv({ MIJIA_USER_ID: '100' }), null);
    assert.equal(isAutoLoginConfigured({
        MIJIA_USER_ID: '100',
        MIJIA_PASS_TOKEN: 'x',
        MIJIA_AUTH_FILE: NONEXISTENT_AUTH_FILE,
    }), true);
    assert.equal(readDeviceDidFromEnv({ MIJIA_ROUTER_DID: ' 123 ' }), '123');
    assert.equal(readDeviceDidFromEnv({}), undefined);
});

test('设备优先级：先 localip 精确匹配，再在线中枢类设备', () => {
    const devices = [
        { did: '1', name: '客厅灯', model: 'light', isOnline: true },
        { did: '2', name: '中枢网关', model: 'xiaomi.gateway.hub1', localip: '192.168.0.5', isOnline: true },
        { did: '3', name: '路由器', model: 'xiaomi.router.r4', localip: '192.168.0.1', isOnline: true },
        { did: '4', name: '离线网关', model: 'xiaomi.gateway.hub1', isOnline: false },
    ];

    assert.deepEqual(resolveGatewayCandidates(devices, 'http://192.168.0.5'), ['2', '3']);
    assert.deepEqual(resolveGatewayCandidates(devices, 'https://mijia.example.com'), ['2', '3']);
    assert.deepEqual(resolveGatewayCandidates([devices[0]], 'http://192.168.0.5'), []);
});

test('完整自动取码：设备列表 → mijia 换票 → 签名取码', async () => {
    const requests: Array<{ url: string; method: string; body?: string; cookie: string }> = [];
    let passcodeCalls = 0;

    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        const parsed = new URL(url);
        const headers = new Headers(init?.headers);
        requests.push({
            url,
            method: init?.method || 'GET',
            body: typeof init?.body === 'string' ? init.body : undefined,
            cookie: headers.get('cookie') || '',
        });

        if (parsed.hostname === 'account.xiaomi.com') {
            return loginResponse(parsed.searchParams.get('sid') || 'mijia');
        }
        if (parsed.hostname === 'sts.api.io.mi.com') {
            return serviceTokenRedirect('sts.api.io.mi.com', 'io-token');
        }
        if (parsed.hostname === 'sts.api.mijia.tech') {
            return serviceTokenRedirect('sts.api.mijia.tech', 'mijia-token');
        }
        if (parsed.hostname === 'api.io.mi.com') {
            const params = new URLSearchParams(init?.body as string);
            const nonce = params.get('_nonce') || '';
            const security = params.get('ssecurity') || '';
            const key = createHash('sha256')
                .update(Buffer.concat([Buffer.from(security, 'base64'), Buffer.from(nonce, 'base64')]))
                .digest();

            // 逐项核对设备列表请求的签名参数（与米家脚本算法一致）
            const sn = createHash('sha256')
                .update(Buffer.concat([Buffer.from(security, 'base64'), Buffer.from(nonce, 'base64')]))
                .digest()
                .toString('base64');
            const data = params.get('data') || '';
            const hash = params.get('rc4_hash__') || '';
            const signature = params.get('signature') || '';
            const base64Sha1 = (input: string): string =>
                createHash('sha1').update(input).digest('base64');
            const expectedData = testRc4(key, Buffer.from(DEVICE_LIST_DATA)).toString('base64');
            const expectedHash = testRc4(
                key,
                Buffer.from(base64Sha1(`POST&/home/device_list&data=${DEVICE_LIST_DATA}&${sn}`))
            ).toString('base64');
            assert.equal(data, expectedData, '设备列表 data 应使用 RC4 加密');
            assert.equal(hash, expectedHash, '设备列表 rc4_hash__ 应使用 RC4 加密');
            assert.equal(
                signature,
                base64Sha1(`POST&/home/device_list&data=${data}&rc4_hash__=${hash}&${sn}`),
                '设备列表 signature 应与签名串一致'
            );

            const plain = JSON.stringify({
                code: 0,
                result: {
                    list: [{
                        did: 2,
                        name: '中枢网关',
                        model: 'xiaomi.gateway.hub1',
                        localip: '192.168.0.5',
                        isOnline: true,
                    }],
                },
            });
            return new Response(testRc4(key, Buffer.from(plain)).toString('base64'), { status: 200 });
        }
        if (parsed.hostname === 'core.api.mijia.tech') {
            passcodeCalls++;
            const params = new URLSearchParams(init?.body as string);
            const nonce = params.get('_nonce') || '';
            const data = params.get('data') || '';
            const signature = params.get('signature') || '';
            const sn = createHash('sha256')
                .update(Buffer.concat([Buffer.from(MIJIA_SECURITY, 'base64'), Buffer.from(nonce, 'base64')]))
                .digest()
                .toString('base64');
            const signStr = `/home/rpc/2&${sn}&${nonce}&data=${data}`;
            const expected = createHmac('sha256', Buffer.from(sn, 'base64'))
                .update(signStr)
                .digest('base64');
            assert.equal(signature, expected, '取码请求签名应与小米云算法一致');
            assert.match(headers.get('cookie') || '', /serviceToken=mijia-token/);
            return new Response(JSON.stringify({ result: { passcode: '654321' } }), { status: 200 });
        }
        throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;

    const result = await getCentralLinkPasscode({
        gatewayUrl: 'http://192.168.0.5',
        credentials: CREDENTIALS,
        fetchImpl,
    });

    assert.deepEqual(result, { passcode: '654321', deviceDid: '2', userId: '100' });
    assert.equal(passcodeCalls, 1);
    const deviceList = requests.find((request) => request.url.includes('/app/home/device_list'));
    assert.ok(deviceList);
    assert.equal(deviceList.method, 'POST');
    assert.match(deviceList.body || '', /(?:^|&)ssecurity=/);
});

test('取码返回 auth/signature 错误时重新换票并重试一次', async () => {
    let mintCalls = 0;
    let passcodeCalls = 0;

    const fetchImpl = (async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.startsWith('https://account.xiaomi.com')) {
            mintCalls++;
            return loginResponse('mijia');
        }
        if (url.startsWith('https://sts.api.mijia.tech')) {
            return serviceTokenRedirect('sts.api.mijia.tech', `mijia-token-${mintCalls}`);
        }
        if (url.startsWith('https://core.api.mijia.tech')) {
            passcodeCalls++;
            if (passcodeCalls === 1) {
                return new Response(JSON.stringify({ message: 'signature error' }), { status: 200 });
            }
            return new Response(JSON.stringify({ result: { passcode: '123456' } }), { status: 200 });
        }
        throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;

    const result = await getCentralLinkPasscode({
        credentials: CREDENTIALS,
        deviceDid: '2',
        fetchImpl,
    });

    assert.equal(result.passcode, '123456');
    assert.equal(mintCalls, 2);
    assert.equal(passcodeCalls, 2);
});

test('MIJIA_ROUTER_DID 可直接指定设备并跳过设备列表', async () => {
    let deviceListCalled = false;

    const fetchImpl = (async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.startsWith('https://account.xiaomi.com')) return loginResponse('mijia');
        if (url.startsWith('https://sts.api.mijia.tech')) {
            return serviceTokenRedirect('sts.api.mijia.tech', 'mijia-token');
        }
        if (url.includes('api.io.mi.com')) {
            deviceListCalled = true;
            throw new Error('不应请求设备列表');
        }
        if (url.startsWith('https://core.api.mijia.tech')) {
            return new Response(JSON.stringify({ result: { passcode: '111111' } }), { status: 200 });
        }
        throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;

    const result = await getCentralLinkPasscode({
        env: {
            MIJIA_USER_ID: '100',
            MIJIA_PASS_TOKEN: 'pass',
            MIJIA_ROUTER_DID: '999',
            MIJIA_AUTH_FILE: NONEXISTENT_AUTH_FILE,
        },
        gatewayUrl: 'http://192.168.0.5',
        fetchImpl,
    });

    assert.equal(result.passcode, '111111');
    assert.equal(result.deviceDid, '999');
    assert.equal(deviceListCalled, false);
});

test('设备列表返回明文鉴权错误时归类为 auth-expired', async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.startsWith('https://account.xiaomi.com')) return loginResponse('xiaomiio');
        if (url.startsWith('https://sts.api.io.mi.com')) {
            return serviceTokenRedirect('sts.api.io.mi.com', 'io-token');
        }
        if (url.includes('api.io.mi.com')) {
            return new Response(JSON.stringify({ code: 401, message: 'auth failed' }), { status: 200 });
        }
        throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;

    await assert.rejects(
        getCentralLinkPasscode({
            credentials: CREDENTIALS,
            gatewayUrl: 'http://192.168.0.5',
            fetchImpl,
        }),
        (error: unknown) => error instanceof XiaomiCloudError && error.code === 'auth-expired'
    );
});

test('登录态明确被拒 → auth-expired；5xx/非 JSON → network', async () => {
    const verifyFetch = (async () =>
        new Response('&&&START&&&{"result":"verify"}', { status: 200 })) as typeof fetch;
    await assert.rejects(
        getCentralLinkPasscode({ credentials: CREDENTIALS, deviceDid: '2', fetchImpl: verifyFetch }),
        (error: unknown) => error instanceof XiaomiCloudError && error.code === 'auth-expired'
    );

    const badGatewayFetch = (async () =>
        new Response('<html>bad gateway</html>', { status: 502 })) as typeof fetch;
    await assert.rejects(
        getCentralLinkPasscode({ credentials: CREDENTIALS, deviceDid: '2', fetchImpl: badGatewayFetch }),
        (error: unknown) => error instanceof XiaomiCloudError && error.code === 'network'
    );
});

test('自动取码优先使用本机保存的扫码登录态', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-my-sage-passcode-'));
    const authFile = path.join(dir, 'mijia-auth.json');
    saveStoredCredentials({
        userId: '100',
        passToken: 'stored-token',
        cUserId: 'cuid',
        deviceId: 'device',
        source: 'qr',
        savedAt: Date.now(),
    }, { MIJIA_AUTH_FILE: authFile });

    const seenCookies: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        const cookie = new Headers(init?.headers).get('cookie') || '';
        seenCookies.push(cookie);
        if (url.includes('account.xiaomi.com')) {
            return new Response(`&&&START&&&${JSON.stringify({
                result: 'ok',
                location: 'https://sts.api.mijia.tech/pass/serviceLogin?sid=mijia',
                ssecurity: MIJIA_SECURITY,
                userId: 100,
                cUserId: 'cuid',
            })}`, { status: 200 });
        }
        if (url.startsWith('https://sts.api.mijia.tech')) {
            return serviceTokenRedirect('sts.api.mijia.tech', 'stored-service-token');
        }
        if (url.startsWith('https://core.api.mijia.tech')) {
            return new Response(JSON.stringify({ result: { passcode: '222222' } }), { status: 200 });
        }
        throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;

    try {
        const result = await getCentralLinkPasscode({
            env: { MIJIA_AUTH_FILE: authFile, MIJIA_ROUTER_DID: '999' },
            fetchImpl,
        });

        assert.equal(result.passcode, '222222');
        assert.equal(result.deviceDid, '999');
        assert.match(seenCookies[0], /passToken=stored-token/);
        assert.match(seenCookies[0], /deviceId=device/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('未配置凭据时返回 not-configured，且不会发起网络请求', async () => {
    let called = false;
    const fetchImpl = (async () => {
        called = true;
        return new Response('{}');
    }) as typeof fetch;

    await assert.rejects(
        getCentralLinkPasscode({ env: { MIJIA_AUTH_FILE: NONEXISTENT_AUTH_FILE }, fetchImpl }),
        (error: unknown) => error instanceof XiaomiCloudError && error.code === 'not-configured'
    );
    assert.equal(called, false);
});

test('测试侧 RC4 与标准向量一致（保证设备列表夹具可信）', () => {
    assert.equal(
        testRc4(Buffer.from('Key'), Buffer.from('Plaintext'), 0).toString('hex'),
        'bbf316e8d940af0ad3'
    );
});
