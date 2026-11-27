import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import Database from 'better-sqlite3';
import express from 'express';
import db from '../lib/database.js';
import {
    getDefaultBackupDir,
    isValidBackupFilename,
    resolveBackupFilePath,
    createDatabaseBackup,
    exportCompressedBackup,
    listDatabaseBackups,
    deleteDatabaseBackup,
    startScheduledBackups,
    stopScheduledBackups
} from '../lib/backupService.js';
import {
    createRateLimiter,
    resetAllRateLimiters,
    authRateLimiter,
    apiRateLimiter
} from '../lib/middleware/rateLimiter.js';

const SQLITE_MAGIC_HEADER = 'SQLite format 3\0';

describe('Automated SQLite Database Backups (lib/backupService.js)', () => {
    let tempDir;
    const originalBackupDir = process.env.BACKUP_DIR;
    const probeKey = 'backup_service_test_probe';

    beforeEach(() => {
        stopScheduledBackups();
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sugoibot-backup-test-'));
        process.env.BACKUP_DIR = tempDir;
        db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(probeKey, 'snapshot-ok');
    });

    afterEach(() => {
        stopScheduledBackups();
        vi.useRealTimers();
        db.prepare('DELETE FROM settings WHERE key = ?').run(probeKey);

        if (originalBackupDir === undefined) {
            delete process.env.BACKUP_DIR;
        } else {
            process.env.BACKUP_DIR = originalBackupDir;
        }

        if (tempDir && fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('creates a compressed .sqlite.gz snapshot, cleans temp files, and restores a valid SQLite database', async () => {
        const snapshot = await createDatabaseBackup({ backupDir: tempDir });

        expect(snapshot.filename).toMatch(/^sugoibot-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.sqlite\.gz$/);
        expect(isValidBackupFilename(snapshot.filename)).toBe(true);
        expect(snapshot.filePath).toBe(path.join(tempDir, snapshot.filename));
        expect(snapshot.sizeBytes).toBeGreaterThan(0);
        expect(Number.isNaN(Date.parse(snapshot.createdAt))).toBe(false);
        expect(fs.existsSync(snapshot.filePath)).toBe(true);

        const dirFiles = fs.readdirSync(tempDir);
        expect(dirFiles).toEqual([snapshot.filename]);

        const compressed = fs.readFileSync(snapshot.filePath);
        const decompressed = gunzipSync(compressed);
        expect(decompressed.subarray(0, 16).toString('utf8')).toBe(SQLITE_MAGIC_HEADER);

        const restoredPath = path.join(tempDir, 'restored-verify.sqlite');
        fs.writeFileSync(restoredPath, decompressed);
        const restoredDb = new Database(restoredPath, { readonly: true });
        try {
            const tables = restoredDb
                .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
                .all()
                .map(r => r.name);
            expect(tables).toEqual(expect.arrayContaining(['settings', 'guild_settings', 'xp', 'audit_logs']));

            const row = restoredDb.prepare('SELECT value FROM settings WHERE key = ?').get(probeKey);
            expect(row).toEqual({ value: 'snapshot-ok' });
        } finally {
            restoredDb.close();
        }
    });

    it('lists backups newest-first and prunes oldest snapshots beyond maxBackups', async () => {
        fs.writeFileSync(path.join(tempDir, 'keep-notes.txt'), 'not a backup');

        const created = [];
        for (let i = 0; i < 5; i++) {
            created.push(await createDatabaseBackup({ backupDir: tempDir, maxBackups: 3 }));
        }

        const listed = listDatabaseBackups({ backupDir: tempDir });
        expect(listed).toHaveLength(3);
        expect(listed.map(b => b.filename)).toEqual([
            created[4].filename,
            created[3].filename,
            created[2].filename
        ]);

        expect(fs.existsSync(created[0].filePath)).toBe(false);
        expect(fs.existsSync(created[1].filePath)).toBe(false);
        expect(fs.existsSync(path.join(tempDir, 'keep-notes.txt'))).toBe(true);
    });

    it('strictly rejects path traversal and invalid filenames in validation, resolution, and deletion', async () => {
        const valid = await createDatabaseBackup({ backupDir: tempDir });
        const outsideSecret = path.join(path.dirname(tempDir), `sugoibot-backup-secret-${Date.now()}.sqlite.gz`);
        fs.writeFileSync(outsideSecret, 'sensitive');

        try {
            const maliciousInputs = [
                '',
                null,
                undefined,
                '../database.sqlite',
                '..\\database.sqlite',
                `../${path.basename(outsideSecret)}`,
                `..\\${path.basename(outsideSecret)}`,
                'sugoibot-backup-../../etc/passwd.sqlite.gz',
                'sugoibot-backup-..evil.sqlite.gz',
                'nested/sugoibot-backup-2026-01-01T00-00-00-000Z.sqlite.gz',
                'nested\\sugoibot-backup-2026-01-01T00-00-00-000Z.sqlite.gz',
                'other-prefix-2026-01-01T00-00-00-000Z.sqlite.gz',
                'sugoibot-backup-2026-01-01T00-00-00-000Z.sqlite',
                'sugoibot-backup-2026-01-01T00-00-00-000Z.sqlite.gz\0.txt'
            ];

            for (const badName of maliciousInputs) {
                expect(isValidBackupFilename(badName)).toBe(false);
                expect(resolveBackupFilePath(badName, { backupDir: tempDir })).toBeNull();
                expect(deleteDatabaseBackup(badName, { backupDir: tempDir })).toBe(false);
            }

            expect(fs.existsSync(outsideSecret)).toBe(true);

            const missingValid = 'sugoibot-backup-1999-01-01T00-00-00-000Z.sqlite.gz';
            expect(isValidBackupFilename(missingValid)).toBe(true);
            expect(resolveBackupFilePath(missingValid, { backupDir: tempDir })).toBeNull();
            expect(deleteDatabaseBackup(missingValid, { backupDir: tempDir })).toBe(false);

            expect(resolveBackupFilePath(valid.filename, { backupDir: tempDir })).toBe(valid.filePath);
            expect(deleteDatabaseBackup(valid.filename, { backupDir: tempDir })).toBe(true);
            expect(fs.existsSync(valid.filePath)).toBe(false);
            expect(deleteDatabaseBackup(valid.filename, { backupDir: tempDir })).toBe(false);
        } finally {
            if (fs.existsSync(outsideSecret)) {
                fs.unlinkSync(outsideSecret);
            }
        }
    });

    it('exports an in-memory compressed SQLite backup buffer and cleans up os.tmpdir() artifacts', async () => {
        const exported = await exportCompressedBackup({ prefix: 'sugoibot-backup' });

        expect(isValidBackupFilename(exported.filename)).toBe(true);
        expect(Buffer.isBuffer(exported.buffer)).toBe(true);
        expect(exported.sizeBytes).toBe(exported.buffer.length);
        expect(exported.sizeBytes).toBeGreaterThan(0);

        const sqliteBytes = gunzipSync(exported.buffer);
        expect(sqliteBytes.subarray(0, 16).toString('utf8')).toBe(SQLITE_MAGIC_HEADER);

        const verifyPath = path.join(tempDir, 'exported-verify.sqlite');
        fs.writeFileSync(verifyPath, sqliteBytes);
        const verifyDb = new Database(verifyPath, { readonly: true });
        try {
            const row = verifyDb.prepare('SELECT value FROM settings WHERE key = ?').get(probeKey);
            expect(row).toEqual({ value: 'snapshot-ok' });
        } finally {
            verifyDb.close();
        }
    });

    it('schedules periodic backups with unref timer and stops cleanly', async () => {
        expect(getDefaultBackupDir()).toBe(tempDir);

        const timer = startScheduledBackups({
            intervalMs: 45,
            maxBackups: 2,
            backupDir: tempDir,
            runOnStart: true
        });
        expect(timer).toBeTruthy();

        await new Promise(resolve => setTimeout(resolve, 130));
        expect(stopScheduledBackups()).toBe(true);
        expect(stopScheduledBackups()).toBe(false);

        // Allow any in-flight async db.backup() started before stopScheduledBackups() to settle
        await new Promise(resolve => setTimeout(resolve, 50));

        const backupsAfterStop = listDatabaseBackups({ backupDir: tempDir });
        expect(backupsAfterStop.length).toBeGreaterThanOrEqual(1);
        expect(backupsAfterStop.length).toBeLessThanOrEqual(2);

        const countAtStop = backupsAfterStop.length;
        await new Promise(resolve => setTimeout(resolve, 110));
        expect(listDatabaseBackups({ backupDir: tempDir }).length).toBe(countAtStop);
    });
});

describe('API Rate Limiting Middleware (lib/middleware/rateLimiter.js)', () => {
    beforeEach(() => {
        resetAllRateLimiters();
    });

    afterEach(() => {
        vi.useRealTimers();
        resetAllRateLimiters();
    });

    function createMockRes() {
        const headers = new Map();
        const res = {
            statusCode: 200,
            body: null,
            headers,
            setHeader(name, val) {
                headers.set(name.toLowerCase(), String(val));
            },
            getHeader(name) {
                return headers.get(name.toLowerCase());
            },
            status(code) {
                this.statusCode = code;
                return this;
            },
            json(payload) {
                this.body = payload;
                return this;
            }
        };
        return res;
    }

    it('sets RateLimit-* headers and blocks excess requests with 429 and Retry-After over Express HTTP', async () => {
        const app = express();
        const limiter = createRateLimiter({
            windowMs: 60_000,
            max: 2,
            message: 'Slow down test client.'
        });
        app.use('/limited', limiter);
        app.get('/limited/ping', (_req, res) => res.json({ ok: true }));

        const server = await new Promise(resolve => {
            const s = app.listen(0, '127.0.0.1', () => resolve(s));
        });

        try {
            const { port } = server.address();
            const url = `http://127.0.0.1:${port}/limited/ping`;

            const r1 = await fetch(url, { headers: { 'x-forwarded-for': '203.0.113.10, 10.0.0.1' } });
            expect(r1.status).toBe(200);
            expect(r1.headers.get('ratelimit-limit')).toBe('2');
            expect(r1.headers.get('ratelimit-remaining')).toBe('1');
            expect(Number(r1.headers.get('ratelimit-reset'))).toBeGreaterThan(0);

            const r2 = await fetch(url, { headers: { 'x-forwarded-for': '203.0.113.10' } });
            expect(r2.status).toBe(200);
            expect(r2.headers.get('ratelimit-remaining')).toBe('0');

            const r3 = await fetch(url, { headers: { 'x-forwarded-for': '203.0.113.10' } });
            expect(r3.status).toBe(429);
            expect(r3.headers.get('ratelimit-limit')).toBe('2');
            expect(r3.headers.get('ratelimit-remaining')).toBe('0');
            const retryAfterHeader = Number(r3.headers.get('retry-after'));
            expect(retryAfterHeader).toBeGreaterThan(0);
            const body3 = await r3.json();
            expect(body3).toEqual({
                error: 'Slow down test client.',
                retryAfter: retryAfterHeader
            });

            // Isolated IP continues to succeed
            const rOtherIp = await fetch(url, { headers: { 'x-forwarded-for': '198.51.100.77' } });
            expect(rOtherIp.status).toBe(200);
            expect(rOtherIp.headers.get('ratelimit-remaining')).toBe('1');
        } finally {
            await new Promise(resolve => server.close(resolve));
        }
    });

    it('supports window expiry, skip predicate, .reset(), and resetAllRateLimiters()', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-11-27T12:00:00.000Z'));

        const limiter = createRateLimiter({
            windowMs: 10_000,
            max: 1,
            skip: req => req.skipLimit === true
        });

        // Skipped request neither increments count nor sets headers
        const skippedRes = createMockRes();
        let nextCalled = 0;
        limiter({ ip: '10.0.0.5', headers: {}, skipLimit: true }, skippedRes, () => { nextCalled++; });
        expect(nextCalled).toBe(1);
        expect(skippedRes.headers.size).toBe(0);

        // First non-skipped request succeeds
        const res1 = createMockRes();
        limiter({ ip: '10.0.0.5', headers: {} }, res1, () => { nextCalled++; });
        expect(nextCalled).toBe(2);
        expect(res1.getHeader('ratelimit-remaining')).toBe('0');
        expect(res1.getHeader('ratelimit-reset')).toBe('10');

        // Second request within window hits 429
        vi.advanceTimersByTime(3_000);
        const res2 = createMockRes();
        limiter({ ip: '10.0.0.5', headers: {} }, res2, () => { nextCalled++; });
        expect(res2.statusCode).toBe(429);
        expect(res2.getHeader('retry-after')).toBe('7');
        expect(res2.body).toEqual({
            error: 'Too many requests, please try again later.',
            retryAfter: 7
        });

        // Advance past window expiry -> quota resets
        vi.advanceTimersByTime(7_001);
        const res3 = createMockRes();
        limiter({ ip: '10.0.0.5', headers: {} }, res3, () => { nextCalled++; });
        expect(res3.statusCode).toBe(200);
        expect(nextCalled).toBe(3);

        // Exhaust preconfigured limiters & custom limiter, then verify resetAllRateLimiters() clears all
        const res4 = createMockRes();
        limiter({ ip: '10.0.0.5', headers: {} }, res4, () => {});
        expect(res4.statusCode).toBe(429);

        for (let i = 0; i < 31; i++) {
            authRateLimiter({ ip: '10.0.0.9', headers: {} }, createMockRes(), () => {});
        }
        const blockedAuth = createMockRes();
        authRateLimiter({ ip: '10.0.0.9', headers: {} }, blockedAuth, () => {});
        expect(blockedAuth.statusCode).toBe(429);

        resetAllRateLimiters();

        const afterResetCustom = createMockRes();
        limiter({ ip: '10.0.0.5', headers: {} }, afterResetCustom, () => { nextCalled++; });
        expect(afterResetCustom.statusCode).toBe(200);

        const afterResetAuth = createMockRes();
        let authNext = false;
        authRateLimiter({ ip: '10.0.0.9', headers: {} }, afterResetAuth, () => { authNext = true; });
        expect(authNext).toBe(true);
        expect(afterResetAuth.statusCode).toBe(200);

        const apiRes = createMockRes();
        let apiNext = false;
        apiRateLimiter({ socket: { remoteAddress: '127.0.0.1' }, headers: {} }, apiRes, () => { apiNext = true; });
        expect(apiNext).toBe(true);
        expect(apiRes.getHeader('ratelimit-limit')).toBe('300');
    });
});
