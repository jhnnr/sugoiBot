import { describe, it, expect, beforeEach } from 'vitest';
import { app } from '../dashboard/server.js';
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
    });
});
