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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Ensure .env is loaded from the project root regardless of the current working directory
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

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
                cleanMap[String(subKey)] = typeof roleVal === 'string'
                    ? roleVal.replace(/^["']|["']$/g, '').trim()
                    : roleVal;
            }
            sanitized[key] = cleanMap;
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

        res.setHeader('Content-Disposition', `attachment; filename="sugoibot-settings-${guildId}.json"`);
        res.json({
            version: 1,
            exportedAt: new Date().toISOString(),
            guildId,
            settings,
            gamerole_whitelist,
            gameroleWhitelist: gamerole_whitelist,
            voice_hubs,
            voiceHubs: voice_hubs
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
            'voiceHubs'
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

    const sanitizedSettings = sanitizeSettingsPayload(rawSettings);
    const hasSettings = Object.keys(sanitizedSettings).length > 0;
    const hasWhitelist = Array.isArray(rawWhitelist);
    const hasVoiceHubs = Array.isArray(rawVoiceHubs);

    if (!hasSettings && !hasWhitelist && !hasVoiceHubs) {
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
        });

        importTx();

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

        res.json({
            success: true,
            guildId,
            settings: updatedSettings,
            gamerole_whitelist: updatedWhitelist,
            gameroleWhitelist: updatedWhitelist,
            voice_hubs: updatedHubs,
            voiceHubs: updatedHubs
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

        const logs = loggingService.getAuditLogs(guildId, { limit, eventType, search });
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
            res.write(`data: ${JSON.stringify(entry)}\n\n`);
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
        let hubs = db.prepare('SELECT * FROM voice_hubs WHERE guildId = ?').all(guildId);
        if (!hubs || hubs.length === 0) {
            hubs = db.prepare('SELECT * FROM voice_guilds WHERE guildId = ?').all(guildId);
        }

        const activeRooms = db.prepare('SELECT * FROM voice_channels WHERE guildId = ?').all(guildId);

        let discordChannels = [];
        if (process.env.DISCORD_TOKEN) {
            try {
                const cRes = await fetch(`https://discord.com/api/v10/guilds/${guildId}/channels`, {
                    headers: { Authorization: `Bot ${process.env.DISCORD_TOKEN}` }
                });
                if (cRes.ok) discordChannels = await cRes.json();
            } catch {}
        }

        const channelMap = new Map(discordChannels.map(c => [c.id, c]));

        const enrichedHubs = (hubs || []).map(h => {
            const ch = channelMap.get(h.hubChannelId);
            let cat = h.categoryId ? channelMap.get(h.categoryId) : null;
            if (!cat && ch?.parent_id) {
                cat = channelMap.get(ch.parent_id);
            }

            let catDisplayName = 'No Category';
            if (cat?.name) {
                catDisplayName = cat.name;
            } else if (h.categoryId && discordChannels.length > 0 && !channelMap.has(h.categoryId)) {
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
            const ch = channelMap.get(r.channelId);
            return {
                channelId: r.channelId,
                ownerId: r.ownerId,
                name: ch ? ch.name : `Room (${r.channelId})`,
                userLimit: ch ? ch.user_limit : 0,
                createdAt: r.createdAt
            };
        });

        res.json({
            hubs: enrichedHubs,
            activeRooms: enrichedRooms
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to retrieve voice status' });
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
        if (process.env.DISCORD_TOKEN) {
            await fetch(`https://discord.com/api/v10/channels/${hubChannelId}`, {
                method: 'DELETE',
                headers: { Authorization: `Bot ${process.env.DISCORD_TOKEN}` }
            }).catch(() => {});

            if (categoryId) {
                await fetch(`https://discord.com/api/v10/channels/${categoryId}`, {
                    method: 'DELETE',
                    headers: { Authorization: `Bot ${process.env.DISCORD_TOKEN}` }
                }).catch(() => {});
            }
        }

        res.json({ success: true, deletedHubId: hubChannelId });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete voice hub' });
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
