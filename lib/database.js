import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || path.resolve(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(path.join(dataDir, 'database.sqlite'));

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  
  CREATE TABLE IF NOT EXISTS users (
    userId TEXT PRIMARY KEY
  );

  CREATE TABLE IF NOT EXISTS xp (
    guildId TEXT,
    userId TEXT,
    xp INTEGER DEFAULT 0,
    level INTEGER DEFAULT 1,
    PRIMARY KEY(guildId, userId)
  );

  CREATE TABLE IF NOT EXISTS warnings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId TEXT,
    guildId TEXT,
    reason TEXT,
    moderatorId TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS currency (
    userId TEXT PRIMARY KEY,
    balance INTEGER DEFAULT 0,
    lastDaily INTEGER DEFAULT 0,
    lastWork INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS guild_settings (
    guildId TEXT,
    key TEXT,
    value TEXT,
    PRIMARY KEY(guildId, key)
  );

  CREATE TABLE IF NOT EXISTS gamerole_whitelist (
    guildId TEXT,
    gameName TEXT,
    roleName TEXT,
    PRIMARY KEY(guildId, gameName)
  );

  CREATE TABLE IF NOT EXISTS voice_guilds (
    guildId TEXT PRIMARY KEY,
    hubChannelId TEXT,
    categoryId TEXT
  );

  CREATE TABLE IF NOT EXISTS voice_hubs (
    hubChannelId TEXT PRIMARY KEY,
    guildId TEXT,
    categoryId TEXT
  );

  INSERT OR IGNORE INTO voice_hubs (hubChannelId, guildId, categoryId)
  SELECT hubChannelId, guildId, categoryId FROM voice_guilds WHERE hubChannelId IS NOT NULL;

  CREATE TABLE IF NOT EXISTS voice_channels (
    channelId TEXT PRIMARY KEY,
    guildId TEXT,
    ownerId TEXT,
    createdAt INTEGER
  );

  CREATE TABLE IF NOT EXISTS voice_user_settings (
    userId TEXT PRIMARY KEY,
    customName TEXT,
    customLimit INTEGER,
    updatedAt INTEGER
  );

  CREATE TABLE IF NOT EXISTS voicemaster_guilds (
    guildId TEXT PRIMARY KEY,
    hubChannelId TEXT,
    categoryId TEXT,
    interfaceChannelId TEXT
  );

  CREATE TABLE IF NOT EXISTS voicemaster_channels (
    channelId TEXT PRIMARY KEY,
    guildId TEXT,
    ownerId TEXT,
    createdAt INTEGER
  );
`);

// Migration: Ensure xp table has guildId in primary key
try {
    const xpTableInfo = db.prepare("PRAGMA table_info(xp)").all();
    const hasGuildId = xpTableInfo.some(col => col.name === 'guildId');
    if (!hasGuildId && xpTableInfo.length > 0) {
        db.exec(`
            ALTER TABLE xp RENAME TO old_xp;
            CREATE TABLE IF NOT EXISTS xp (
                guildId TEXT,
                userId TEXT,
                xp INTEGER DEFAULT 0,
                level INTEGER DEFAULT 1,
                PRIMARY KEY(guildId, userId)
            );
            INSERT OR IGNORE INTO xp (guildId, userId, xp, level)
            SELECT 'global', userId, xp, level FROM old_xp;
            DROP TABLE old_xp;
        `);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_xp_guild_level ON xp (guildId, level DESC, xp DESC);`);
} catch (err) {
    console.error('[DB MIGRATION] Failed to migrate xp table:', err);
}

export default db;
