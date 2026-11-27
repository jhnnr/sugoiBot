import dotenv from 'dotenv';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import cookieParser from 'cookie-parser';
import db from '../lib/database.js';
import { SettingsManager } from '../lib/settings.js';
import { loggingService } from '../lib/bot/loggingService.js';
import { authRateLimiter, apiRateLimiter, resetAllRateLimiters } from '../lib/middleware/rateLimiter.js';
import {
    createDatabaseBackup,
    exportCompressedBackup,
    listDatabaseBackups,
    isValidBackupFilename,
    resolveBackupFilePath,
    deleteDatabaseBackup
} from '../lib/backupService.js';
import { emitVoiceUpdate, subscribeVoiceUpdates } from '../modules/voice/lib/voiceHelper.js';

export { resetAllRateLimiters };

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Ensure .env is loaded from the project root regardless of the current working directory
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.use(['/auth', '/api/auth'], authRateLimiter);
app.use('/api', apiRateLimiter);

// In-memory session store (sessionId -> { user, guilds, expiresAt })
export const sessions = new Map();

// Active Discord client reference (when running in same process)
let discordClient = null;

export function setDiscordClient(client) {
    discordClient = client;
}

// Bot guilds cache
let botGuildsCache = { data: [], expiresAt: 0 };

export function clearBotGuildsCache() {
    botGuildsCache = { data: [], expiresAt: 0 };
}

export function setBotGuildsCache(guilds = [], ttlMs = 60_000) {
    botGuildsCache = {
        data: Array.isArray(guilds) ? guilds : [],
        expiresAt: Date.now() + ttlMs
    };
}

const DEFAULT_GLOBAL_SETTINGS = {
    log_channel_id: '',
    xp_enabled: true,
    xp_min: 10,
    xp_max: 20,
    xp_voice_per_minute: 5,
    daily_amount: 100,
    work_min: 10,
    work_max: 50,
    role_rewards: {}
};

export const DEFAULT_GUILD_SETTINGS = {
    command_roles: {},
    module_embed_colors: {},
    log_channel_id: '',
    xp_channel_id: '',
    log_events_member_join: true,
    log_events_member_leave: true,
    log_events_member_update: true,
    log_events_message_delete: true,
    log_events_channels: true,
    log_events_roles: true,
    log_events_moderation: true,
    log_events_voice: false,
    log_events_commands: false,
    module_general_enabled: true,
    module_economy_enabled: true,
    module_moderation_enabled: true,
    module_xp_enabled: true,
    module_gamerole_enabled: true,
    module_voice_enabled: true,
    gamerole_enabled: true,
    gamerole_prefix: 'PLAYING ',
    gamerole_color: '#ff0000',
    gamerole_position: 0,
    voice_enabled: true,
    voice_default_limit: 0,
    voice_naming_scheme: "{username}'s Room",
    module_voicemaster_enabled: true,
    voicemaster_enabled: true,
    xp_enabled: true,
    xp_min: 10,
    xp_max: 20,
    xp_voice_per_minute: 5,
    role_rewards_enabled: true,
    role_rewards: {}
};

/**
 * Extract active session from request cookies
 */
export function getSession(req) {
    const sessionId = req.cookies?.sugoi_session;
    if (!sessionId) return null;
    const session = sessions.get(sessionId);
    if (!session) return null;
    if (session.expiresAt && Date.now() > session.expiresAt) {
        sessions.delete(sessionId);
        return null;
    }
    if (!Array.isArray(session.guilds)) {
        session.guilds = [];
    }
    return session;
}

export function getUserGuilds(session) {
    return Array.isArray(session?.guilds) ? session.guilds : [];
}

/**
 * Check if user permissions include ADMINISTRATOR (0x8) or MANAGE_GUILD (0x20)
 */
export function canManageGuild(guild) {
    if (!guild) return false;
    if (guild.owner) return true;
    try {
        const perms = BigInt(guild.permissions || '0');
        return (perms & 0x8n) === 0x8n || (perms & 0x20n) === 0x20n;
    } catch {
        return false;
    }
}

/**
 * Fetch guilds the bot is currently in from Discord client cache or REST API
 */
export async function getBotGuilds() {
    if (discordClient?.guilds?.cache?.size > 0) {
        return Array.from(discordClient.guilds.cache.values()).map(g => ({
            id: g.id,
            name: g.name,
            icon: g.icon
        }));
    }

    if (Date.now() < botGuildsCache.expiresAt && botGuildsCache.data.length > 0) {
        return botGuildsCache.data;
    }

    const rawToken = process.env.DISCORD_TOKEN;
    const botToken = rawToken ? rawToken.trim().replace(/^["']|["']$/g, '') : '';
    if (!botToken) {
        return [];
    }

    try {
        const res = await fetch('https://discord.com/api/v10/users/@me/guilds', {
            headers: {
                Authorization: `Bot ${botToken}`
            }
        });
        if (res.ok) {
            const data = await res.json();
            if (Array.isArray(data)) {
                botGuildsCache = { data, expiresAt: Date.now() + 60_000 };
                return data;
            }
        }
    } catch (err) {
        console.error('Failed to fetch bot guilds from Discord API:', err.message);
    }
    return botGuildsCache.data;
}

/* =========================================================
   OAuth2 Authentication Routes
   ========================================================= */

app.get('/auth/discord', (req, res) => {
    const rawClientId = process.env.CLIENT_ID;
    const clientId = rawClientId ? rawClientId.trim().replace(/^["']|["']$/g, '') : '';
    const dashboardUrl = (process.env.DASHBOARD_URL || `http://localhost:${PORT}`).trim().replace(/\/+$/, '');
    const redirectUri = `${dashboardUrl}/auth/discord/callback`;

    if (!clientId) {
        return res.status(500).send(
            '<h2>Configuration Error</h2>' +
            '<p><strong>CLIENT_ID</strong> is not configured in environment variables.</p>' +
            '<p>Please ensure your <code>.env</code> file in the project root contains <code>CLIENT_ID=your_id</code> and restart the server.</p>'
        );
    }

    const discordAuthUrl = `https://discord.com/api/oauth2/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=identify%20guilds`;
    res.redirect(discordAuthUrl);
});

app.get('/auth/discord/callback', async (req, res) => {
    const { code } = req.query;
    if (!code) {
        return res.status(400).send('Missing authorization code.');
    }

    const rawClientId = process.env.CLIENT_ID;
    const clientId = rawClientId ? rawClientId.trim().replace(/^["']|["']$/g, '') : '';
    const rawClientSecret = process.env.CLIENT_SECRET;
    const clientSecret = rawClientSecret ? rawClientSecret.trim().replace(/^["']|["']$/g, '') : '';
    const dashboardUrl = (process.env.DASHBOARD_URL || `http://localhost:${PORT}`).trim().replace(/\/+$/, '');
    const redirectUri = `${dashboardUrl}/auth/discord/callback`;

    if (!clientSecret) {
        return res.status(500).send(
            '<h2>Configuration Error</h2>' +
            '<p><strong>CLIENT_SECRET</strong> is not configured in your <code>.env</code> file.</p>' +
            '<p>Please copy your Client Secret from the Discord Developer Portal (under <strong>OAuth2</strong> &rarr; <strong>General</strong>) and add <code>CLIENT_SECRET=your_secret</code> to your <code>.env</code> file, then restart the server.</p>'
        );
    }

    try {
        // Exchange code for token
        const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: clientId,
                client_secret: clientSecret,
                grant_type: 'authorization_code',
                code,
                redirect_uri: redirectUri
            })
        });

        if (!tokenRes.ok) {
            const errBody = await tokenRes.text();
            return res.status(400).send(`Failed to exchange token with Discord: ${errBody}`);
        }

        const tokenData = await tokenRes.json();
        const accessToken = tokenData.access_token;

        // Fetch user profile
        let user = null;
        try {
            const userRes = await fetch('https://discord.com/api/users/@me', {
                headers: { Authorization: `Bearer ${accessToken}` }
            });
            if (userRes.ok) {
                user = await userRes.json();
            } else {
                const err = await userRes.text();
                console.error('[AUTH ERROR] Failed to fetch @me user:', err);
            }
        } catch (e) {
            console.error('[AUTH ERROR] Network error fetching @me user:', e);
        }

        // Fetch user guilds
        let guilds = [];
        try {
            const guildsRes = await fetch('https://discord.com/api/users/@me/guilds', {
                headers: { Authorization: `Bearer ${accessToken}` }
            });
            if (guildsRes.ok) {
                const data = await guildsRes.json();
                guilds = Array.isArray(data) ? data : [];
            } else {
                const err = await guildsRes.text();
                console.error('[AUTH ERROR] Failed to fetch user guilds from Discord:', err);
            }
        } catch (e) {
            console.error('[AUTH ERROR] Network error fetching user guilds:', e);
        }

        // Store session
        const sessionId = crypto.randomUUID();
        sessions.set(sessionId, {
            user,
            guilds,
            accessToken,
            expiresAt: Date.now() + 24 * 60 * 60 * 1000 // 24 hours
        });

        res.cookie('sugoi_session', sessionId, {
            httpOnly: true,
            maxAge: 24 * 60 * 60 * 1000,
            sameSite: 'lax',
            path: '/'
        });

        res.redirect('/');
    } catch (err) {
        console.error('Error in OAuth callback:', err);
        res.status(500).send('Authentication failed due to server error.');
    }
});

app.get('/api/auth/me', (req, res) => {
    const session = getSession(req);
    if (!session) {
        return res.json({ user: null });
    }
    res.json({ user: session.user });
});

app.post('/api/auth/logout', (req, res) => {
    const sessionId = req.cookies?.sugoi_session;
    if (sessionId) {
        sessions.delete(sessionId);
    }
    res.clearCookie('sugoi_session', { path: '/' });
    res.json({ success: true });
});

/**
 * Dev / Test login helper (available for tests and dev mode)
 */
app.post('/api/auth/dev-login', (req, res) => {
    const { user, guilds } = req.body;
    const testUser = user || { id: 'test_user_1', username: 'TestAdmin', discriminator: '0001', avatar: null };
    const testGuilds = Array.isArray(guilds) ? guilds : [];

    const sessionId = crypto.randomUUID();
    sessions.set(sessionId, {
        user: testUser,
        guilds: testGuilds,
        expiresAt: Date.now() + 24 * 60 * 60 * 1000
    });

    res.cookie('sugoi_session', sessionId, {
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000,
        sameSite: 'lax',
        path: '/'
    });

    res.json({ success: true, user: testUser });
});

/* =========================================================
   Guild Management Routes
   ========================================================= */

app.get('/api/guilds', async (req, res) => {
    const session = getSession(req);
    if (!session) {
        return res.status(401).json({ error: 'Unauthorized. Please login with Discord.' });
    }

    const userGuilds = getUserGuilds(session);
    const manageable = userGuilds.filter(canManageGuild);
    const botGuilds = await getBotGuilds();
    const botGuildIdSet = new Set((botGuilds || []).map(g => g.id));
    const clientId = process.env.CLIENT_ID || '';

    const results = manageable.map(g => ({
        id: g.id,
        name: g.name,
        icon: g.icon,
        botPresent: botGuildIdSet.has(g.id) || Boolean(g.botPresent),
        inviteUrl: clientId
            ? `https://discord.com/api/oauth2/authorize?client_id=${clientId}&scope=bot%20applications.commands&permissions=8&guild_id=${g.id}`
            : null
    }));

    res.json({ guilds: results });
});

function sanitizeSettingsPayload(rawUpdates) {
    const sanitized = {};
    for (const [key, val] of Object.entries(rawUpdates)) {
        if ((key === 'log_channel_id' || key === 'xp_channel_id' || key.endsWith('_channel_id')) && typeof val === 'string') {
            sanitized[key] = val.replace(/^["']|["']$/g, '').trim();
        } else if ((key === 'command_roles' || key === 'role_rewards') && val && typeof val === 'object' && !Array.isArray(val)) {
            const cleanMap = {};
            for (const [subKey, roleVal] of Object.entries(val)) {
                if (typeof roleVal === 'string') {
                    cleanMap[String(subKey)] = roleVal.replace(/^["']|["']$/g, '').trim();
                } else if (key === 'command_roles' && Array.isArray(roleVal) && roleVal.every(item => typeof item === 'string')) {
                    cleanMap[String(subKey)] = SettingsManager.normalizeCommandRoles(roleVal);
                } else {
                    cleanMap[String(subKey)] = roleVal;
                }
            }
            sanitized[key] = cleanMap;
        } else if (key === 'module_embed_colors' && val && typeof val === 'object' && !Array.isArray(val)) {
            const cleanColors = {};
            for (const [modKey, colorVal] of Object.entries(val)) {
                cleanColors[String(modKey).toLowerCase()] = typeof colorVal === 'string'
                    ? colorVal.trim()
                    : colorVal;
            }
            sanitized[key] = cleanColors;
        } else {
            sanitized[key] = val;
        }
    }
    return sanitized;
}

app.get('/api/guilds/:guildId/settings', (req, res) => {
    const session = getSession(req);
    if (!session) {
        return res.status(401).json({ error: 'Unauthorized. Please login with Discord.' });
    }

    const { guildId } = req.params;
    const targetGuild = getUserGuilds(session).find(g => g.id === guildId);
    if (!targetGuild || !canManageGuild(targetGuild)) {
        return res.status(403).json({ error: 'You do not have permission to manage this server.' });
    }

    const current = SettingsManager.getAllGuild(guildId);
    res.json({ guildId, settings: { ...DEFAULT_GUILD_SETTINGS, ...current } });
});

app.post('/api/guilds/:guildId/settings', (req, res) => {
    const session = getSession(req);
    if (!session) {
        return res.status(401).json({ error: 'Unauthorized. Please login with Discord.' });
    }

    const { guildId } = req.params;
    const targetGuild = getUserGuilds(session).find(g => g.id === guildId);
    if (!targetGuild || !canManageGuild(targetGuild)) {
        return res.status(403).json({ error: 'You do not have permission to manage this server.' });
    }

    const payload = req.body;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return res.status(400).json({ error: 'Request body must be a JSON object' });
    }

    const rawUpdates = 'key' in payload && 'value' in payload
        ? { [payload.key]: payload.value }
        : payload;
    const updates = sanitizeSettingsPayload(rawUpdates);

    for (const [key, val] of Object.entries(updates)) {
        if (!SettingsManager.validate(key, val, updates)) {
            return res.status(400).json({ error: `Validation failed for setting "${key}": ${JSON.stringify(val)}` });
        }
    }

    SettingsManager.setGuildMany(guildId, updates);

    const updated = { ...DEFAULT_GUILD_SETTINGS, ...SettingsManager.getAllGuild(guildId) };
    res.json({ success: true, guildId, settings: updated });
});

app.get('/api/guilds/:guildId/settings/export', (req, res) => {
    const session = getSession(req);
    if (!session) {
        return res.status(401).json({ error: 'Unauthorized. Please login with Discord.' });
    }

    const { guildId } = req.params;
    const targetGuild = getUserGuilds(session).find(g => g.id === guildId);
    if (!targetGuild || !canManageGuild(targetGuild)) {
        return res.status(403).json({ error: 'You do not have permission to manage this server.' });
    }

    try {
        const settings = { ...DEFAULT_GUILD_SETTINGS, ...SettingsManager.getAllGuild(guildId) };
        const gamerole_whitelist = db.prepare('SELECT gameName, roleName FROM gamerole_whitelist WHERE guildId = ? ORDER BY gameName ASC').all(guildId);
        let voice_hubs = db.prepare('SELECT hubChannelId, categoryId FROM voice_hubs WHERE guildId = ?').all(guildId);
        if (!voice_hubs || voice_hubs.length === 0) {
            voice_hubs = db.prepare('SELECT hubChannelId, categoryId FROM voice_guilds WHERE guildId = ? AND hubChannelId IS NOT NULL').all(guildId);
        }
        const shop_items = db.prepare('SELECT name, description, price, roleId, stock FROM shop_items WHERE guildId = ? ORDER BY price ASC, id ASC')
            .all(guildId)
            .map(item => ({
                name: item.name,
                description: item.description ?? '',
                price: Number(item.price),
                roleId: item.roleId || '',
                stock: Number(item.stock)
            }));

        res.setHeader('Content-Disposition', `attachment; filename="sugoibot-settings-${guildId}.json"`);
        res.json({
            version: 1,
            exportedAt: new Date().toISOString(),
            guildId,
            settings,
            gamerole_whitelist,
            gameroleWhitelist: gamerole_whitelist,
            voice_hubs,
            voiceHubs: voice_hubs,
            shop_items,
            shopItems: shop_items
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to export server settings' });
    }
});

app.post('/api/guilds/:guildId/settings/import', (req, res) => {
    const session = getSession(req);
    if (!session) {
        return res.status(401).json({ error: 'Unauthorized. Please login with Discord.' });
    }

    const { guildId } = req.params;
    const targetGuild = getUserGuilds(session).find(g => g.id === guildId);
    if (!targetGuild || !canManageGuild(targetGuild)) {
        return res.status(403).json({ error: 'You do not have permission to manage this server.' });
    }

    const payload = req.body;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return res.status(400).json({ error: 'Import payload must be a JSON object' });
    }

    let rawSettings = {};
    if ('settings' in payload) {
        if (!payload.settings || typeof payload.settings !== 'object' || Array.isArray(payload.settings)) {
            return res.status(400).json({ error: 'Field "settings" must be a JSON object' });
        }
        rawSettings = payload.settings;
    } else {
        const metaKeys = new Set([
            'version',
            'exportedAt',
            'guildId',
            'guildName',
            'gamerole_whitelist',
            'gameroleWhitelist',
            'voice_hubs',
            'voiceHubs',
            'shop_items',
            'shopItems'
        ]);
        for (const [k, v] of Object.entries(payload)) {
            if (!metaKeys.has(k)) {
                rawSettings[k] = v;
            }
        }
    }

    const rawWhitelist = 'gamerole_whitelist' in payload
        ? payload.gamerole_whitelist
        : ('gameroleWhitelist' in payload ? payload.gameroleWhitelist : undefined);
    const rawVoiceHubs = 'voice_hubs' in payload
        ? payload.voice_hubs
        : ('voiceHubs' in payload ? payload.voiceHubs : undefined);
    const rawShopItems = 'shop_items' in payload
        ? payload.shop_items
        : ('shopItems' in payload ? payload.shopItems : undefined);

    if (rawWhitelist !== undefined) {
        if (!Array.isArray(rawWhitelist)) {
            return res.status(400).json({ error: 'Field "gamerole_whitelist" must be an array' });
        }
        for (const item of rawWhitelist) {
            if (!item || typeof item !== 'object' || typeof item.gameName !== 'string' || !item.gameName.trim() || typeof item.roleName !== 'string' || !item.roleName.trim()) {
                return res.status(400).json({ error: 'Invalid entry in "gamerole_whitelist"' });
            }
        }
    }

    if (rawVoiceHubs !== undefined) {
        if (!Array.isArray(rawVoiceHubs)) {
            return res.status(400).json({ error: 'Field "voice_hubs" must be an array' });
        }
        for (const hub of rawVoiceHubs) {
            if (!hub || typeof hub !== 'object' || typeof hub.hubChannelId !== 'string' || !hub.hubChannelId.replace(/^["']|["']$/g, '').trim()) {
                return res.status(400).json({ error: 'Invalid entry in "voice_hubs"' });
            }
            if (hub.categoryId !== undefined && hub.categoryId !== null && typeof hub.categoryId !== 'string') {
                return res.status(400).json({ error: 'Invalid categoryId in "voice_hubs"' });
            }
        }
    }

    if (rawShopItems !== undefined) {
        if (!Array.isArray(rawShopItems)) {
            return res.status(400).json({ error: 'Field "shop_items" must be an array' });
        }
        for (const item of rawShopItems) {
            if (!item || typeof item !== 'object' || Array.isArray(item)) {
                return res.status(400).json({ error: 'Invalid entry in "shop_items"' });
            }
            if (typeof item.name !== 'string' || !item.name.trim() || item.name.trim().length > 100) {
                return res.status(400).json({ error: 'Invalid item name in "shop_items"' });
            }
            if (item.description !== undefined && item.description !== null && (typeof item.description !== 'string' || item.description.trim().length > 500)) {
                return res.status(400).json({ error: 'Invalid item description in "shop_items"' });
            }
            const parsedPrice = typeof item.price === 'number' ? item.price : Number.NaN;
            if (!Number.isFinite(parsedPrice) || !Number.isInteger(parsedPrice) || parsedPrice < 0) {
                return res.status(400).json({ error: 'Invalid item price in "shop_items"' });
            }
            if (item.roleId !== undefined && item.roleId !== null && typeof item.roleId !== 'string') {
                return res.status(400).json({ error: 'Invalid item roleId in "shop_items"' });
            }
            if (item.stock !== undefined && item.stock !== null) {
                if (typeof item.stock !== 'number' || !Number.isInteger(item.stock) || item.stock < -1) {
                    return res.status(400).json({ error: 'Invalid item stock in "shop_items"' });
                }
            }
        }
    }

    const sanitizedSettings = sanitizeSettingsPayload(rawSettings);
    const hasSettings = Object.keys(sanitizedSettings).length > 0;
    const hasWhitelist = Array.isArray(rawWhitelist);
    const hasVoiceHubs = Array.isArray(rawVoiceHubs);
    const hasShopItems = Array.isArray(rawShopItems);

    if (!hasSettings && !hasWhitelist && !hasVoiceHubs && !hasShopItems) {
        return res.status(400).json({ error: 'Import payload contains no configuration data' });
    }

    for (const [key, val] of Object.entries(sanitizedSettings)) {
        if (!SettingsManager.validate(key, val, sanitizedSettings)) {
            return res.status(400).json({ error: `Validation failed for setting "${key}": ${JSON.stringify(val)}` });
        }
    }

    try {
        const importTx = db.transaction(() => {
            if (hasSettings) {
                SettingsManager.setGuildMany(guildId, sanitizedSettings);
            }

            if (hasWhitelist) {
                db.prepare('DELETE FROM gamerole_whitelist WHERE guildId = ?').run(guildId);
                const insertWl = db.prepare('INSERT OR REPLACE INTO gamerole_whitelist (guildId, gameName, roleName) VALUES (?, ?, ?)');
                for (const item of rawWhitelist) {
                    insertWl.run(guildId, item.gameName.trim(), item.roleName.trim());
                }
            }

            if (hasVoiceHubs) {
                db.prepare('DELETE FROM voice_hubs WHERE guildId = ?').run(guildId);
                db.prepare('DELETE FROM voice_guilds WHERE guildId = ?').run(guildId);
                const insertHub = db.prepare('INSERT OR REPLACE INTO voice_hubs (hubChannelId, guildId, categoryId) VALUES (?, ?, ?)');
                for (const hub of rawVoiceHubs) {
                    const cleanHubId = hub.hubChannelId.replace(/^["']|["']$/g, '').trim();
                    const cleanCatId = typeof hub.categoryId === 'string'
                        ? (hub.categoryId.replace(/^["']|["']$/g, '').trim() || null)
                        : null;
                    insertHub.run(cleanHubId, guildId, cleanCatId);
                }
                if (rawVoiceHubs.length > 0) {
                    const firstHub = rawVoiceHubs[0];
                    const cleanFirstHubId = firstHub.hubChannelId.replace(/^["']|["']$/g, '').trim();
                    const cleanFirstCatId = typeof firstHub.categoryId === 'string'
                        ? (firstHub.categoryId.replace(/^["']|["']$/g, '').trim() || null)
                        : null;
                    db.prepare('INSERT OR REPLACE INTO voice_guilds (guildId, hubChannelId, categoryId) VALUES (?, ?, ?)').run(
                        guildId,
                        cleanFirstHubId,
                        cleanFirstCatId
                    );
                }
            }

            if (hasShopItems) {
                db.prepare('DELETE FROM shop_items WHERE guildId = ?').run(guildId);
                const insertShop = db.prepare(`
                    INSERT INTO shop_items (guildId, name, description, price, roleId, stock, createdAt)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                `);
                const now = Date.now();
                for (const item of rawShopItems) {
                    const cleanName = item.name.trim();
                    const cleanDesc = typeof item.description === 'string' ? item.description.trim() : '';
                    const cleanPrice = Number(item.price);
                    const cleanRole = typeof item.roleId === 'string'
                        ? item.roleId.replace(/^["']|["']$/g, '').trim()
                        : '';
                    const cleanStock = item.stock === undefined || item.stock === null ? -1 : Number(item.stock);
                    insertShop.run(guildId, cleanName, cleanDesc, cleanPrice, cleanRole, cleanStock, now);
                }
            }
        });

        importTx();

        if (hasVoiceHubs) {
            emitVoiceUpdate(guildId);
        }

        loggingService.recordAuditLog(guildId, {
            title: 'Server Settings Imported',
            description: `Restored ${Object.keys(sanitizedSettings).length} server setting(s) via dashboard configuration import.`,
            eventType: 'log_events_dashboard',
            color: 0x5865F2,
            user: session.user
        });

        const updatedSettings = { ...DEFAULT_GUILD_SETTINGS, ...SettingsManager.getAllGuild(guildId) };
        const updatedWhitelist = db.prepare('SELECT gameName, roleName FROM gamerole_whitelist WHERE guildId = ? ORDER BY gameName ASC').all(guildId);
        const updatedHubs = db.prepare('SELECT hubChannelId, categoryId FROM voice_hubs WHERE guildId = ?').all(guildId);
        const updatedShopItems = db.prepare('SELECT name, description, price, roleId, stock FROM shop_items WHERE guildId = ? ORDER BY price ASC, id ASC')
            .all(guildId)
            .map(item => ({
                name: item.name,
                description: item.description ?? '',
                price: Number(item.price),
                roleId: item.roleId || '',
                stock: Number(item.stock)
            }));

        res.json({
            success: true,
            guildId,
            settings: updatedSettings,
            gamerole_whitelist: updatedWhitelist,
            gameroleWhitelist: updatedWhitelist,
            voice_hubs: updatedHubs,
            voiceHubs: updatedHubs,
            shop_items: updatedShopItems,
            shopItems: updatedShopItems
        });
    } catch (error) {
        res.status(400).json({ error: error.message || 'Failed to import server settings' });
    }
});

app.get('/api/guilds/:guildId/audit-logs', (req, res) => {
    const session = getSession(req);
    if (!session) {
        return res.status(401).json({ error: 'Unauthorized. Please login with Discord.' });
    }

    const { guildId } = req.params;
    const targetGuild = getUserGuilds(session).find(g => g.id === guildId);
    if (!targetGuild || !canManageGuild(targetGuild)) {
        return res.status(403).json({ error: 'You do not have permission to manage this server.' });
    }

    try {
        const limit = req.query.limit ? Number(req.query.limit) : 50;
        const eventType = typeof req.query.eventType === 'string' && req.query.eventType.trim()
            ? req.query.eventType.trim()
            : null;
        const search = typeof req.query.search === 'string' && req.query.search.trim()
            ? req.query.search.trim()
            : null;

        const guild = discordClient?.guilds?.cache?.get(guildId) || null;
        const logs = loggingService.getAuditLogs(guildId, {
            limit,
            eventType,
            search,
            guild,
            client: discordClient
        });
        res.json({ guildId, logs });
    } catch (error) {
        res.status(500).json({ error: 'Failed to retrieve audit logs' });
    }
});

app.get('/api/guilds/:guildId/audit-logs/stream', (req, res) => {
    const session = getSession(req);
    if (!session) {
        return res.status(401).json({ error: 'Unauthorized. Please login with Discord.' });
    }

    const { guildId } = req.params;
    const targetGuild = getUserGuilds(session).find(g => g.id === guildId);
    if (!targetGuild || !canManageGuild(targetGuild)) {
        return res.status(403).json({ error: 'You do not have permission to manage this server.' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    if (typeof res.flushHeaders === 'function') {
        res.flushHeaders();
    }

    res.write(`event: connected\ndata: ${JSON.stringify({ guildId })}\n\n`);

    const unsubscribe = loggingService.subscribe(guildId, (entry) => {
        try {
            const guild = discordClient?.guilds?.cache?.get(guildId) || null;
            const resolvedEntry = {
                ...entry,
                description: loggingService.resolveAuditMentions(entry.description, {
                    guild,
                    client: discordClient,
                    user: entry.userId ? { id: entry.userId, username: entry.username, tag: entry.userTag || entry.username } : null
                })
            };
            res.write(`data: ${JSON.stringify(resolvedEntry)}\n\n`);
        } catch {}
    });

    req.on('close', () => {
        unsubscribe();
    });
});

app.get('/api/modules', async (req, res) => {
    try {
        const modulesDir = path.resolve(__dirname, '..', 'modules');
        const entries = fs.readdirSync(modulesDir).filter(f => fs.statSync(path.join(modulesDir, f)).isDirectory());
        const list = [];
        for (const folder of entries) {
            const indexPath = path.join(modulesDir, folder, 'index.js');
            if (fs.existsSync(indexPath)) {
                try {
                    const mod = (await import(pathToFileURL(indexPath).href)).default;
                    if (mod) {
                        list.push({
                            id: folder.toLowerCase(),
                            name: mod.name || folder,
                            description: mod.description || '',
                            settings: (mod.settings || []).map(s => ({
                                key: s.key,
                                description: s.description,
                                type: s.type,
                                defaultValue: s.defaultValue,
                                min: s.min,
                                max: s.max
                            }))
                        });
                    }
                } catch (err) {}
            }
        }
        res.json({ modules: list });
    } catch (error) {
        res.status(500).json({ error: 'Failed to discover modules' });
    }
});

app.get('/api/commands', async (req, res) => {
    try {
        const list = [];
        if (discordClient?.commands && discordClient.commands.size > 0) {
            for (const [name, cmd] of discordClient.commands.entries()) {
                const json = typeof cmd.data?.toJSON === 'function' ? cmd.data.toJSON() : null;
                const subcommands = (json?.options || [])
                    .filter(o => o.type === 1)
                    .map(s => ({ name: s.name, description: s.description || '' }));

                list.push({
                    name,
                    module: cmd.module || 'general',
                    description: cmd.data?.description || `Command /${name}`,
                    subcommands
                });
            }
        } else {
            const modulesDir = path.resolve(__dirname, '..', 'modules');
            const entries = fs.readdirSync(modulesDir).filter(f => fs.statSync(path.join(modulesDir, f)).isDirectory());
            for (const mod of entries) {
                const cmdDir = path.join(modulesDir, mod, 'commands');
                if (fs.existsSync(cmdDir)) {
                    const files = fs.readdirSync(cmdDir).filter(f => f.endsWith('.js'));
                    for (const file of files) {
                        try {
                            const cmdUrl = pathToFileURL(path.join(cmdDir, file)).href;
                            const cmd = (await import(cmdUrl)).default;
                            if (cmd?.data) {
                                const json = typeof cmd.data?.toJSON === 'function' ? cmd.data.toJSON() : null;
                                const subcommands = (json?.options || [])
                                    .filter(o => o.type === 1)
                                    .map(s => ({ name: s.name, description: s.description || '' }));

                                list.push({
                                    name: cmd.data.name,
                                    module: mod,
                                    description: cmd.data.description || `Command /${cmd.data.name}`,
                                    subcommands
                                });
                            }
                        } catch {
                            const name = file.replace('.js', '');
                            list.push({ name, module: mod, description: `Command /${name}`, subcommands: [] });
                        }
                    }
                }
            }
        }
        res.json({ commands: list });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch commands' });
    }
});

app.get('/api/guilds/:guildId/channels', async (req, res) => {
    const session = getSession(req);
    if (!session) {
        return res.status(401).json({ error: 'Unauthorized. Please login with Discord.' });
    }

    const { guildId } = req.params;
    const targetGuild = getUserGuilds(session).find(g => g.id === guildId);
    if (!targetGuild || !canManageGuild(targetGuild)) {
        return res.status(403).json({ error: 'You do not have permission to manage this server.' });
    }

    // 1. Live Discord client in-memory resolution (instant & reliable)
    if (discordClient) {
        try {
            const guild = discordClient.guilds.cache.get(guildId) || await discordClient.guilds.fetch(guildId).catch(() => null);
            if (guild) {
                const channels = await guild.channels.fetch().catch(() => guild.channels.cache);
                const textChannels = Array.from(channels.values())
                    .filter(c => c && (c.type === 0 || c.type === 5))
                    .sort((a, b) => a.position - b.position)
                    .map(c => ({
                        id: c.id,
                        name: c.name,
                        type: c.type,
                        parentId: c.parentId
                    }));
                return res.json({ channels: textChannels });
            }
        } catch (err) {}
    }

    // 2. Fallback to Discord REST API with sanitized token
    const rawToken = process.env.DISCORD_TOKEN;
    const botToken = rawToken ? rawToken.trim().replace(/^["']|["']$/g, '') : '';
    if (!botToken) {
        return res.json({ channels: [] });
    }

    try {
        const discordRes = await fetch(`https://discord.com/api/v10/guilds/${guildId}/channels`, {
            headers: {
                Authorization: `Bot ${botToken}`
            }
        });

        if (discordRes.ok) {
            const data = await discordRes.json();
            const textChannels = data
                .filter(c => c.type === 0 || c.type === 5)
                .sort((a, b) => a.position - b.position)
                .map(c => ({
                    id: c.id,
                    name: c.name,
                    type: c.type,
                    parentId: c.parent_id
                }));
            return res.json({ channels: textChannels });
        } else {
            return res.json({ channels: [] });
        }
    } catch (err) {
        return res.json({ channels: [] });
    }
});

export async function getGuildVoiceSnapshot(guildId) {
    let hubs = db.prepare('SELECT * FROM voice_hubs WHERE guildId = ?').all(guildId);
    if (!hubs || hubs.length === 0) {
        hubs = db.prepare('SELECT * FROM voice_guilds WHERE guildId = ?').all(guildId);
    }

    const voiceRows = db.prepare('SELECT * FROM voice_channels WHERE guildId = ?').all(guildId);
    const vmRows = db.prepare('SELECT * FROM voicemaster_channels WHERE guildId = ?').all(guildId);
    const seenRoomIds = new Set();
    let activeRooms = [];
    for (const r of [...(voiceRows || []), ...(vmRows || [])]) {
        if (!r?.channelId) continue;
        const chId = String(r.channelId);
        if (!seenRoomIds.has(chId)) {
            seenRoomIds.add(chId);
            activeRooms.push(r);
        }
    }

    let discordChannels = [];
    let resolvedFromClient = false;
    let resolvedFromRest = false;
    const liveClientChannelMap = new Map();

    // 1. Live Discord client resolution first
    if (discordClient) {
        try {
            const guild = discordClient.guilds?.cache?.get?.(guildId)
                || (typeof discordClient.guilds?.fetch === 'function'
                    ? await discordClient.guilds.fetch(guildId).catch(() => null)
                    : null);
            if (guild?.channels) {
                const fetched = typeof guild.channels.fetch === 'function'
                    ? await guild.channels.fetch().catch(() => guild.channels.cache)
                    : guild.channels.cache;
                const rawCollection = fetched || guild.channels.cache;
                if (rawCollection) {
                    const list = Array.isArray(rawCollection)
                        ? rawCollection
                        : (typeof rawCollection.values === 'function' ? Array.from(rawCollection.values()) : []);
                    const validList = list.filter(Boolean);
                    for (const c of validList) {
                        if (c.id) {
                            liveClientChannelMap.set(String(c.id), c);
                        }
                    }
                    discordChannels = validList.map(c => ({
                        id: String(c.id),
                        name: c.name,
                        type: c.type,
                        position: typeof c.position === 'number' ? c.position : (typeof c.rawPosition === 'number' ? c.rawPosition : 0),
                        parent_id: c.parentId ?? c.parent_id ?? null,
                        user_limit: c.userLimit ?? c.user_limit ?? 0
                    }));
                    resolvedFromClient = true;
                }
            }
        } catch {}
    }

    // 2. Fallback to Discord REST API with quote-sanitized DISCORD_TOKEN
    if (!resolvedFromClient) {
        const rawToken = process.env.DISCORD_TOKEN;
        const botToken = rawToken ? rawToken.trim().replace(/^["']|["']$/g, '') : '';
        if (botToken) {
            try {
                const cRes = await fetch(`https://discord.com/api/v10/guilds/${guildId}/channels`, {
                    headers: { Authorization: `Bot ${botToken}` }
                });
                if (cRes.ok) {
                    const data = await cRes.json();
                    if (Array.isArray(data)) {
                        discordChannels = data.filter(Boolean).map(c => ({
                            id: String(c.id),
                            name: c.name,
                            type: c.type,
                            position: typeof c.position === 'number' ? c.position : 0,
                            parent_id: c.parent_id ?? c.parentId ?? null,
                            user_limit: c.user_limit ?? c.userLimit ?? 0
                        }));
                        resolvedFromRest = true;
                    }
                }
            } catch {}
        }
    }

    const channelMap = new Map(discordChannels.map(c => [String(c.id), c]));

    if (resolvedFromClient || resolvedFromRest) {
        const staleChannelIds = new Set();
        const emptyChannelsToDelete = [];
        const now = Date.now();

        for (const r of [...(voiceRows || []), ...(vmRows || [])]) {
            if (!r?.channelId) continue;
            const chId = String(r.channelId);
            if (!channelMap.has(chId)) {
                staleChannelIds.add(chId);
            } else if (resolvedFromClient) {
                const liveCh = liveClientChannelMap.get(chId);
                if (
                    liveCh?.members instanceof Map &&
                    liveCh.members.size === 0 &&
                    r.createdAt &&
                    now - Number(r.createdAt) > 15_000
                ) {
                    staleChannelIds.add(chId);
                    emptyChannelsToDelete.push(liveCh);
                }
            }
        }

        if (staleChannelIds.size > 0) {
            const pruneStaleVoiceTx = db.transaction((ids) => {
                const delVoice = db.prepare('DELETE FROM voice_channels WHERE guildId = ? AND channelId = ?');
                const delVm = db.prepare('DELETE FROM voicemaster_channels WHERE guildId = ? AND channelId = ?');
                for (const id of ids) {
                    delVoice.run(guildId, id);
                    delVm.run(guildId, id);
                }
            });
            pruneStaleVoiceTx([...staleChannelIds]);

            for (const liveCh of emptyChannelsToDelete) {
                channelMap.delete(String(liveCh.id));
                if (typeof liveCh.delete === 'function') {
                    await liveCh.delete('Pruning stale empty temporary voice room').catch(() => {});
                }
            }

            activeRooms = activeRooms.filter(r => !staleChannelIds.has(String(r.channelId)));
        }
    }

    const categories = discordChannels
        .filter(c => c && c.type === 4)
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
        .map(c => ({
            id: c.id,
            name: c.name,
            position: c.position ?? 0
        }));

    const enrichedHubs = (hubs || []).map(h => {
        const ch = channelMap.get(String(h.hubChannelId));
        let cat = h.categoryId ? channelMap.get(String(h.categoryId)) : null;
        if (!cat && ch?.parent_id) {
            cat = channelMap.get(String(ch.parent_id));
        }

        let catDisplayName = 'No Category';
        if (cat?.name) {
            catDisplayName = cat.name;
        } else if (h.categoryId && discordChannels.length > 0 && !channelMap.has(String(h.categoryId))) {
            catDisplayName = 'Deleted Category';
        } else if (h.categoryId) {
            catDisplayName = h.categoryId;
        }

        return {
            hubChannelId: h.hubChannelId,
            categoryId: h.categoryId || (ch?.parent_id || null),
            name: ch ? ch.name : (h.hubChannelId ? `Hub (${h.hubChannelId})` : 'Join to Create'),
            categoryName: catDisplayName,
            existsInDiscord: Boolean(ch)
        };
    });

    const enrichedRooms = (activeRooms || []).map(r => {
        const ch = channelMap.get(String(r.channelId));
        return {
            channelId: r.channelId,
            ownerId: r.ownerId,
            name: ch ? ch.name : `Room (${r.channelId})`,
            userLimit: ch ? ch.user_limit : 0,
            createdAt: r.createdAt
        };
    });

    return {
        hubs: enrichedHubs,
        activeRooms: enrichedRooms,
        categories
    };
}

app.get('/api/guilds/:guildId/voice', async (req, res) => {
    const session = getSession(req);
    if (!session) {
        return res.status(401).json({ error: 'Unauthorized. Please login with Discord.' });
    }

    const { guildId } = req.params;
    const targetGuild = getUserGuilds(session).find(g => g.id === guildId);
    if (!targetGuild || !canManageGuild(targetGuild)) {
        return res.status(403).json({ error: 'You do not have permission to manage this server.' });
    }

    try {
        const snapshot = await getGuildVoiceSnapshot(guildId);
        res.json(snapshot);
    } catch (err) {
        res.status(500).json({ error: 'Failed to retrieve voice status' });
    }
});

app.get('/api/guilds/:guildId/voice/stream', async (req, res) => {
    const session = getSession(req);
    if (!session) {
        return res.status(401).json({ error: 'Unauthorized. Please login with Discord.' });
    }

    const { guildId } = req.params;
    const targetGuild = getUserGuilds(session).find(g => g.id === guildId);
    if (!targetGuild || !canManageGuild(targetGuild)) {
        return res.status(403).json({ error: 'You do not have permission to manage this server.' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    if (typeof res.flushHeaders === 'function') {
        res.flushHeaders();
    }

    let closed = false;
    let lastSerialized = null;
    let pushInFlight = false;
    let pushPending = false;

    req.on('close', () => {
        closed = true;
    });

    const pushSnapshot = async (force = false) => {
        if (closed) return;
        if (pushInFlight) {
            pushPending = true;
            return;
        }
        pushInFlight = true;
        try {
            do {
                pushPending = false;
                if (closed) break;
                const snapshot = await getGuildVoiceSnapshot(guildId);
                if (closed) break;
                const payload = { guildId, ...snapshot };
                const serialized = JSON.stringify(payload);
                if (force || serialized !== lastSerialized) {
                    lastSerialized = serialized;
                    res.write(`data: ${serialized}\n\n`);
                }
                force = false;
            } while (pushPending && !closed);
        } catch {} finally {
            pushInFlight = false;
        }
    };

    res.write(`event: connected\ndata: ${JSON.stringify({ guildId })}\n\n`);
    await pushSnapshot(true);

    if (closed) return;

    const unsubscribe = subscribeVoiceUpdates(guildId, () => {
        void pushSnapshot(false);
    });

    const reconcileInterval = setInterval(() => {
        void pushSnapshot(false);
    }, 5_000);
    if (typeof reconcileInterval.unref === 'function') {
        reconcileInterval.unref();
    }

    req.on('close', () => {
        clearInterval(reconcileInterval);
        unsubscribe();
    });
});

app.post('/api/guilds/:guildId/voice/hubs', async (req, res) => {
    const session = getSession(req);
    if (!session) {
        return res.status(401).json({ error: 'Unauthorized. Please login with Discord.' });
    }

    const { guildId } = req.params;
    const targetGuild = getUserGuilds(session).find(g => g.id === guildId);
    if (!targetGuild || !canManageGuild(targetGuild)) {
        return res.status(403).json({ error: 'You do not have permission to manage this server.' });
    }

    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const rawName = body.name !== undefined ? body.name : body.hubName;
    if (rawName !== undefined && rawName !== null && typeof rawName !== 'string') {
        return res.status(400).json({ error: 'Voice hub name must be a string.' });
    }
    const hubChannelName = (typeof rawName === 'string' && rawName.trim())
        ? rawName.trim()
        : 'Join to Create';
    if (hubChannelName.length < 1 || hubChannelName.length > 100) {
        return res.status(400).json({ error: 'Voice hub name must be between 1 and 100 characters.' });
    }

    if (body.categoryId !== undefined && body.categoryId !== null && typeof body.categoryId !== 'string') {
        return res.status(400).json({ error: 'categoryId must be a string.' });
    }
    if (body.createCategoryName !== undefined && body.createCategoryName !== null && typeof body.createCategoryName !== 'string') {
        return res.status(400).json({ error: 'createCategoryName must be a string.' });
    }

    const newCategoryName = typeof body.createCategoryName === 'string' ? body.createCategoryName.trim() : '';
    if (newCategoryName.length > 100) {
        return res.status(400).json({ error: 'Category name must be 100 characters or fewer.' });
    }

    let sanitizedCategoryId = typeof body.categoryId === 'string'
        ? body.categoryId.replace(/^["']|["']$/g, '').trim()
        : '';
    if (newCategoryName && (sanitizedCategoryId === '__new__' || sanitizedCategoryId === 'new')) {
        sanitizedCategoryId = '';
    }

    let finalCategoryId = sanitizedCategoryId || null;
    let resolvedCategoryName = null;
    let createdChannelId = null;
    let createdChannelName = hubChannelName;
    let createdVia = null;

    let clientGuild = null;
    if (discordClient) {
        clientGuild = discordClient.guilds?.cache?.get?.(guildId)
            || (typeof discordClient.guilds?.fetch === 'function'
                ? await discordClient.guilds.fetch(guildId).catch(() => null)
                : null);
    }

    // 1. Try live discordClient first
    if (clientGuild && typeof clientGuild.channels?.create === 'function') {
        try {
            if (!finalCategoryId && newCategoryName) {
                const createdCat = await clientGuild.channels.create({
                    name: newCategoryName,
                    type: 4
                });
                if (createdCat?.id) {
                    finalCategoryId = String(createdCat.id);
                    resolvedCategoryName = createdCat.name || newCategoryName;
                }
            } else if (finalCategoryId) {
                const existingCat = clientGuild.channels?.cache?.get?.(finalCategoryId)
                    || (typeof clientGuild.channels?.fetch === 'function'
                        ? await clientGuild.channels.fetch(finalCategoryId).catch(() => null)
                        : null);
                if (existingCat?.name) {
                    resolvedCategoryName = existingCat.name;
                }
            }

            const createdVoice = await clientGuild.channels.create({
                name: hubChannelName,
                type: 2,
                parent: finalCategoryId || undefined
            });
            if (!createdVoice || !createdVoice.id) {
                return res.status(502).json({ error: 'Discord client failed to create voice hub channel.' });
            }
            createdChannelId = String(createdVoice.id);
            createdChannelName = createdVoice.name || hubChannelName;
            if (!finalCategoryId && (createdVoice.parentId || createdVoice.parent_id)) {
                finalCategoryId = String(createdVoice.parentId || createdVoice.parent_id);
            }
            createdVia = 'client';
        } catch (err) {
            return res.status(502).json({ error: `Failed to create voice hub via Discord client: ${err.message || 'Unknown error'}` });
        }
    }

    // 2. Fallback to Discord REST API
    if (!createdVia) {
        const rawToken = process.env.DISCORD_TOKEN;
        const botToken = rawToken ? rawToken.trim().replace(/^["']|["']$/g, '') : '';
        if (!botToken) {
            return res.status(400).json({ error: 'Bot is not connected to Discord and DISCORD_TOKEN is not configured.' });
        }

        try {
            if (!finalCategoryId && newCategoryName) {
                const catRes = await fetch(`https://discord.com/api/v10/guilds/${guildId}/channels`, {
                    method: 'POST',
                    headers: {
                        Authorization: `Bot ${botToken}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        name: newCategoryName,
                        type: 4
                    })
                });
                if (!catRes.ok) {
                    const errText = await catRes.text().catch(() => '');
                    return res.status(502).json({ error: `Failed to create category in Discord: ${errText || catRes.status}` });
                }
                const catData = await catRes.json();
                if (catData?.id) {
                    finalCategoryId = String(catData.id);
                    resolvedCategoryName = catData.name || newCategoryName;
                }
            }

            const hubPayload = {
                name: hubChannelName,
                type: 2,
                ...(finalCategoryId ? { parent_id: finalCategoryId } : {})
            };
            const chRes = await fetch(`https://discord.com/api/v10/guilds/${guildId}/channels`, {
                method: 'POST',
                headers: {
                    Authorization: `Bot ${botToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(hubPayload)
            });
            if (!chRes.ok) {
                const errText = await chRes.text().catch(() => '');
                return res.status(502).json({ error: `Failed to create voice hub channel in Discord: ${errText || chRes.status}` });
            }
            const chData = await chRes.json();
            if (!chData?.id) {
                return res.status(502).json({ error: 'Discord API did not return a channel ID.' });
            }
            createdChannelId = String(chData.id);
            createdChannelName = chData.name || hubChannelName;
            if (!finalCategoryId && chData.parent_id) {
                finalCategoryId = String(chData.parent_id);
            }
            createdVia = 'rest';
        } catch (err) {
            return res.status(502).json({ error: `Failed to communicate with Discord API: ${err.message || 'Network error'}` });
        }
    }

    try {
        const persistHubTx = db.transaction(() => {
            db.prepare('INSERT OR REPLACE INTO voice_hubs (hubChannelId, guildId, categoryId) VALUES (?, ?, ?)').run(
                createdChannelId,
                guildId,
                finalCategoryId || null
            );
            db.prepare('INSERT OR REPLACE INTO voice_guilds (guildId, hubChannelId, categoryId) VALUES (?, ?, ?)').run(
                guildId,
                createdChannelId,
                finalCategoryId || null
            );
        });
        persistHubTx();
        emitVoiceUpdate(guildId);

        if (!resolvedCategoryName) {
            if (finalCategoryId) {
                const cachedCat = clientGuild?.channels?.cache?.get?.(finalCategoryId);
                resolvedCategoryName = cachedCat?.name || finalCategoryId;
            } else {
                resolvedCategoryName = 'No Category';
            }
        }

        loggingService.recordAuditLog(guildId, {
            eventType: 'log_events_channels',
            title: 'Voice Hub Created',
            description: `Created Join-to-Create voice hub **${createdChannelName}** (${createdChannelId})${resolvedCategoryName && resolvedCategoryName !== 'No Category' ? ` in category **${resolvedCategoryName}**` : ''}.`,
            color: 0x57F287,
            user: session.user,
            guild: clientGuild,
            client: discordClient
        });

        return res.status(201).json({
            success: true,
            hub: {
                hubChannelId: createdChannelId,
                guildId,
                categoryId: finalCategoryId || null,
                name: createdChannelName,
                categoryName: resolvedCategoryName,
                existsInDiscord: true
            }
        });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to save voice hub configuration' });
    }
});

app.delete('/api/guilds/:guildId/voice/hubs/:hubChannelId', async (req, res) => {
    const session = getSession(req);
    if (!session) {
        return res.status(401).json({ error: 'Unauthorized. Please login with Discord.' });
    }

    const { guildId, hubChannelId } = req.params;
    const targetGuild = (session.guilds || []).find(g => g.id === guildId);
    if (!targetGuild || !canManageGuild(targetGuild)) {
        return res.status(403).json({ error: 'You do not have permission to manage this server.' });
    }

    try {
        let hub = db.prepare('SELECT * FROM voice_hubs WHERE guildId = ? AND hubChannelId = ?').get(guildId, hubChannelId);
        if (!hub) {
            hub = db.prepare('SELECT * FROM voice_guilds WHERE guildId = ? AND hubChannelId = ?').get(guildId, hubChannelId);
        }

        const categoryId = hub?.categoryId;

        // Delete from database
        db.prepare('DELETE FROM voice_hubs WHERE guildId = ? AND hubChannelId = ?').run(guildId, hubChannelId);
        db.prepare('DELETE FROM voice_guilds WHERE guildId = ? AND hubChannelId = ?').run(guildId, hubChannelId);
        db.prepare('DELETE FROM voicemaster_guilds WHERE guildId = ? AND hubChannelId = ?').run(guildId, hubChannelId);

        // Delete from Discord if token is available
        const rawToken = process.env.DISCORD_TOKEN;
        const botToken = rawToken ? rawToken.trim().replace(/^["']|["']$/g, '') : '';
        if (botToken) {
            await fetch(`https://discord.com/api/v10/channels/${hubChannelId}`, {
                method: 'DELETE',
                headers: { Authorization: `Bot ${botToken}` }
            }).catch(() => {});

            if (categoryId) {
                await fetch(`https://discord.com/api/v10/channels/${categoryId}`, {
                    method: 'DELETE',
                    headers: { Authorization: `Bot ${botToken}` }
                }).catch(() => {});
            }
        }

        emitVoiceUpdate(guildId);

        res.json({ success: true, deletedHubId: hubChannelId });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete voice hub' });
    }
});

/* =========================================================
   Moderation Warnings Routes
   ========================================================= */

app.get('/api/guilds/:guildId/warnings', (req, res) => {
    const session = getSession(req);
    if (!session) {
        return res.status(401).json({ error: 'Unauthorized. Please login with Discord.' });
    }

    const { guildId } = req.params;
    const targetGuild = getUserGuilds(session).find(g => g.id === guildId);
    if (!targetGuild || !canManageGuild(targetGuild)) {
        return res.status(403).json({ error: 'You do not have permission to manage this server.' });
    }

    try {
        const rawPage = parseInt(String(req.query.page ?? '1'), 10);
        const page = Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 1;
        const rawLimit = parseInt(String(req.query.limit ?? '20'), 10);
        const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 20;
        const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
        const userIdFilter = typeof req.query.userId === 'string' ? req.query.userId.trim() : '';

        const rows = userIdFilter
            ? db.prepare('SELECT * FROM warnings WHERE guildId = ? AND userId = ? ORDER BY id DESC').all(guildId, userIdFilter)
            : db.prepare('SELECT * FROM warnings WHERE guildId = ? ORDER BY id DESC').all(guildId);

        const guild = discordClient?.guilds?.cache?.get?.(guildId) || null;
        const auditUserMap = new Map();
        try {
            const auditRows = db.prepare(`
                SELECT userId, username, userTag FROM audit_logs
                WHERE guildId = ? AND userId IS NOT NULL AND userId != ''
                ORDER BY timestamp DESC, id DESC
            `).all(guildId);
            for (const ar of auditRows) {
                if (auditUserMap.has(String(ar.userId))) continue;
                const candidate = (ar.username && ar.username !== 'System')
                    ? ar.username
                    : (ar.userTag && ar.userTag !== 'System' ? ar.userTag : null);
                if (candidate) {
                    const cleaned = String(candidate).trim().replace(/^@+/, '').replace(/#0$/, '').trim();
                    if (cleaned) {
                        auditUserMap.set(String(ar.userId), cleaned);
                    }
                }
            }
        } catch {}

        const resolveUsername = (id) => {
            if (!id) return null;
            const strId = String(id);
            const member = guild?.members?.cache?.get?.(strId);
            const memberName = member?.user?.username || member?.user?.tag || member?.user?.globalName || member?.displayName;
            if (memberName) {
                return String(memberName).replace(/^@+/, '').replace(/#0$/, '').trim() || null;
            }
            const cachedUser = discordClient?.users?.cache?.get?.(strId) || guild?.client?.users?.cache?.get?.(strId);
            const cachedName = cachedUser?.username || cachedUser?.tag || cachedUser?.globalName;
            if (cachedName) {
                return String(cachedName).replace(/^@+/, '').replace(/#0$/, '').trim() || null;
            }
            if (discordClient?.user && String(discordClient.user.id) === strId && discordClient.user.username) {
                return String(discordClient.user.username);
            }
            return auditUserMap.get(strId) || null;
        };

        const enriched = rows.map(w => ({
            id: w.id,
            guildId: w.guildId,
            userId: w.userId,
            username: resolveUsername(w.userId),
            moderatorId: w.moderatorId,
            moderatorName: resolveUsername(w.moderatorId),
            reason: w.reason ?? '',
            timestamp: w.timestamp
        }));

        const needle = search.toLowerCase();
        const filtered = needle
            ? enriched.filter(w => [
                String(w.id),
                w.userId || '',
                w.moderatorId || '',
                w.reason || '',
                w.username || '',
                w.moderatorName || ''
            ].some(field => String(field).toLowerCase().includes(needle)))
            : enriched;

        const total = filtered.length;
        const totalPages = Math.max(1, Math.ceil(total / limit));
        const offset = (page - 1) * limit;
        const pagedRows = filtered.slice(offset, offset + limit);

        res.json({
            warnings: pagedRows,
            total,
            page,
            limit,
            totalPages
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to retrieve moderation warnings' });
    }
});

app.delete('/api/guilds/:guildId/warnings/:warningId', (req, res) => {
    const session = getSession(req);
    if (!session) {
        return res.status(401).json({ error: 'Unauthorized. Please login with Discord.' });
    }

    const { guildId, warningId } = req.params;
    const targetGuild = getUserGuilds(session).find(g => g.id === guildId);
    if (!targetGuild || !canManageGuild(targetGuild)) {
        return res.status(403).json({ error: 'You do not have permission to manage this server.' });
    }

    try {
        const numericId = Number(warningId);
        if (!Number.isInteger(numericId) || numericId <= 0) {
            return res.status(404).json({ error: 'Warning not found' });
        }

        const existing = db.prepare('SELECT * FROM warnings WHERE id = ? AND guildId = ?').get(numericId, guildId);
        if (!existing) {
            return res.status(404).json({ error: 'Warning not found' });
        }

        db.prepare('DELETE FROM warnings WHERE id = ? AND guildId = ?').run(numericId, guildId);

        const guild = discordClient?.guilds?.cache?.get?.(guildId) || null;
        loggingService.recordAuditLog(guildId, {
            eventType: 'log_events_moderation',
            title: 'Warning Revoked',
            description: `Revoked warning **#${numericId}** for <@${existing.userId}>${existing.reason ? ` (Reason: ${existing.reason})` : ''}.`,
            color: 0xFEE75C,
            user: session.user,
            guild,
            client: discordClient
        });

        res.json({ success: true, deletedId: numericId });
    } catch (error) {
        res.status(500).json({ error: 'Failed to revoke warning' });
    }
});

/* =========================================================
   Economy Server Shop Routes
   ========================================================= */

function enrichShopItemRow(row, guildId, guild) {
    const purchaseRow = db.prepare(
        'SELECT COALESCE(SUM(quantity), 0) AS count FROM user_inventory WHERE guildId = ? AND itemId = ?'
    ).get(guildId, row.id);
    const purchaseCount = Number(purchaseRow?.count || 0);

    let roleName = null;
    let roleColor = null;
    if (row.roleId) {
        const role = guild?.roles?.cache?.get?.(row.roleId);
        if (role) {
            roleName = role.name || null;
            if (typeof role.hexColor === 'string' && role.hexColor !== '#000000') {
                roleColor = role.hexColor;
            } else if (typeof role.color === 'string' && role.color !== '#000000') {
                roleColor = role.color;
            } else if (typeof role.color === 'number' && role.color > 0) {
                roleColor = `#${role.color.toString(16).padStart(6, '0')}`;
            }
        }
    }

    return {
        id: row.id,
        guildId: row.guildId,
        name: row.name,
        description: row.description ?? '',
        price: Number(row.price),
        roleId: row.roleId || '',
        roleName,
        roleColor,
        stock: Number(row.stock),
        purchaseCount,
        createdAt: row.createdAt
    };
}

function parseShopInt(rawVal) {
    if (typeof rawVal === 'number') {
        return Number.isFinite(rawVal) && Number.isInteger(rawVal) ? rawVal : Number.NaN;
    }
    if (typeof rawVal === 'string' && rawVal.trim() !== '') {
        const num = Number(rawVal.trim());
        return Number.isFinite(num) && Number.isInteger(num) ? num : Number.NaN;
    }
    return Number.NaN;
}

app.get('/api/guilds/:guildId/shop', (req, res) => {
    const session = getSession(req);
    if (!session) {
        return res.status(401).json({ error: 'Unauthorized. Please login with Discord.' });
    }

    const { guildId } = req.params;
    const targetGuild = getUserGuilds(session).find(g => g.id === guildId);
    if (!targetGuild || !canManageGuild(targetGuild)) {
        return res.status(403).json({ error: 'You do not have permission to manage this server.' });
    }

    try {
        const guild = discordClient?.guilds?.cache?.get?.(guildId) || null;
        const rows = db.prepare('SELECT * FROM shop_items WHERE guildId = ? ORDER BY price ASC, id ASC').all(guildId);
        const items = rows.map(row => enrichShopItemRow(row, guildId, guild));
        res.json({ items });
    } catch (error) {
        res.status(500).json({ error: 'Failed to retrieve shop items' });
    }
});

app.post('/api/guilds/:guildId/shop', (req, res) => {
    const session = getSession(req);
    if (!session) {
        return res.status(401).json({ error: 'Unauthorized. Please login with Discord.' });
    }

    const { guildId } = req.params;
    const targetGuild = getUserGuilds(session).find(g => g.id === guildId);
    if (!targetGuild || !canManageGuild(targetGuild)) {
        return res.status(403).json({ error: 'You do not have permission to manage this server.' });
    }

    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return res.status(400).json({ error: 'Request body must be a JSON object.' });
    }

    if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 100) {
        return res.status(400).json({ error: 'Item name is required and must be 1-100 characters.' });
    }
    const cleanName = body.name.trim();

    if (body.description !== undefined && body.description !== null && typeof body.description !== 'string') {
        return res.status(400).json({ error: 'Description must be a string.' });
    }
    const cleanDescription = typeof body.description === 'string' ? body.description.trim() : '';
    if (cleanDescription.length > 500) {
        return res.status(400).json({ error: 'Description must be 500 characters or fewer.' });
    }

    const cleanPrice = parseShopInt(body.price);
    if (Number.isNaN(cleanPrice) || cleanPrice < 0) {
        return res.status(400).json({ error: 'Price must be an integer >= 0.' });
    }

    if (body.roleId !== undefined && body.roleId !== null && typeof body.roleId !== 'string') {
        return res.status(400).json({ error: 'roleId must be a string.' });
    }
    const cleanRoleId = typeof body.roleId === 'string'
        ? body.roleId.replace(/^["']|["']$/g, '').trim()
        : '';

    let cleanStock = -1;
    if (body.stock !== undefined && body.stock !== null && body.stock !== '') {
        cleanStock = parseShopInt(body.stock);
        if (Number.isNaN(cleanStock) || cleanStock < -1) {
            return res.status(400).json({ error: 'Stock must be an integer >= -1.' });
        }
    }

    try {
        const createdAt = Date.now();
        const info = db.prepare(`
            INSERT INTO shop_items (guildId, name, description, price, roleId, stock, createdAt)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(guildId, cleanName, cleanDescription, cleanPrice, cleanRoleId, cleanStock, createdAt);

        const guild = discordClient?.guilds?.cache?.get?.(guildId) || null;
        const insertedRow = db.prepare('SELECT * FROM shop_items WHERE id = ? AND guildId = ?').get(Number(info.lastInsertRowid), guildId);
        const item = enrichShopItemRow(insertedRow, guildId, guild);

        loggingService.recordAuditLog(guildId, {
            eventType: 'log_events_dashboard',
            title: 'Shop Item Created',
            description: `Added shop item **${cleanName}** for **${cleanPrice}** coins${cleanRoleId ? ` (Role: <@&${cleanRoleId}>)` : ''}.`,
            color: 0xF1C40F,
            user: session.user,
            guild,
            client: discordClient
        });

        res.status(201).json({ success: true, item });
    } catch (error) {
        res.status(500).json({ error: 'Failed to create shop item' });
    }
});

app.put('/api/guilds/:guildId/shop/:itemId', (req, res) => {
    const session = getSession(req);
    if (!session) {
        return res.status(401).json({ error: 'Unauthorized. Please login with Discord.' });
    }

    const { guildId, itemId } = req.params;
    const targetGuild = getUserGuilds(session).find(g => g.id === guildId);
    if (!targetGuild || !canManageGuild(targetGuild)) {
        return res.status(403).json({ error: 'You do not have permission to manage this server.' });
    }

    const numericId = Number(itemId);
    if (!Number.isInteger(numericId) || numericId <= 0) {
        return res.status(404).json({ error: 'Shop item not found' });
    }

    const existing = db.prepare('SELECT * FROM shop_items WHERE id = ? AND guildId = ?').get(numericId, guildId);
    if (!existing) {
        return res.status(404).json({ error: 'Shop item not found' });
    }

    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return res.status(400).json({ error: 'Request body must be a JSON object.' });
    }

    let nextName = existing.name;
    if (body.name !== undefined) {
        if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 100) {
            return res.status(400).json({ error: 'Item name must be 1-100 characters.' });
        }
        nextName = body.name.trim();
    }

    let nextDescription = existing.description ?? '';
    if (body.description !== undefined) {
        if (body.description !== null && typeof body.description !== 'string') {
            return res.status(400).json({ error: 'Description must be a string.' });
        }
        nextDescription = typeof body.description === 'string' ? body.description.trim() : '';
        if (nextDescription.length > 500) {
            return res.status(400).json({ error: 'Description must be 500 characters or fewer.' });
        }
    }

    let nextPrice = Number(existing.price);
    if (body.price !== undefined) {
        nextPrice = parseShopInt(body.price);
        if (Number.isNaN(nextPrice) || nextPrice < 0) {
            return res.status(400).json({ error: 'Price must be an integer >= 0.' });
        }
    }

    let nextRoleId = existing.roleId || '';
    if (body.roleId !== undefined) {
        if (body.roleId !== null && typeof body.roleId !== 'string') {
            return res.status(400).json({ error: 'roleId must be a string.' });
        }
        nextRoleId = typeof body.roleId === 'string'
            ? body.roleId.replace(/^["']|["']$/g, '').trim()
            : '';
    }

    let nextStock = Number(existing.stock);
    if (body.stock !== undefined) {
        if (body.stock === null || body.stock === '') {
            nextStock = -1;
        } else {
            nextStock = parseShopInt(body.stock);
            if (Number.isNaN(nextStock) || nextStock < -1) {
                return res.status(400).json({ error: 'Stock must be an integer >= -1.' });
            }
        }
    }

    try {
        db.prepare(`
            UPDATE shop_items
            SET name = ?, description = ?, price = ?, roleId = ?, stock = ?
            WHERE id = ? AND guildId = ?
        `).run(nextName, nextDescription, nextPrice, nextRoleId, nextStock, numericId, guildId);

        const guild = discordClient?.guilds?.cache?.get?.(guildId) || null;
        const updatedRow = db.prepare('SELECT * FROM shop_items WHERE id = ? AND guildId = ?').get(numericId, guildId);
        const item = enrichShopItemRow(updatedRow, guildId, guild);

        loggingService.recordAuditLog(guildId, {
            eventType: 'log_events_dashboard',
            title: 'Shop Item Updated',
            description: `Updated shop item **${nextName}** (#${numericId}) — **${nextPrice}** coins.`,
            color: 0xF1C40F,
            user: session.user,
            guild,
            client: discordClient
        });

        res.json({ success: true, item });
    } catch (error) {
        res.status(500).json({ error: 'Failed to update shop item' });
    }
});

app.delete('/api/guilds/:guildId/shop/:itemId', (req, res) => {
    const session = getSession(req);
    if (!session) {
        return res.status(401).json({ error: 'Unauthorized. Please login with Discord.' });
    }

    const { guildId, itemId } = req.params;
    const targetGuild = getUserGuilds(session).find(g => g.id === guildId);
    if (!targetGuild || !canManageGuild(targetGuild)) {
        return res.status(403).json({ error: 'You do not have permission to manage this server.' });
    }

    const numericId = Number(itemId);
    if (!Number.isInteger(numericId) || numericId <= 0) {
        return res.status(404).json({ error: 'Shop item not found' });
    }

    const existing = db.prepare('SELECT * FROM shop_items WHERE id = ? AND guildId = ?').get(numericId, guildId);
    if (!existing) {
        return res.status(404).json({ error: 'Shop item not found' });
    }

    try {
        const deleteTx = db.transaction(() => {
            db.prepare('DELETE FROM user_inventory WHERE guildId = ? AND itemId = ?').run(guildId, numericId);
            db.prepare('DELETE FROM shop_items WHERE id = ? AND guildId = ?').run(numericId, guildId);
        });
        deleteTx();

        const guild = discordClient?.guilds?.cache?.get?.(guildId) || null;
        loggingService.recordAuditLog(guildId, {
            eventType: 'log_events_dashboard',
            title: 'Shop Item Deleted',
            description: `Removed shop item **${existing.name}** (#${numericId}) from the server shop.`,
            color: 0xED4245,
            user: session.user,
            guild,
            client: discordClient
        });

        res.json({ success: true, deletedId: numericId });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete shop item' });
    }
});

app.get('/api/guilds/:guildId/roles', async (req, res) => {
    const session = getSession(req);
    if (!session) {
        return res.status(401).json({ error: 'Unauthorized. Please login with Discord.' });
    }

    const { guildId } = req.params;
    const targetGuild = getUserGuilds(session).find(g => g.id === guildId);
    if (!targetGuild || !canManageGuild(targetGuild)) {
        return res.status(403).json({ error: 'You do not have permission to manage this server.' });
    }

    // 1. Live Discord client in-memory resolution (instant & reliable)
    if (discordClient) {
        try {
            const guild = discordClient.guilds.cache.get(guildId) || await discordClient.guilds.fetch(guildId).catch(() => null);
            if (guild) {
                const roles = await guild.roles.fetch().catch(() => guild.roles.cache);
                const roleList = Array.from(roles.values())
                    .filter(r => r.id !== guildId && !r.managed)
                    .sort((a, b) => b.position - a.position)
                    .map(r => ({
                        id: r.id,
                        name: r.name,
                        color: r.hexColor !== '#000000' ? r.hexColor : null,
                        position: r.position
                    }));
                return res.json({ roles: roleList });
            }
        } catch (err) {}
    }

    // 2. Fallback to Discord REST API with sanitized token
    const rawToken = process.env.DISCORD_TOKEN;
    const botToken = rawToken ? rawToken.trim().replace(/^["']|["']$/g, '') : '';
    if (!botToken) {
        return res.json({ roles: [] });
    }

    try {
        const discordRes = await fetch(`https://discord.com/api/v10/guilds/${guildId}/roles`, {
            headers: {
                Authorization: `Bot ${botToken}`
            }
        });

        if (discordRes.ok) {
            const data = await discordRes.json();
            const roles = data
                .filter(r => r.id !== guildId && !r.managed)
                .sort((a, b) => b.position - a.position)
                .map(r => ({
                    id: r.id,
                    name: r.name,
                    color: r.color ? `#${r.color.toString(16).padStart(6, '0')}` : null,
                    position: r.position
                }));
            return res.json({ roles });
        } else {
            return res.json({ roles: [] });
        }
    } catch (err) {
        return res.json({ roles: [] });
    }
});

/* =========================================================
   Disaster Recovery SQLite Backup Routes
   ========================================================= */

function requireBackupAdmin(req, res) {
    const session = getSession(req);
    if (!session) {
        res.status(401).json({ error: 'Unauthorized. Please login with Discord.' });
        return null;
    }
    if (!getUserGuilds(session).some(canManageGuild)) {
        res.status(403).json({ error: 'You do not have permission to manage database backups.' });
        return null;
    }
    return session;
}

app.get('/api/backups', (req, res) => {
    if (!requireBackupAdmin(req, res)) return;
    try {
        res.json({ backups: listDatabaseBackups() });
    } catch (error) {
        res.status(500).json({ error: 'Failed to list database backups' });
    }
});

app.post('/api/backups', async (req, res) => {
    if (!requireBackupAdmin(req, res)) return;
    try {
        const backup = await createDatabaseBackup();
        res.status(201).json({ success: true, backup });
    } catch (error) {
        res.status(500).json({ error: 'Failed to create database backup' });
    }
});

app.get('/api/backups/export', async (req, res) => {
    if (!requireBackupAdmin(req, res)) return;
    try {
        const exported = await exportCompressedBackup();
        res.setHeader('Content-Type', 'application/gzip');
        res.setHeader('Content-Disposition', `attachment; filename="${exported.filename}"`);
        res.send(exported.buffer);
    } catch (error) {
        res.status(500).json({ error: 'Failed to export database backup' });
    }
});

app.get('/api/backups/:filename/download', (req, res) => {
    if (!requireBackupAdmin(req, res)) return;
    const { filename } = req.params;
    if (!isValidBackupFilename(filename)) {
        return res.status(400).json({ error: 'Invalid backup filename.' });
    }
    const filePath = resolveBackupFilePath(filename);
    if (!filePath) {
        return res.status(404).json({ error: 'Backup file not found.' });
    }
    try {
        const buffer = fs.readFileSync(filePath);
        res.setHeader('Content-Type', 'application/gzip');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(buffer);
    } catch (error) {
        res.status(500).json({ error: 'Failed to download backup file' });
    }
});

app.delete('/api/backups/:filename', (req, res) => {
    if (!requireBackupAdmin(req, res)) return;
    const { filename } = req.params;
    if (!isValidBackupFilename(filename)) {
        return res.status(400).json({ error: 'Invalid backup filename.' });
    }
    const deleted = deleteDatabaseBackup(filename);
    if (!deleted) {
        return res.status(404).json({ error: 'Backup file not found.' });
    }
    res.json({ success: true, deleted: filename });
});

/* =========================================================
   Global Stats and Settings Routes
   ========================================================= */

app.get('/api/stats', async (req, res) => {
    try {
        const userCount = db.prepare('SELECT COUNT(*) as count FROM xp').get().count;
        const session = getSession(req);
        const botGuilds = await getBotGuilds();
        const botGuildIdSet = new Set((botGuilds || []).map(g => g.id));

        let guildCount = 0;
        if (session) {
            const manageable = getUserGuilds(session).filter(canManageGuild);
            guildCount = manageable.filter(g => botGuildIdSet.has(g.id) || Boolean(g.botPresent)).length;
        } else {
            guildCount = botGuildIdSet.size;
        }

        res.json({
            userCount,
            guildCount,
            status: 'online'
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch stats' });
    }
});

app.get('/api/settings', (req, res) => {
    try {
        const current = SettingsManager.getAll();
        res.json({ ...DEFAULT_GLOBAL_SETTINGS, ...current });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch settings' });
    }
});

app.post('/api/settings', (req, res) => {
    try {
        const payload = req.body;
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
            return res.status(400).json({ error: 'Request body must be a JSON object' });
        }

        const updates = 'key' in payload && 'value' in payload
            ? { [payload.key]: payload.value }
            : payload;

        for (const [key, val] of Object.entries(updates)) {
            if (!SettingsManager.validate(key, val, updates)) {
                return res.status(400).json({ error: `Validation failed for setting "${key}": ${JSON.stringify(val)}` });
            }
        }

        for (const [key, val] of Object.entries(updates)) {
            SettingsManager.setJson(key, val);
        }

        const updatedSettings = { ...DEFAULT_GLOBAL_SETTINGS, ...SettingsManager.getAll() };
        res.json({ success: true, settings: updatedSettings });
    } catch (error) {
        res.status(500).json({ error: error.message || 'Failed to update settings' });
    }
});

export function startDashboard(clientOrPort = null, port = PORT) {
    if (typeof clientOrPort === 'number' || typeof clientOrPort === 'string') {
        port = clientOrPort;
    } else if (clientOrPort) {
        discordClient = clientOrPort;
    }

    return app.listen(port, () => {
        console.log(`Dashboard running at http://localhost:${port}`);
    });
}

export { app };

if (process.env.NODE_ENV !== 'test' && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    startDashboard();
}
