import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
    clearStoredCredentials,
    credentialSource,
    hasAutoLoginCredentials,
    readStoredCredentials,
    resolveCredentials,
    saveStoredCredentials,
} from '../../src/core/cloud/credentialStore';

function tempEnv() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-my-sage-auth-'));
    return { dir, env: { MIJIA_AUTH_FILE: path.join(dir, 'mijia-auth.json') } };
}

test('扫码登录态保存、读取、清除与权限', () => {
    const { dir, env } = tempEnv();
    try {
        const savedAt = 1700000000000;
        saveStoredCredentials({
            userId: '100',
            passToken: 'pass-token',
            cUserId: 'cuid',
            deviceId: 'device',
            source: 'qr',
            savedAt,
            expireTime: savedAt + 30 * 24 * 3600 * 1000,
        }, env);

        const stored = readStoredCredentials(env);
        assert.deepEqual(stored, {
            userId: '100',
            passToken: 'pass-token',
            cUserId: 'cuid',
            deviceId: 'device',
            source: 'qr',
            savedAt,
            expireTime: savedAt + 30 * 24 * 3600 * 1000,
        });

        if (process.platform !== 'win32') {
            assert.equal(fs.statSync(env.MIJIA_AUTH_FILE).mode & 0o777, 0o600);
        }

        clearStoredCredentials(env);
        assert.equal(readStoredCredentials(env), null);
        assert.equal(fs.existsSync(env.MIJIA_AUTH_FILE), false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('凭据优先级：扫码登录态 > 环境变量；清除后回退环境变量', () => {
    const { dir, env } = tempEnv();
    try {
        const envWithFallback = {
            ...env,
            MIJIA_USER_ID: '200',
            MIJIA_PASS_TOKEN: 'env-token',
        };

        assert.deepEqual(resolveCredentials(envWithFallback), {
            userId: '200',
            passToken: 'env-token',
        });
        assert.equal(credentialSource(envWithFallback), 'env');

        saveStoredCredentials({
            userId: '100',
            passToken: 'stored-token',
            cUserId: 'cuid',
            source: 'qr',
            savedAt: Date.now(),
        }, env);

        assert.deepEqual(resolveCredentials(envWithFallback), {
            userId: '100',
            passToken: 'stored-token',
            cUserId: 'cuid',
            source: 'qr',
            savedAt: readStoredCredentials(env)!.savedAt,
        });
        assert.equal(credentialSource(envWithFallback), 'stored');
        assert.equal(hasAutoLoginCredentials(envWithFallback), true);

        clearStoredCredentials(env);
        assert.equal(resolveCredentials(envWithFallback)?.userId, '200');
        assert.equal(credentialSource(envWithFallback), 'env');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('损坏的登录态文件不会影响环境变量回退', () => {
    const { dir, env } = tempEnv();
    try {
        fs.writeFileSync(env.MIJIA_AUTH_FILE, 'not-json', 'utf8');
        assert.equal(readStoredCredentials(env), null);

        const envWithFallback = {
            ...env,
            MIJIA_USER_ID: '200',
            MIJIA_PASS_TOKEN: 'env-token',
        };
        assert.equal(resolveCredentials(envWithFallback)?.passToken, 'env-token');
        assert.equal(hasAutoLoginCredentials(envWithFallback), true);
        assert.equal(hasAutoLoginCredentials(env), false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
