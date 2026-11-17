import { describe, it, expect, beforeEach } from 'vitest';
import { app, setDiscordClient, setBotGuildsCache, clearBotGuildsCache } from '../dashboard/server.js';
import { loggingService } from '../lib/bot/loggingService.js';
import db from '../lib/database.js';

describe('Dashboard API', () => {
    let server;
    let baseUrl;

    beforeEach(async () => {
        // Start an ephemeral listener for test requests
        await new Promise((resolve) => {
            server = app.listen(0, () => {
                const port = server.address().port;
                baseUrl = `http://127.0.0.1:${port}`;
                resolve();
            });
        });

        return () => {
            if (server) server.close();
        };
    });

    it('GET /api/stats returns bot statistics', async () => {
        const res = await fetch(`${baseUrl}/api/stats`);
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data).toHaveProperty('userCount');
        expect(data).toHaveProperty('guildCount');
        expect(data.status).toBe('online');
    });

    it('GET /api/settings returns settings with defaults', async () => {
        const res = await fetch(`${baseUrl}/api/settings`);
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data).toHaveProperty('xp_enabled');
        expect(data).toHaveProperty('xp_min');
        expect(data).toHaveProperty('xp_max');
        expect(data).toHaveProperty('xp_voice_per_minute');
        expect(data).toHaveProperty('daily_amount');
    });

    it('POST /api/settings updates settings when valid', async () => {
        const payload = {
            xp_min: 12,
            xp_max: 25,
            xp_voice_per_minute: 8
        };

        const res = await fetch(`${baseUrl}/api/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.success).toBe(true);
        expect(data.settings.xp_min).toBe(12);
        expect(data.settings.xp_max).toBe(25);
        expect(data.settings.xp_voice_per_minute).toBe(8);
    });

    it('POST /api/settings returns 400 when invalid', async () => {
        // xp_min > xp_max is invalid
        const payload = {
            xp_min: 999
        };

        const res = await fetch(`${baseUrl}/api/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data).toHaveProperty('error');
    });

    describe('Authentication and Guild Settings', () => {
        it('GET /api/auth/me returns null user when unauthenticated', async () => {
            const res = await fetch(`${baseUrl}/api/auth/me`);
            expect(res.status).toBe(200);
            const data = await res.json();
            expect(data.user).toBeNull();
        });

        it('GET /api/guilds returns 401 when unauthenticated', async () => {
            const res = await fetch(`${baseUrl}/api/guilds`);
            expect(res.status).toBe(401);
        });

        it('login via dev-login establishes session and lists manageable guilds', async () => {
            const loginRes = await fetch(`${baseUrl}/api/auth/dev-login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    user: { id: 'user_456', username: 'GuildAdmin', avatar: null },
                    guilds: [
                        { id: 'guild_manageable', name: 'My Server', permissions: '32', owner: false }, // 0x20 Manage Guild
                        { id: 'guild_unmanageable', name: 'Other Server', permissions: '0', owner: false }
                    ]
                })
            });

            expect(loginRes.status).toBe(200);
            const cookieHeader = loginRes.headers.get('set-cookie');
            expect(cookieHeader).toContain('sugoi_session=');

            // Test /api/auth/me with cookie
            const meRes = await fetch(`${baseUrl}/api/auth/me`, {
                headers: { Cookie: cookieHeader }
            });
            const meData = await meRes.json();
            expect(meData.user.username).toBe('GuildAdmin');

            // Test /api/guilds with cookie
            const guildsRes = await fetch(`${baseUrl}/api/guilds`, {
                headers: { Cookie: cookieHeader }
            });
            expect(guildsRes.status).toBe(200);
            const guildsData = await guildsRes.json();
            expect(guildsData.guilds.length).toBe(1);
            expect(guildsData.guilds[0].id).toBe('guild_manageable');
            expect(guildsData.guilds[0].name).toBe('My Server');
        });

        it('GET and POST /api/guilds/:guildId/settings updates per-server configuration', async () => {
            const testGuildId = 'server_test_' + Date.now();
            const loginRes = await fetch(`${baseUrl}/api/auth/dev-login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    user: { id: 'admin_1', username: 'ServerOwner' },
                    guilds: [
                        { id: testGuildId, name: 'Main Hub', owner: true }
                    ]
                })
            });
            const cookieHeader = loginRes.headers.get('set-cookie');

            // Access unauthorized server returns 403
            const forbiddenRes = await fetch(`${baseUrl}/api/guilds/unauthorized_server/settings`, {
                headers: { Cookie: cookieHeader }
            });
            expect(forbiddenRes.status).toBe(403);

            // Fetch default settings for test guild
            const getRes = await fetch(`${baseUrl}/api/guilds/${testGuildId}/settings`, {
                headers: { Cookie: cookieHeader }
            });
            expect(getRes.status).toBe(200);
            const getData = await getRes.json();
            expect(getData.settings.log_events_member_join).toBe(true);
            expect(getData.settings.module_general_enabled).toBe(true);
            expect(getData.settings.module_economy_enabled).toBe(true);
            expect(getData.settings.module_voice_enabled).toBe(true);

            // Update guild logging and module settings
            const postRes = await fetch(`${baseUrl}/api/guilds/${testGuildId}/settings`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Cookie: cookieHeader
                },
                body: JSON.stringify({
                    log_channel_id: '987654321',
                    xp_channel_id: '123456789',
                    log_events_member_join: true,
                    log_events_voice: true,
                    module_economy_enabled: false,
                    module_voice_enabled: false
                })
            });
            expect(postRes.status).toBe(200);
            const postData = await postRes.json();
            expect(postData.settings.log_channel_id).toBe('987654321');
            expect(postData.settings.xp_channel_id).toBe('123456789');
            expect(postData.settings.log_events_voice).toBe(true);
            expect(postData.settings.module_economy_enabled).toBe(false);
            expect(postData.settings.module_voice_enabled).toBe(false);

            // Test GET /api/guilds/:guildId/channels
            const channelsRes = await fetch(`${baseUrl}/api/guilds/${testGuildId}/channels`, {
                headers: { Cookie: cookieHeader }
            });
            expect(channelsRes.status).toBe(200);
            const channelsData = await channelsRes.json();
            expect(channelsData).toHaveProperty('channels');

            // Test GET /api/guilds/:guildId/roles
            const rolesRes = await fetch(`${baseUrl}/api/guilds/${testGuildId}/roles`, {
                headers: { Cookie: cookieHeader }
            });
            expect(rolesRes.status).toBe(200);
            const rolesData = await rolesRes.json();
            expect(rolesData).toHaveProperty('roles');

            // Test DELETE /api/guilds/:guildId/voice/hubs/:hubChannelId
            const delHubRes = await fetch(`${baseUrl}/api/guilds/${testGuildId}/voice/hubs/testHub999`, {
                method: 'DELETE',
                headers: { Cookie: cookieHeader }
            });
            expect(delHubRes.status).toBe(200);
            const delHubData = await delHubRes.json();
            expect(delHubData.success).toBe(true);
        });

        it('GET /api/modules discovers all modules and their metadata', async () => {
            const res = await fetch(`${baseUrl}/api/modules`);
            expect(res.status).toBe(200);
            const data = await res.json();
            expect(data.modules.length).toBeGreaterThan(0);
            expect(data.modules.some(m => m.id === 'xp')).toBe(true);
            expect(data.modules.some(m => m.id === 'voice')).toBe(true);
        });

        it('GET /api/commands discovers all commands across modules', async () => {
            const res = await fetch(`${baseUrl}/api/commands`);
            expect(res.status).toBe(200);
            const data = await res.json();
            expect(data.commands.length).toBeGreaterThan(0);
            expect(data.commands.some(c => c.name === 'ping')).toBe(true);
            expect(data.commands.some(c => c.name === 'userinfo')).toBe(true);
            expect(data.commands.some(c => c.name === 'cmdperm')).toBe(true);

            const voiceCmd = data.commands.find(c => c.name === 'voice');
            expect(voiceCmd).toBeDefined();
            expect(voiceCmd.subcommands).toBeInstanceOf(Array);
            expect(voiceCmd.subcommands.length).toBeGreaterThan(0);
        });

        it('R1: GET /api/stats returns accurate active guild count for logged-in user and does not default to 1 from warnings', async () => {
            clearBotGuildsCache();
            setDiscordClient(null);

            // Seed a warning row to prove /api/stats does not count warnings
            db.prepare('INSERT INTO warnings (userId, guildId, reason, moderatorId) VALUES (?, ?, ?, ?)').run(
                'warned_user',
                'unrelated_warning_guild_' + Date.now(),
                'Test warning',
                'mod_1'
            );

            // Configure bot as present in guild_a, guild_b, and guild_unmanageable
            setBotGuildsCache([
                { id: 'guild_a', name: 'Alpha Server', icon: null },
                { id: 'guild_b', name: 'Beta Server', icon: null },
                { id: 'guild_unmanageable', name: 'Locked Server', icon: null }
            ]);

            const loginRes = await fetch(`${baseUrl}/api/auth/dev-login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    user: { id: 'r1_user', username: 'MultiServerAdmin' },
                    guilds: [
                        { id: 'guild_a', name: 'Alpha Server', owner: true },
                        { id: 'guild_b', name: 'Beta Server', permissions: '32', owner: false }, // MANAGE_GUILD (0x20)
                        { id: 'guild_c_no_bot', name: 'Gamma Server', permissions: '8', owner: false }, // ADMINISTRATOR (0x8), bot not in server
                        { id: 'guild_unmanageable', name: 'Locked Server', permissions: '0', owner: false } // Not manageable
                    ]
                })
            });
            const cookie = loginRes.headers.get('set-cookie');

            // Logged-in user can manage 3 servers (guild_a, guild_b, guild_c_no_bot), and bot is in 2 of them (guild_a, guild_b)
            const statsRes = await fetch(`${baseUrl}/api/stats`, {
                headers: { Cookie: cookie }
            });
            expect(statsRes.status).toBe(200);
            const statsData = await statsRes.json();
            expect(statsData.guildCount).toBe(2);

            // Also verify live discordClient.guilds.cache takes precedence when attached
            setDiscordClient({
                guilds: {
                    cache: new Map([
                        ['guild_a', { id: 'guild_a', name: 'Alpha Server', icon: null }]
                    ])
                }
            });
            const statsClientRes = await fetch(`${baseUrl}/api/stats`, {
                headers: { Cookie: cookie }
            });
            const statsClientData = await statsClientRes.json();
            expect(statsClientData.guildCount).toBe(1);

            // When bot is in 0 of the user's manageable servers, guildCount must be 0 (not 1)
            setDiscordClient(null);
            setBotGuildsCache([{ id: 'some_other_guild', name: 'Other', icon: null }]);
            const zeroStatsRes = await fetch(`${baseUrl}/api/stats`, {
                headers: { Cookie: cookie }
            });
            const zeroStatsData = await zeroStatsRes.json();
            expect(zeroStatsData.guildCount).toBe(0);

            clearBotGuildsCache();
        });

        it('R2: GET /settings/export and POST /settings/import backup and atomically restore complete server configuration', async () => {
            const sourceGuildId = 'export_guild_' + Date.now();
            const targetGuildId = 'import_guild_' + Date.now();

            // Unauthenticated requests return 401
            const unauthExport = await fetch(`${baseUrl}/api/guilds/${sourceGuildId}/settings/export`);
            expect(unauthExport.status).toBe(401);
            const unauthImport = await fetch(`${baseUrl}/api/guilds/${targetGuildId}/settings/import`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ settings: { xp_min: 10 } })
            });
            expect(unauthImport.status).toBe(401);

            const loginRes = await fetch(`${baseUrl}/api/auth/dev-login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    user: { id: 'r2_admin', username: 'ConfigAdmin' },
                    guilds: [
                        { id: sourceGuildId, name: 'Source Server', owner: true },
                        { id: targetGuildId, name: 'Target Server', owner: true },
                        { id: 'no_perm_guild', name: 'Viewer Server', permissions: '0', owner: false }
                    ]
                })
            });
            const cookie = loginRes.headers.get('set-cookie');

            // Unauthorized server returns 403
            const forbiddenExport = await fetch(`${baseUrl}/api/guilds/no_perm_guild/settings/export`, {
                headers: { Cookie: cookie }
            });
            expect(forbiddenExport.status).toBe(403);
            const forbiddenImport = await fetch(`${baseUrl}/api/guilds/no_perm_guild/settings/import`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Cookie: cookie },
                body: JSON.stringify({ settings: { xp_min: 10 } })
            });
            expect(forbiddenImport.status).toBe(403);

            // Seed source guild settings, gamerole_whitelist, and voice_hubs
            await fetch(`${baseUrl}/api/guilds/${sourceGuildId}/settings`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Cookie: cookie },
                body: JSON.stringify({
                    xp_min: 25,
                    xp_max: 55,
                    module_economy_enabled: false,
                    gamerole_prefix: 'GAMING ',
                    log_channel_id: '"111222333444555666"',
                    role_rewards: { '5': '"999888777666555444"' }
                })
            });
            db.prepare('INSERT OR REPLACE INTO gamerole_whitelist (guildId, gameName, roleName) VALUES (?, ?, ?)').run(
                sourceGuildId,
                'Elden Ring',
                'Tarnished'
            );
            db.prepare('INSERT OR REPLACE INTO voice_hubs (hubChannelId, guildId, categoryId) VALUES (?, ?, ?)').run(
                'hub_' + sourceGuildId,
                sourceGuildId,
                'cat_' + sourceGuildId
            );

            // Export configuration from sourceGuildId
            const exportRes = await fetch(`${baseUrl}/api/guilds/${sourceGuildId}/settings/export`, {
                headers: { Cookie: cookie }
            });
            expect(exportRes.status).toBe(200);
            expect(exportRes.headers.get('content-disposition')).toContain(`sugoibot-settings-${sourceGuildId}.json`);
            const exportedBundle = await exportRes.json();
            expect(exportedBundle.version).toBe(1);
            expect(exportedBundle.guildId).toBe(sourceGuildId);
            expect(exportedBundle.settings.xp_min).toBe(25);
            expect(exportedBundle.settings.xp_max).toBe(55);
            expect(exportedBundle.settings.log_channel_id).toBe('111222333444555666');
            expect(exportedBundle.settings.role_rewards).toEqual({ '5': '999888777666555444' });
            expect(exportedBundle.gamerole_whitelist).toEqual([{ gameName: 'Elden Ring', roleName: 'Tarnished' }]);
            expect(exportedBundle.voice_hubs).toEqual([{ hubChannelId: 'hub_' + sourceGuildId, categoryId: 'cat_' + sourceGuildId }]);

            // Import exported bundle into targetGuildId (with a unique hubChannelId for targetGuildId)
            const importPayload = {
                ...exportedBundle,
                settings: {
                    ...exportedBundle.settings,
                    log_channel_id: '"777888999000111222"'
                },
                voice_hubs: [{ hubChannelId: '"hub_' + targetGuildId + '"', categoryId: '"cat_' + targetGuildId + '"' }]
            };
            const importRes = await fetch(`${baseUrl}/api/guilds/${targetGuildId}/settings/import`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Cookie: cookie },
                body: JSON.stringify(importPayload)
            });
            expect(importRes.status).toBe(200);
            const importData = await importRes.json();
            expect(importData.success).toBe(true);
            expect(importData.settings.xp_min).toBe(25);
            expect(importData.settings.xp_max).toBe(55);
            expect(importData.settings.module_economy_enabled).toBe(false);
            expect(importData.settings.gamerole_prefix).toBe('GAMING ');
            expect(importData.settings.log_channel_id).toBe('777888999000111222');
            expect(importData.gamerole_whitelist).toEqual([{ gameName: 'Elden Ring', roleName: 'Tarnished' }]);
            expect(importData.voice_hubs).toEqual([{ hubChannelId: 'hub_' + targetGuildId, categoryId: 'cat_' + targetGuildId }]);

            // Verify invalid import payload returns 400 and does not corrupt existing settings
            const badImportRes = await fetch(`${baseUrl}/api/guilds/${targetGuildId}/settings/import`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Cookie: cookie },
                body: JSON.stringify({
                    settings: {
                        xp_min: 100,
                        xp_max: 20
                    }
                })
            });
            expect(badImportRes.status).toBe(400);

            const verifyAfterBad = await fetch(`${baseUrl}/api/guilds/${targetGuildId}/settings`, {
                headers: { Cookie: cookie }
            });
            const verifyData = await verifyAfterBad.json();
            expect(verifyData.settings.xp_min).toBe(25);
            expect(verifyData.settings.xp_max).toBe(55);
        });

        it('R3: GET /audit-logs and GET /audit-logs/stream provide filtered history and real-time SSE streaming', async () => {
            const auditGuildId = 'stream_guild_' + Date.now();

            // Unauthenticated requests return 401
            const unauthLogs = await fetch(`${baseUrl}/api/guilds/${auditGuildId}/audit-logs`);
            expect(unauthLogs.status).toBe(401);
            const unauthStream = await fetch(`${baseUrl}/api/guilds/${auditGuildId}/audit-logs/stream`);
            expect(unauthStream.status).toBe(401);

            const loginRes = await fetch(`${baseUrl}/api/auth/dev-login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    user: { id: 'r3_admin', username: 'AuditAdmin' },
                    guilds: [
                        { id: auditGuildId, name: 'Audit Server', owner: true }
                    ]
                })
            });
            const cookie = loginRes.headers.get('set-cookie');

            // Seed two audit log entries
            loggingService.recordAuditLog(auditGuildId, {
                title: 'Member Joined',
                description: 'NewUser#1234 joined using invite code abc123',
                eventType: 'log_events_member_join',
                color: 0x23A55A,
                user: { id: 'u_join_1', username: 'NewUser' }
            });
            loggingService.recordAuditLog(auditGuildId, {
                title: 'Member Warned',
                description: 'Warned RuleBreaker for link spam',
                eventType: 'log_events_moderation',
                color: 0xFEE75C,
                user: { id: 'u_mod_1', username: 'Moderator' }
            });

            // Fetch all audit logs
            const logsRes = await fetch(`${baseUrl}/api/guilds/${auditGuildId}/audit-logs`, {
                headers: { Cookie: cookie }
            });
            expect(logsRes.status).toBe(200);
            const logsData = await logsRes.json();
            expect(logsData.guildId).toBe(auditGuildId);
            expect(logsData.logs.length).toBe(2);

            // Filter by eventType and search
            const filteredRes = await fetch(`${baseUrl}/api/guilds/${auditGuildId}/audit-logs?eventType=log_events_moderation&search=link%20spam`, {
                headers: { Cookie: cookie }
            });
            expect(filteredRes.status).toBe(200);
            const filteredData = await filteredRes.json();
            expect(filteredData.logs.length).toBe(1);
            expect(filteredData.logs[0].title).toBe('Member Warned');

            // Test SSE stream endpoint (/api/guilds/:guildId/audit-logs/stream)
            const abortController = new AbortController();
            const streamRes = await fetch(`${baseUrl}/api/guilds/${auditGuildId}/audit-logs/stream`, {
                headers: { Cookie: cookie },
                signal: abortController.signal
            });
            expect(streamRes.status).toBe(200);
            expect(streamRes.headers.get('content-type')).toContain('text/event-stream');

            const reader = streamRes.body.getReader();
            const decoder = new TextDecoder();

            // Read initial connected handshake
            const firstChunk = await reader.read();
            const firstText = decoder.decode(firstChunk.value);
            expect(firstText).toContain('event: connected');

            // Emit a live audit log event and read it from the SSE stream
            loggingService.recordAuditLog(auditGuildId, {
                title: 'Live Streamed Event',
                description: 'Real-time SSE broadcast verification',
                eventType: 'log_events_commands',
                user: { id: 'u_live_1', username: 'LiveTester' }
            });

            const secondChunk = await reader.read();
            const secondText = decoder.decode(secondChunk.value);
            expect(secondText).toContain('data: ');
            expect(secondText).toContain('Live Streamed Event');

            abortController.abort();
        });
    });
});
