import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import db from './database.js';
import { logger } from './bot/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BACKUP_FILENAME_REGEX = /^sugoibot-backup-[A-Za-z0-9._-]+\.sqlite\.gz$/;
const DEFAULT_MAX_BACKUPS = 14;
const DEFAULT_BACKUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

let lastBackupTimestampMs = 0;
let scheduledBackupTimer = null;
let scheduledBackupRunning = false;

function nextBackupDate() {
    const now = Date.now();
    lastBackupTimestampMs = now > lastBackupTimestampMs ? now : lastBackupTimestampMs + 1;
    return new Date(lastBackupTimestampMs);
}

function sanitizePrefix(prefix) {
    const cleaned = String(prefix || 'sugoibot-backup').replace(/[^A-Za-z0-9_-]/g, '');
    return cleaned || 'sugoibot-backup';
}

function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cleanupTempSqliteFiles(baseTempPath) {
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
        const candidate = `${baseTempPath}${suffix}`;
        try {
            if (fs.existsSync(candidate)) {
                fs.unlinkSync(candidate);
            }
        } catch {
            // Ignore best-effort cleanup errors
        }
    }
}

export function getDefaultBackupDir() {
    return process.env.BACKUP_DIR || path.join(process.env.DATA_DIR || path.resolve(__dirname, '..', 'data'), 'backups');
}

export function isValidBackupFilename(filename) {
    if (typeof filename !== 'string' || filename.length === 0) {
        return false;
    }
    if (
        filename.includes('..') ||
        filename.includes('/') ||
        filename.includes('\\') ||
        filename.includes('\0') ||
        path.basename(filename) !== filename
    ) {
        return false;
    }
    return BACKUP_FILENAME_REGEX.test(filename);
}

export function resolveBackupFilePath(filename, { backupDir } = {}) {
    if (!isValidBackupFilename(filename)) {
        return null;
    }
    const targetDir = backupDir || getDefaultBackupDir();
    const resolvedDir = path.resolve(targetDir);
    const resolvedFile = path.resolve(resolvedDir, filename);

    if (path.dirname(resolvedFile) !== resolvedDir) {
        return null;
    }

    try {
        const stat = fs.statSync(resolvedFile);
        if (!stat.isFile()) {
            return null;
        }
        return resolvedFile;
    } catch {
        return null;
    }
}

export async function createDatabaseBackup({ backupDir, maxBackups, prefix = 'sugoibot-backup' } = {}) {
    const targetDir = backupDir || getDefaultBackupDir();
    fs.mkdirSync(targetDir, { recursive: true });

    const cleanPrefix = sanitizePrefix(prefix);
    const nowDate = nextBackupDate();
    const createdAt = nowDate.toISOString();
    const timestampSlug = createdAt.replace(/[:.]/g, '-');
    const filename = `${cleanPrefix}-${timestampSlug}.sqlite.gz`;
    const filePath = path.join(targetDir, filename);

    const uniqueToken = `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const tempSqlitePath = path.join(targetDir, `.tmp-${cleanPrefix}-${uniqueToken}.sqlite`);
    const tempGzPath = path.join(targetDir, `.tmp-${cleanPrefix}-${uniqueToken}.sqlite.gz`);

    let compressedBuffer;
    try {
        await db.backup(tempSqlitePath);
        const rawSqlite = fs.readFileSync(tempSqlitePath);
        compressedBuffer = gzipSync(rawSqlite);

        fs.writeFileSync(tempGzPath, compressedBuffer);
        try {
            fs.utimesSync(tempGzPath, nowDate, nowDate);
        } catch {
            // Ignore utimes errors on filesystems without mtime override support
        }
        fs.renameSync(tempGzPath, filePath);
    } finally {
        cleanupTempSqliteFiles(tempSqlitePath);
        try {
            if (fs.existsSync(tempGzPath)) {
                fs.unlinkSync(tempGzPath);
            }
        } catch {
            // Ignore best-effort cleanup errors
        }
    }

    const configuredMax = maxBackups !== undefined
        ? Number(maxBackups)
        : (Number(process.env.BACKUP_MAX_COUNT) || DEFAULT_MAX_BACKUPS);
    const retentionLimit = Number.isFinite(configuredMax) && configuredMax > 0
        ? Math.floor(configuredMax)
        : DEFAULT_MAX_BACKUPS;

    const prefixMatcher = new RegExp(`^${escapeRegExp(cleanPrefix)}-[A-Za-z0-9._-]+\\.sqlite\\.gz$`);
    const matchingFiles = [];

    for (const entry of fs.readdirSync(targetDir)) {
        if (entry.includes('..') || !prefixMatcher.test(entry)) {
            continue;
        }
        const entryPath = path.join(targetDir, entry);
        try {
            const stat = fs.statSync(entryPath);
            if (stat.isFile()) {
                matchingFiles.push({
                    filename: entry,
                    filePath: entryPath,
                    mtimeMs: stat.mtimeMs
                });
            }
        } catch {
            // Skip unreadable or concurrently removed files
        }
    }

    matchingFiles.sort((a, b) => (b.mtimeMs - a.mtimeMs) || b.filename.localeCompare(a.filename));

    for (const stale of matchingFiles.slice(retentionLimit)) {
        try {
            fs.unlinkSync(stale.filePath);
        } catch {
            // Ignore concurrent deletion errors
        }
    }

    return {
        filename,
        filePath,
        sizeBytes: compressedBuffer.length,
        createdAt
    };
}

export async function exportCompressedBackup({ prefix = 'sugoibot-backup' } = {}) {
    const cleanPrefix = sanitizePrefix(prefix);
    const nowDate = nextBackupDate();
    const createdAt = nowDate.toISOString();
    const timestampSlug = createdAt.replace(/[:.]/g, '-');
    const filename = `${cleanPrefix}-${timestampSlug}.sqlite.gz`;

    const uniqueToken = `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const tempSqlitePath = path.join(os.tmpdir(), `.tmp-${cleanPrefix}-${uniqueToken}.sqlite`);

    try {
        await db.backup(tempSqlitePath);
        const rawSqlite = fs.readFileSync(tempSqlitePath);
        const buffer = gzipSync(rawSqlite);

        return {
            filename,
            buffer,
            sizeBytes: buffer.length,
            createdAt
        };
    } finally {
        cleanupTempSqliteFiles(tempSqlitePath);
    }
}

export function listDatabaseBackups({ backupDir } = {}) {
    const targetDir = backupDir || getDefaultBackupDir();
    if (!fs.existsSync(targetDir)) {
        return [];
    }

    const entries = [];
    for (const name of fs.readdirSync(targetDir)) {
        if (!isValidBackupFilename(name)) {
            continue;
        }
        const fullPath = path.join(targetDir, name);
        try {
            const stat = fs.statSync(fullPath);
            if (stat.isFile()) {
                entries.push({
                    filename: name,
                    sizeBytes: stat.size,
                    createdAt: stat.mtime.toISOString(),
                    _mtimeMs: stat.mtimeMs
                });
            }
        } catch {
            // Skip files removed concurrently
        }
    }

    entries.sort((a, b) => (b._mtimeMs - a._mtimeMs) || b.filename.localeCompare(a.filename));

    return entries.map(({ filename, sizeBytes, createdAt }) => ({
        filename,
        sizeBytes,
        createdAt
    }));
}

export function deleteDatabaseBackup(filename, { backupDir } = {}) {
    const resolvedPath = resolveBackupFilePath(filename, { backupDir });
    if (!resolvedPath) {
        return false;
    }

    try {
        fs.unlinkSync(resolvedPath);
        return true;
    } catch {
        return false;
    }
}

export function stopScheduledBackups() {
    if (scheduledBackupTimer) {
        clearInterval(scheduledBackupTimer);
        scheduledBackupTimer = null;
        return true;
    }
    return false;
}

export function startScheduledBackups({ intervalMs, maxBackups, backupDir, runOnStart = false } = {}) {
    stopScheduledBackups();

    const parsedInterval = intervalMs !== undefined
        ? Number(intervalMs)
        : (Number(process.env.BACKUP_INTERVAL_MS) || DEFAULT_BACKUP_INTERVAL_MS);
    const effectiveIntervalMs = Number.isFinite(parsedInterval) && parsedInterval > 0
        ? parsedInterval
        : DEFAULT_BACKUP_INTERVAL_MS;

    const executeBackup = async () => {
        if (scheduledBackupRunning) {
            return;
        }
        scheduledBackupRunning = true;
        try {
            const snapshot = await createDatabaseBackup({ backupDir, maxBackups });
            logger.info(`Created scheduled SQLite backup: ${snapshot.filename} (${snapshot.sizeBytes} bytes)`);
        } catch (err) {
            logger.error('Failed to create scheduled SQLite backup:', err);
        } finally {
            scheduledBackupRunning = false;
        }
    };

    if (runOnStart) {
        void executeBackup();
    }

    scheduledBackupTimer = setInterval(() => {
        void executeBackup();
    }, effectiveIntervalMs);

    if (typeof scheduledBackupTimer.unref === 'function') {
        scheduledBackupTimer.unref();
    }

    return scheduledBackupTimer;
}
