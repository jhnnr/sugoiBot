import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import vm from 'vm';
import { app, setDiscordClient, setBotGuildsCache, clearBotGuildsCache, resetAllRateLimiters } from '../dashboard/server.js';
import { loggingService } from '../lib/bot/loggingService.js';
import { emitVoiceUpdate } from '../modules/voice/lib/voiceHelper.js';
import db from '../lib/database.js';

const VOID_TAGS = new Set([
    'AREA', 'BASE', 'BR', 'COL', 'EMBED', 'HR', 'IMG', 'INPUT',
    'LINK', 'META', 'PARAM', 'SOURCE', 'TRACK', 'WBR'
]);

function createDashboardDomHarness({ baseUrl, cookieHeader, customFetch, EventSource: CustomEventSource }) {
    const htmlPath = new URL('../dashboard/public/index.html', import.meta.url);
    const fullHtml = fs.readFileSync(htmlPath, 'utf8');
    const bodyMatch = fullHtml.match(/<body[^>]*>([\s\S]*?)<script>/i);
    const scriptMatch = fullHtml.match(/<script>([\s\S]*?)<\/script>/i);
    if (!bodyMatch || !scriptMatch) {
        throw new Error('Could not extract <body> or <script> from dashboard/public/index.html');
    }

    const allElements = new Set();
    let vmContext = null;

    function matchesSinglePart(el, part) {
        if (!el || !el.tagName) return false;
        let rem = part.trim();
        if (!rem) return false;

        const attrRegex = /\[([a-zA-Z0-9_:-]+)=(?:"([^"]*)"|'([^']*)'|([^\]]*))\]/g;
        let m;
        while ((m = attrRegex.exec(rem)) !== null) {
            const attrName = m[1];
            const attrVal = m[2] ?? m[3] ?? m[4] ?? '';
            if (el.getAttribute(attrName) !== attrVal) return false;
        }
        rem = rem.replace(attrRegex, '');

        const bareAttrRegex = /\[([a-zA-Z0-9_:-]+)\]/g;
        while ((m = bareAttrRegex.exec(rem)) !== null) {
            if (!el.attributes.has(m[1])) return false;
        }
        rem = rem.replace(bareAttrRegex, '');

        const idMatches = [...rem.matchAll(/#([a-zA-Z0-9_-]+)/g)];
        for (const idMatch of idMatches) {
            if (el.id !== idMatch[1]) return false;
        }
        rem = rem.replace(/#[a-zA-Z0-9_-]+/g, '');

        const classMatches = [...rem.matchAll(/\.([a-zA-Z0-9_-]+)/g)];
        for (const clsMatch of classMatches) {
            if (!el.classList.contains(clsMatch[1])) return false;
        }
        rem = rem.replace(/\.[a-zA-Z0-9_-]+/g, '').trim();

        if (rem && el.tagName !== rem.toUpperCase()) {
            return false;
        }
        return true;
    }

    function matchesCompoundSelector(el, sel) {
        const parts = sel.trim().split(/\s+(?![^\[]*\])/);
        if (parts.length === 1) {
            return matchesSinglePart(el, parts[0]);
        }
        if (!matchesSinglePart(el, parts[parts.length - 1])) return false;
        const ancestorSelector = parts.slice(0, -1).join(' ');
        return Boolean(el.parentElement && el.parentElement.closest(ancestorSelector));
    }

    function matchesSelectorList(el, selectorList) {
        const selectors = selectorList.split(',');
        return selectors.some(s => matchesCompoundSelector(el, s));
    }

    class MockElement {
        constructor(tagName, attrs = {}) {
            this.tagName = String(tagName || 'DIV').toUpperCase();
            this.attributes = new Map();
            this._classSet = new Set();
            this.style = { display: '', overflow: '', transform: '' };
            this.parentElement = null;
            this.children = [];
            this.listeners = new Map();
            this._innerHTML = '';
            this.textContent = '';

            for (const [k, v] of Object.entries(attrs)) {
                this.setAttribute(k, v);
            }

            this._value = String(this.attributes.get('value') ?? '');
            this.checked = this.attributes.has('checked');
            this.disabled = this.attributes.has('disabled');
            this.placeholder = this.attributes.get('placeholder') ?? '';

            const styleAttr = this.attributes.get('style') || '';
            const dispMatch = styleAttr.match(/display\s*:\s*([^;]+)/i);
            if (dispMatch) {
                this.style.display = dispMatch[1].trim();
            }

            const self = this;
            this.classList = {
                add(...tokens) {
                    tokens.forEach(t => t && self._classSet.add(t));
                },
                remove(...tokens) {
                    tokens.forEach(t => self._classSet.delete(t));
                },
                contains(token) {
                    return self._classSet.has(token);
                },
                toggle(token, force) {
                    const shouldHave = force !== undefined ? Boolean(force) : !self._classSet.has(token);
                    if (shouldHave) self._classSet.add(token);
                    else self._classSet.delete(token);
                    return shouldHave;
                }
            };
        }

        get id() {
            return this.attributes.get('id') || '';
        }
        set id(val) {
            this.setAttribute('id', String(val));
        }

        get name() {
            return this.attributes.get('name') || '';
        }
        set name(val) {
            this.setAttribute('name', String(val));
        }

        get type() {
            return this.attributes.get('type') || (this.tagName === 'INPUT' ? 'text' : '');
        }
        set type(val) {
            this.setAttribute('type', String(val));
        }

        get value() {
            return this._value;
        }
        set value(val) {
            this._value = String(val ?? '');
        }

        get className() {
            return [...this._classSet].join(' ');
        }
        set className(val) {
            this._classSet = new Set(String(val || '').split(/\s+/).filter(Boolean));
        }

        getAttribute(attr) {
            return this.attributes.has(attr) ? this.attributes.get(attr) : null;
        }

        setAttribute(attr, val) {
            const strVal = String(val ?? '');
            this.attributes.set(attr, strVal);
            if (attr === 'class') {
                this._classSet = new Set(strVal.split(/\s+/).filter(Boolean));
            }
        }

        appendChild(child) {
            if (!child) return child;
            child.parentElement = this;
            this.children.push(child);
            registerSubtree(child);
            return child;
        }

        removeChild(child) {
            const idx = this.children.indexOf(child);
            if (idx !== -1) {
                this.children.splice(idx, 1);
                child.parentElement = null;
                unregisterSubtree(child);
            }
            return child;
        }

        get innerHTML() {
            return this._innerHTML;
        }

        set innerHTML(html) {
            this._innerHTML = String(html ?? '');
            for (const c of this.children) {
                unregisterSubtree(c);
            }
            this.children = [];
            if (this._innerHTML.trim()) {
                parseHtmlIntoParent(this._innerHTML, this);
            }
        }

        addEventListener(type, fn) {
            if (!this.listeners.has(type)) this.listeners.set(type, []);
            this.listeners.get(type).push(fn);
        }

        removeEventListener(type, fn) {
            const arr = this.listeners.get(type);
            if (!arr) return;
            const idx = arr.indexOf(fn);
            if (idx !== -1) arr.splice(idx, 1);
        }

        closest(selectorList) {
            let cur = this;
            while (cur && cur.tagName) {
                if (matchesSelectorList(cur, selectorList)) return cur;
                cur = cur.parentElement;
            }
            return null;
        }

        querySelectorAll(selectorList) {
            const results = [];
            const visit = (node) => {
                for (const child of node.children) {
                    if (matchesSelectorList(child, selectorList)) {
                        results.push(child);
                    }
                    visit(child);
                }
            };
            visit(this);
            return results;
        }

        querySelector(selectorList) {
            return this.querySelectorAll(selectorList)[0] || null;
        }

        dispatchEvent(evt) {
            const event = {
                type: evt.type,
                target: evt.target || this,
                currentTarget: this,
                key: evt.key,
                files: evt.files,
                bubbles: evt.bubbles !== undefined ? evt.bubbles : !['focus', 'blur'].includes(evt.type),
                defaultPrevented: false,
                _stopped: false,
                preventDefault() {
                    this.defaultPrevented = true;
                },
                stopPropagation() {
                    this._stopped = true;
                }
            };

            let cur = this;
            while (cur) {
                event.currentTarget = cur;
                const fns = cur.listeners?.get(event.type);
                if (fns) {
                    for (const fn of [...fns]) {
                        fn.call(cur, event);
                    }
                }
                if (!event.bubbles || event._stopped) break;
                cur = cur.parentElement;
            }

            if (event.bubbles && !event._stopped) {
                const docFns = document.listeners.get(event.type);
                if (docFns) {
                    for (const fn of [...docFns]) {
                        fn.call(document, event);
                    }
                }
            }
            return !event.defaultPrevented;
        }

        click() {
            this.dispatchEvent({ type: 'click', bubbles: true, target: this });
            const onclickCode = this.getAttribute('onclick');
            if (onclickCode && vmContext) {
                return vm.runInContext(onclickCode, vmContext);
            }
            return undefined;
        }

        focus() {
            document.activeElement = this;
            this.dispatchEvent({ type: 'focus', bubbles: false, target: this });
        }

        blur() {
            if (document.activeElement === this) {
                document.activeElement = null;
            }
            this.dispatchEvent({ type: 'blur', bubbles: false, target: this });
        }

        requestSubmit() {
            this.dispatchEvent({ type: 'submit', bubbles: true, target: this });
        }
    }

    function registerSubtree(node) {
        allElements.add(node);
        for (const c of node.children) {
            registerSubtree(c);
        }
    }

    function unregisterSubtree(node) {
        allElements.delete(node);
        for (const c of node.children) {
            unregisterSubtree(c);
        }
    }

    function parseAttributes(attrString) {
        const attrs = {};
        const attrRe = /([a-zA-Z0-9_:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
        let m;
        while ((m = attrRe.exec(attrString)) !== null) {
            attrs[m[1]] = m[2] ?? m[3] ?? m[4] ?? '';
        }
        return attrs;
    }

    function parseHtmlIntoParent(html, rootParent) {
        const tokenRe = /<!--[\s\S]*?-->|<\/([a-zA-Z0-9-]+)\s*>|<([a-zA-Z0-9-]+)((?:\s+[^>]*)?)>/g;
        const stack = [rootParent];
        let lastIndex = 0;
        let m;

        while ((m = tokenRe.exec(html)) !== null) {
            const textBefore = html.slice(lastIndex, m.index).trim();
            if (textBefore && stack.length > 0) {
                stack[stack.length - 1].textContent += textBefore;
            }
            lastIndex = tokenRe.lastIndex;

            if (m[0].startsWith('<!--')) continue;

            const closingTag = m[1];
            if (closingTag) {
                const upperClose = closingTag.toUpperCase();
                for (let i = stack.length - 1; i >= 1; i--) {
                    if (stack[i].tagName === upperClose) {
                        stack.length = i;
                        break;
                    }
                }
                continue;
            }

            const openTag = m[2];
            let rawAttrs = m[3] || '';
            const selfClosing = rawAttrs.trimEnd().endsWith('/');
            if (selfClosing) {
                rawAttrs = rawAttrs.replace(/\/\s*$/, '');
            }

            const el = new MockElement(openTag, parseAttributes(rawAttrs));
            const parent = stack[stack.length - 1];
            parent.appendChild(el);

            if (!selfClosing && !VOID_TAGS.has(el.tagName)) {
                stack.push(el);
            }
        }
    }

    const body = new MockElement('BODY');
    registerSubtree(body);
    parseHtmlIntoParent(bodyMatch[1], body);

    const document = {
        body,
        activeElement: null,
        listeners: new Map(),
        getElementById(id) {
            for (const el of allElements) {
                if (el.id === id) return el;
            }
            return null;
        },
        querySelectorAll(selectorList) {
            return body.querySelectorAll(selectorList);
        },
        querySelector(selectorList) {
            return body.querySelector(selectorList);
        },
        createElement(tag) {
            return new MockElement(tag);
        },
        addEventListener(type, fn) {
            if (!this.listeners.has(type)) this.listeners.set(type, []);
            this.listeners.get(type).push(fn);
        },
        removeEventListener(type, fn) {
            const arr = this.listeners.get(type);
            if (!arr) return;
            const idx = arr.indexOf(fn);
            if (idx !== -1) arr.splice(idx, 1);
        }
    };

    const defaultFetch = async (url, options = {}) => {
        const fullUrl = String(url).startsWith('http') ? String(url) : `${baseUrl}${url}`;
        const headers = {
            ...(options.headers || {}),
            ...(cookieHeader ? { Cookie: cookieHeader } : {})
        };
        return fetch(fullUrl, { ...options, headers });
    };

    const windowObj = {
        document,
        location: { reload: () => {} },
        getComputedStyle(el) {
            return { display: el?.style?.display || 'none' };
        },
        fetch: customFetch || defaultFetch,
        URL: {
            createObjectURL: () => 'blob:mock',
            revokeObjectURL: () => {}
        },
        Blob,
        setTimeout,
        clearTimeout,
        console
    };
    if (CustomEventSource) {
        windowObj.EventSource = CustomEventSource;
    }
    windowObj.window = windowObj;

    vmContext = vm.createContext(windowObj);

    const instrumentedScript = `${scriptMatch[1].replace(/checkAuth\(\);\s*$/, '')}
window.__dashboardTestApi = {
    ...(window.__dashboardTestApi || {}),
    checkAuth,
    renderLoggedOut,
    loadGuilds,
    captureFormState,
    isFormDirty,
    checkFormChanges,
    checkFormDirty,
    resetFormChanges,
    openModal,
    closeModal,
    selectGuild,
    loadGuildSettings,
    loadAllCommands,
    renderCommandRolesList,
    refreshXPModalData,
    refreshGameRoleModalData,
    logChannelCombobox,
    xpChannelCombobox,
    stripEmojis,
    cleanAuditUserTag,
    buildAuditUserMap,
    resolveClientAuditMentions,
    formatAuditMarkdown,
    formatAuditDescription,
    renderAuditLogs,
    appendAuditLogEntry,
    loadAuditLogs,
    exportDatabaseBackup,
    applyVoiceStatusData,
    connectVoiceStream,
    disconnectVoiceStream
};
`;

    vm.runInContext(instrumentedScript, vmContext);

    return {
        document,
        window: windowObj,
        api: windowObj.__dashboardTestApi
    };
}


describe('Dashboard API', () => {
    let server;
    let baseUrl;

    beforeEach(async () => {
        resetAllRateLimiters();

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

    describe('Dashboard Dirty-State & Floating Save Bar Behavior', () => {
        async function setupAuthenticatedDashboard() {
            const testGuildId = 'dirty_test_guild_' + Date.now() + '_' + Math.floor(Math.random() * 1000);

            setDiscordClient({
                guilds: {
                    cache: new Map([
                        [
                            testGuildId,
                            {
                                id: testGuildId,
                                name: 'Dirty State Test Server',
                                icon: null,
                                channels: {
                                    cache: new Map([
                                        ['111111111111111111', { id: '111111111111111111', name: 'mod-logs', type: 0, position: 1 }],
                                        ['222222222222222222', { id: '222222222222222222', name: 'level-ups', type: 0, position: 2 }]
                                    ]),
                                    async fetch() {
                                        return this.cache;
                                    }
                                },
                                roles: {
                                    cache: new Map([
                                        ['333333333333333333', { id: '333333333333333333', name: 'Moderator', position: 5, managed: false, hexColor: '#5865f2' }],
                                        ['444444444444444444', { id: '444444444444444444', name: 'VIP', position: 4, managed: false, hexColor: '#23a55a' }]
                                    ]),
                                    async fetch() {
                                        return this.cache;
                                    }
                                }
                            }
                        ]
                    ])
                }
            });

            const loginRes = await fetch(`${baseUrl}/api/auth/dev-login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    user: { id: 'dirty_tester', username: 'DashboardTester' },
                    guilds: [{ id: testGuildId, name: 'Dirty State Test Server', owner: true }]
                })
            });
            const cookieHeader = loginRes.headers.get('set-cookie');

            await fetch(`${baseUrl}/api/guilds/${testGuildId}/settings`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Cookie: cookieHeader
                },
                body: JSON.stringify({
                    log_channel_id: '111111111111111111',
                    xp_channel_id: '222222222222222222',
                    xp_min: 10,
                    xp_max: 20,
                    gamerole_prefix: 'PLAYING ',
                    gamerole_color: '#ff0000',
                    role_rewards: { '5': '333333333333333333', '10': '444444444444444444' },
                    command_roles: {
                        voice: '333333333333333333',
                        'voice lock': '444444444444444444'
                    }
                })
            });

            const harness = createDashboardDomHarness({ baseUrl, cookieHeader });
            await harness.api.loadAllCommands();
            await harness.api.loadGuildSettings(testGuildId, 'Dirty State Test Server');
            await new Promise(r => setTimeout(r, 120));

            return { testGuildId, cookieHeader, ...harness };
        }

        it('clicking Overview gear buttons navigates to per-module workspaces cleanly without marking form dirty, and #confirmModal locks/restores body scroll', async () => {
            const { document, api } = await setupAuthenticatedDashboard();
            const saveBar = document.getElementById('floatingSaveBar');
            const settingsCard = document.getElementById('settingsCard');
            const modulesNavToggle = document.getElementById('modulesNavToggle');
            const modulesSubnav = document.getElementById('modulesSubnav');

            expect(api.isFormDirty()).toBe(false);
            expect(api.checkFormDirty()).toBe(false);
            expect(saveBar.classList.contains('visible')).toBe(false);
            expect(api.captureFormState()).toEqual(api.getState().initialFormState);
            expect(settingsCard.style.display).toBe('block');

            const moduleKeys = ['general', 'economy', 'moderation', 'xp', 'gamerole', 'voice'];

            for (const mod of moduleKeys) {
                await api.setWorkspaceView('all');
                expect(settingsCard.style.display).toBe('block');

                const gearBtn = document.querySelector(`.module-settings-btn[data-module-gear="${mod}"]`);
                expect(gearBtn).not.toBeNull();

                // Click gear button on Overview -> navigates to #moduleWorkspace_<mod>, auto-expands #modulesSubnav, never marks form dirty
                await gearBtn.click();

                const panelEl = document.getElementById(`moduleWorkspace_${mod}`);
                expect(panelEl).not.toBeNull();
                expect(panelEl.style.display).toBe('block');
                expect(settingsCard.style.display).toBe('none');
                expect(modulesNavToggle.getAttribute('aria-expanded')).toBe('true');
                expect(modulesSubnav.style.display).toBe('flex');
                expect(document.querySelector(`.workspace-subnav-btn[data-module-nav="${mod}"]`).classList.contains('active')).toBe(true);
                expect(document.body.style.overflow).toBe('');
                expect(api.isFormDirty()).toBe(false);
                expect(api.checkFormDirty()).toBe(false);
                expect(saveBar.classList.contains('visible')).toBe(false);
                expect(api.captureFormState()).toEqual(api.getState().initialFormState);
            }

            // Backwards-safe openModal('<mod>Modal') routes to module workspace cleanly
            await api.openModal('xpModal');
            expect(document.getElementById('moduleWorkspace_xp').style.display).toBe('block');
            expect(api.isFormDirty()).toBe(false);
            expect(saveBar.classList.contains('visible')).toBe(false);

            // #confirmModal remains a true modal that locks document.body.style.overflow = 'hidden' on open and restores '' on close / backdrop click
            const confirmModal = document.getElementById('confirmModal');
            expect(confirmModal).not.toBeNull();
            await api.openModal('confirmModal');
            expect(confirmModal.style.display).toBe('flex');
            expect(document.body.style.overflow).toBe('hidden');
            expect(api.isFormDirty()).toBe(false);

            api.closeModal('confirmModal');
            expect(confirmModal.style.display).toBe('none');
            expect(document.body.style.overflow).toBe('');
            expect(api.isFormDirty()).toBe(false);

            await api.openModal('confirmModal');
            expect(document.body.style.overflow).toBe('hidden');
            confirmModal.dispatchEvent({ type: 'click', bubbles: true, target: confirmModal });
            expect(confirmModal.style.display).toBe('none');
            expect(document.body.style.overflow).toBe('');
            expect(api.isFormDirty()).toBe(false);
            expect(saveBar.classList.contains('visible')).toBe(false);

            // Ensure subcommand role override ('voice lock' -> '444444444444444444') was not overwritten by parent command cascade
            expect(api.getState().currentCommandRoles['voice']).toBe('333333333333333333');
            expect(api.getState().currentCommandRoles['voice lock']).toBe('444444444444444444');
        });

        it('clicking, focusing, filtering without selecting, blurring, or re-selecting current item in channel/role comboboxes never marks form dirty', async () => {
            const { document, api } = await setupAuthenticatedDashboard();
            const saveBar = document.getElementById('floatingSaveBar');
            const logSearch = document.getElementById('log_channel_search');
            const logHidden = document.getElementById('log_channel_id');
            const logDropdown = document.getElementById('log_channel_dropdown');

            expect(logHidden.value).toBe('111111111111111111');
            expect(logSearch.value).toBe('#mod-logs');

            // 1. Focus and click Log Channel combobox
            logSearch.focus();
            logSearch.click();
            expect(logDropdown.classList.contains('open')).toBe(true);
            expect(api.isFormDirty()).toBe(false);
            expect(saveBar.classList.contains('visible')).toBe(false);

            // 2. Type filter text and even clear filter text without selecting an item
            logSearch.value = 'level';
            logSearch.dispatchEvent({ type: 'input', bubbles: true, target: logSearch });
            expect(logHidden.value).toBe('111111111111111111');
            expect(api.isFormDirty()).toBe(false);
            expect(saveBar.classList.contains('visible')).toBe(false);

            logSearch.value = '';
            logSearch.dispatchEvent({ type: 'input', bubbles: true, target: logSearch });
            expect(logHidden.value).toBe('111111111111111111');
            expect(api.isFormDirty()).toBe(false);
            expect(saveBar.classList.contains('visible')).toBe(false);

            // 3. Blur / click outside restores display text and keeps form clean
            logSearch.blur();
            document.body.click();
            expect(logDropdown.classList.contains('open')).toBe(false);
            expect(logHidden.value).toBe('111111111111111111');
            expect(logSearch.value).toBe('#mod-logs');
            expect(api.checkFormDirty()).toBe(false);
            expect(saveBar.classList.contains('visible')).toBe(false);

            // 4. Re-selecting the already-selected channel option is a no-op
            logSearch.focus();
            const selectedChannelItem = logDropdown.children.find(el => el.classList.contains('selected'));
            expect(selectedChannelItem).toBeDefined();
            selectedChannelItem.click();
            expect(logHidden.value).toBe('111111111111111111');
            expect(api.checkFormDirty()).toBe(false);
            expect(saveBar.classList.contains('visible')).toBe(false);

            // 5. Same check for XP Channel combobox and Command Role combobox
            const xpSearch = document.getElementById('xp_channel_search');
            const xpHidden = document.getElementById('xp_channel_id');
            xpSearch.focus();
            xpSearch.value = '';
            xpSearch.dispatchEvent({ type: 'input', bubbles: true, target: xpSearch });
            xpSearch.blur();
            expect(xpHidden.value).toBe('222222222222222222');
            expect(xpSearch.value).toBe('#level-ups');
            expect(api.checkFormDirty()).toBe(false);

            const voiceRoleSearch = document.getElementById('cmd_role_search_voice');
            const voiceRoleDrop = document.getElementById('cmd_role_drop_voice');
            expect(voiceRoleSearch).not.toBeNull();
            voiceRoleSearch.focus();
            voiceRoleSearch.value = 'VIP';
            voiceRoleSearch.dispatchEvent({ type: 'input', bubbles: true, target: voiceRoleSearch });
            voiceRoleSearch.blur();
            expect(voiceRoleSearch.value).toBe('@Moderator');
            expect(api.getState().currentCommandRoles['voice lock']).toBe('444444444444444444');
            expect(api.checkFormDirty()).toBe(false);

            // Re-selecting @Moderator on parent /voice command does not cascade over 'voice lock' subcommand
            voiceRoleSearch.focus();
            const currentRoleItem = voiceRoleDrop.children.find(el => el.classList.contains('selected'));
            expect(currentRoleItem).toBeDefined();
            currentRoleItem.click();
            expect(api.getState().currentCommandRoles['voice lock']).toBe('444444444444444444');
            expect(api.checkFormDirty()).toBe(false);
            expect(saveBar.classList.contains('visible')).toBe(false);
        });

        it('async channel/role/command population and auxiliary inputs do not mark the form dirty', async () => {
            const { document, api, testGuildId } = await setupAuthenticatedDashboard();
            const saveBar = document.getElementById('floatingSaveBar');

            // Verify button[form="settingsForm"] and auxiliary inputs are excluded from captureFormState()
            const captured = api.captureFormState();
            expect(captured).not.toHaveProperty('saveFloatingBtn');
            expect(captured).not.toHaveProperty('log_channel_search');
            expect(captured).not.toHaveProperty('xp_channel_search');
            expect(captured).not.toHaveProperty('new_reward_level');
            expect(captured).not.toHaveProperty('new_reward_role_select');
            expect(captured).not.toHaveProperty('auditLogTypeFilter');
            expect(captured).not.toHaveProperty('auditLogSearchInput');

            // Typing into auxiliary inputs (reward builder, audit log filters) does not mark form dirty
            const newRewardLvl = document.getElementById('new_reward_level');
            newRewardLvl.value = '15';
            newRewardLvl.dispatchEvent({ type: 'input', bubbles: true, target: newRewardLvl });
            const auditSearch = document.getElementById('auditLogSearchInput');
            auditSearch.value = 'warn';
            auditSearch.dispatchEvent({ type: 'input', bubbles: true, target: auditSearch });
            expect(api.isFormDirty()).toBe(false);
            expect(saveBar.classList.contains('visible')).toBe(false);

            // Async repopulation of channels, commands, and modal data while form is unmodified keeps initialFormState in sync
            api.logChannelCombobox.setChannels(
                [
                    { id: '111111111111111111', name: 'mod-logs' },
                    { id: '222222222222222222', name: 'level-ups' },
                    { id: '555555555555555555', name: 'new-audit-channel' }
                ],
                '111111111111111111'
            );
            await api.loadAllCommands();
            await api.refreshXPModalData(testGuildId);
            await api.refreshGameRoleModalData(testGuildId);

            expect(api.captureFormState()).toEqual(api.getState().initialFormState);
            expect(api.checkFormDirty()).toBe(false);
            expect(saveBar.classList.contains('visible')).toBe(false);
        });

        it('changing an actual setting marks the form dirty and reverting/resetting/saving clears dirty state', async () => {
            const { document, api } = await setupAuthenticatedDashboard();
            const saveBar = document.getElementById('floatingSaveBar');

            // 1. Toggle a module checkbox -> dirty, revert -> clean
            const econCheckbox = document.getElementById('module_economy_enabled');
            const initialEcon = econCheckbox.checked;
            econCheckbox.checked = !initialEcon;
            econCheckbox.dispatchEvent({ type: 'change', bubbles: true, target: econCheckbox });

            expect(api.isFormDirty()).toBe(true);
            expect(api.checkFormDirty()).toBe(true);
            expect(saveBar.classList.contains('visible')).toBe(true);

            econCheckbox.checked = initialEcon;
            econCheckbox.dispatchEvent({ type: 'change', bubbles: true, target: econCheckbox });

            expect(api.isFormDirty()).toBe(false);
            expect(api.checkFormDirty()).toBe(false);
            expect(saveBar.classList.contains('visible')).toBe(false);

            // 2. Select a different channel in Log Channel combobox -> dirty, select original channel back -> clean
            const logSearch = document.getElementById('log_channel_search');
            const logHidden = document.getElementById('log_channel_id');
            const logDropdown = document.getElementById('log_channel_dropdown');

            logSearch.focus();
            const secondChannelItem = logDropdown.children.find(
                el => el.classList.contains('combobox-item') && !el.classList.contains('selected') && el.innerHTML.includes('#level-ups')
            );
            expect(secondChannelItem).toBeDefined();
            secondChannelItem.click();

            expect(logHidden.value).toBe('222222222222222222');
            expect(api.isFormDirty()).toBe(true);
            expect(saveBar.classList.contains('visible')).toBe(true);

            logSearch.focus();
            const origChannelItem = logDropdown.children.find(
                el => el.classList.contains('combobox-item') && el.innerHTML.includes('#mod-logs')
            );
            expect(origChannelItem).toBeDefined();
            origChannelItem.click();

            expect(logHidden.value).toBe('111111111111111111');
            expect(api.isFormDirty()).toBe(false);
            expect(saveBar.classList.contains('visible')).toBe(false);

            // 3. Edit modal input + command role, then click Reset button -> restores state & hides save bar
            const xpMinInput = document.getElementById('xp_min');
            xpMinInput.value = '35';
            xpMinInput.dispatchEvent({ type: 'input', bubbles: true, target: xpMinInput });
            expect(saveBar.classList.contains('visible')).toBe(true);

            const resetBtn = document.getElementById('resetBtn');
            resetBtn.click();
            expect(xpMinInput.value).toBe('10');
            expect(api.isFormDirty()).toBe(false);
            expect(saveBar.classList.contains('visible')).toBe(false);

            // 4. Edit gamerole_prefix without trailing space, submit form -> normalizes value, clears dirty state, and reopening gameroleModal stays clean
            const prefixInput = document.getElementById('gamerole_prefix');
            prefixInput.value = 'GAMING';
            prefixInput.dispatchEvent({ type: 'input', bubbles: true, target: prefixInput });
            expect(saveBar.classList.contains('visible')).toBe(true);

            const settingsForm = document.getElementById('settingsForm');
            settingsForm.requestSubmit();
            await new Promise(r => setTimeout(r, 80));

            expect(prefixInput.value).toBe('GAMING ');
            expect(api.isFormDirty()).toBe(false);
            expect(saveBar.classList.contains('visible')).toBe(false);

            await api.openModal('gameroleModal');
            api.closeModal('gameroleModal');
            expect(api.isFormDirty()).toBe(false);
            expect(saveBar.classList.contains('visible')).toBe(false);
        });

        it('GET /api/guilds/:guildId/audit-logs resolves <@userId>, <#channelId>, and <@&roleId> mentions via discordClient cache and historical SQLite audit_logs', async () => {
            const voiceGuildId = 'voice_audit_guild_' + Date.now();

            setDiscordClient({
                user: { id: '1562149253504049192', username: 'sugoiBot' },
                users: {
                    cache: new Map([
                        ['1562149253504049192', { id: '1562149253504049192', username: 'sugoiBot' }]
                    ])
                },
                guilds: {
                    cache: new Map([
                        [
                            voiceGuildId,
                            {
                                id: voiceGuildId,
                                name: 'Voice Audit Server',
                                members: {
                                    cache: new Map([
                                        ['517108999527727126', { id: '517108999527727126', user: { id: '517108999527727126', username: 'sugoi.js' } }]
                                    ])
                                },
                                channels: {
                                    cache: new Map([
                                        ['700000000000000001', { id: '700000000000000001', name: 'voice-lobby', type: 2 }]
                                    ])
                                },
                                roles: {
                                    cache: new Map([
                                        ['800000000000000002', { id: '800000000000000002', name: 'DJ' }]
                                    ])
                                }
                            }
                        ]
                    ])
                }
            });

            const loginRes = await fetch(`${baseUrl}/api/auth/dev-login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    user: { id: 'voice_admin', username: 'VoiceAdmin' },
                    guilds: [{ id: voiceGuildId, name: 'Voice Audit Server', owner: true }]
                })
            });
            const cookie = loginRes.headers.get('set-cookie');

            const baseTs = Date.now();
            // Insert historical raw-mention rows into SQLite as well as new recordAuditLog entries covering all 5 user-reported lines
            loggingService.recordAuditLog(voiceGuildId, {
                title: 'Voice Activity',
                description: '<@517108999527727126> joined voice channel **➕ Join to Create**',
                eventType: 'log_events_voice',
                user: { id: '517108999527727126', username: 'sugoi.js' },
                timestamp: baseTs + 1
            });
            loggingService.recordAuditLog(voiceGuildId, {
                title: 'Channel Event',
                description: 'Voice channel created: **dota o ako**',
                eventType: 'log_events_channels',
                user: { id: '1562149253504049192', username: 'sugoiBot' },
                timestamp: baseTs + 2
            });
            // Simulate a pre-existing historical row in SQLite that stored raw <@id>, <#id>, and <@&id> mentions
            db.prepare(`
                INSERT INTO audit_logs (guildId, eventType, title, description, color, userId, username, userTag, fields, timestamp)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                voiceGuildId,
                'log_events_voice',
                'Voice Activity',
                '<@517108999527727126> was moved from voice channel **➕ Join to Create** to **dota o ako** by <@1562149253504049192> (<#700000000000000001> / <@&800000000000000002>)',
                0xFEE75C,
                '517108999527727126',
                'sugoi.js',
                'sugoi.js',
                '[]',
                baseTs + 3
            );
            loggingService.recordAuditLog(voiceGuildId, {
                title: 'Voice Activity',
                description: '<@517108999527727126> left voice channel **dota o ako**',
                eventType: 'log_events_voice',
                user: { id: '517108999527727126', username: 'sugoi.js' },
                timestamp: baseTs + 4
            });
            loggingService.recordAuditLog(voiceGuildId, {
                title: 'Channel Event',
                description: 'Voice channel deleted: **dota o ako**',
                eventType: 'log_events_channels',
                user: { id: '1562149253504049192', username: 'sugoiBot' },
                timestamp: baseTs + 5
            });

            const res = await fetch(`${baseUrl}/api/guilds/${voiceGuildId}/audit-logs?limit=10`, {
                headers: { Cookie: cookie }
            });
            expect(res.status).toBe(200);
            const data = await res.json();
            expect(data.logs.length).toBe(5);

            const descriptions = data.logs.map(l => l.description);
            expect(descriptions).toEqual([
                'Voice channel deleted: **dota o ako**',
                '@sugoi.js left voice channel **dota o ako**',
                '@sugoi.js was moved from voice channel **➕ Join to Create** to **dota o ako** by @sugoiBot (#voice-lobby / @DJ)',
                'Voice channel created: **dota o ako**',
                '@sugoi.js joined voice channel **➕ Join to Create**'
            ]);
        });

        it('dashboard frontend audit log renderer resolves fallback mentions, strips inline emojis, and formats **bold** and `code` into clean HTML', async () => {
            const { document, api } = await setupAuthenticatedDashboard();
            const listEl = document.getElementById('auditLogsList');

            const sampleLogs = [
                {
                    id: 505,
                    guildId: api.getState().currentGuildId,
                    eventType: 'log_events_channels',
                    title: 'Channel Event',
                    description: 'Voice channel deleted: **dota o ako**',
                    userId: '1562149253504049192',
                    username: 'sugoiBot',
                    userTag: 'sugoiBot',
                    timestamp: Date.now()
                },
                {
                    id: 504,
                    guildId: api.getState().currentGuildId,
                    eventType: 'log_events_voice',
                    title: '🔊 Voice Activity',
                    description: '<@517108999527727126> left voice channel **dota o ako**',
                    userId: '517108999527727126',
                    username: 'sugoi.js',
                    userTag: 'sugoi.js#0',
                    timestamp: Date.now() - 1000
                },
                {
                    id: 503,
                    guildId: api.getState().currentGuildId,
                    eventType: 'log_events_voice',
                    title: 'Voice Activity',
                    description: '<@517108999527727126> was moved from voice channel **➕ Join to Create** to **dota o ako** by <@1562149253504049192> with <@&333333333333333333> using `/voice move`',
                    userId: '517108999527727126',
                    username: 'sugoi.js',
                    userTag: 'sugoi.js',
                    timestamp: Date.now() - 2000
                },
                {
                    id: 502,
                    guildId: api.getState().currentGuildId,
                    eventType: 'log_events_channels',
                    title: 'Channel Event',
                    description: 'Voice channel created: **dota o ako**',
                    userId: '1562149253504049192',
                    username: 'sugoiBot',
                    userTag: 'sugoiBot',
                    timestamp: Date.now() - 3000
                },
                {
                    id: 501,
                    guildId: api.getState().currentGuildId,
                    eventType: 'log_events_voice',
                    title: 'Voice Activity',
                    description: '<@!517108999527727126> joined voice channel **➕ Join to Create** <script>alert(1)</script>',
                    userId: '517108999527727126',
                    username: 'sugoi.js',
                    userTag: 'sugoi.js',
                    timestamp: Date.now() - 4000
                }
            ];

            api.renderAuditLogs(sampleLogs);

            const html = listEl.innerHTML;
            // 1. No raw <@id> or <@&id> mentions remain
            expect(html).not.toContain('<@517108999527727126>');
            expect(html).not.toContain('<@!517108999527727126>');
            expect(html).not.toContain('<@1562149253504049192>');
            expect(html).not.toContain('<@&333333333333333333>');

            // 2. Inline and leading emojis (➕, 🔊) are completely stripped
            expect(html).not.toContain('➕');
            expect(html).not.toContain('🔊');
            expect(/[\p{Extended_Pictographic}\p{Emoji_Presentation}]/u.test(html)).toBe(false);

            // 3. Markdown **bold** and `code` are converted to <strong> and <code> with no raw ** asterisks
            expect(html).not.toContain('**');
            expect(html).toContain('Voice channel deleted: <strong>dota o ako</strong>');
            expect(html).toContain('@sugoi.js left voice channel <strong>dota o ako</strong>');
            expect(html).toContain('@sugoi.js was moved from voice channel <strong>Join to Create</strong> to <strong>dota o ako</strong> by @sugoiBot with @Moderator using <code>/voice move</code>');
            expect(html).toContain('Voice channel created: <strong>dota o ako</strong>');
            expect(html).toContain('@sugoi.js joined voice channel <strong>Join to Create</strong> &lt;script&gt;alert(1)&lt;/script&gt;');
        });
    });

    describe('M1–M5 Backend APIs & Overhauled Bento Command Center UI', () => {
        async function loginForGuilds(guilds, user = { id: 'm_admin', username: 'MasterAdmin' }) {
            const loginRes = await fetch(`${baseUrl}/api/auth/dev-login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user, guilds })
            });
            return loginRes.headers.get('set-cookie');
        }

        it('M1 Voice Hub Creator API: GET /voice returns sorted categories and POST /voice/hubs creates hubs via discordClient and Discord REST fallback', async () => {
            const voiceGuildId = 'm1_voice_guild_' + Date.now();
            const cookie = await loginForGuilds([{ id: voiceGuildId, name: 'Voice Studio Server', owner: true }]);

            // Unauthenticated returns 401
            const unauthRes = await fetch(`${baseUrl}/api/guilds/${voiceGuildId}/voice/hubs`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'Join to Create' })
            });
            expect(unauthRes.status).toBe(401);

            const channelCache = new Map([
                ['cat_general', { id: 'cat_general', name: 'General Category', type: 4, position: 2 }],
                ['cat_voice', { id: 'cat_voice', name: 'Voice Rooms', type: 4, position: 0 }],
                ['txt_chat', { id: 'txt_chat', name: 'general-chat', type: 0, position: 1 }]
            ]);

            let createdCounter = 100;
            setDiscordClient({
                guilds: {
                    cache: new Map([
                        [
                            voiceGuildId,
                            {
                                id: voiceGuildId,
                                name: 'Voice Studio Server',
                                channels: {
                                    cache: channelCache,
                                    async fetch() {
                                        return channelCache;
                                    },
                                    async create(opts) {
                                        createdCounter += 1;
                                        const created = {
                                            id: `created_ch_${createdCounter}`,
                                            name: opts.name,
                                            type: opts.type,
                                            position: channelCache.size,
                                            parentId: opts.parent || null
                                        };
                                        channelCache.set(created.id, created);
                                        return created;
                                    }
                                }
                            }
                        ]
                    ])
                }
            });

            // 1. GET /voice returns categories sorted ascending by position
            const getVoiceRes = await fetch(`${baseUrl}/api/guilds/${voiceGuildId}/voice`, {
                headers: { Cookie: cookie }
            });
            expect(getVoiceRes.status).toBe(200);
            const getVoiceData = await getVoiceRes.json();
            expect(getVoiceData.categories).toEqual([
                { id: 'cat_voice', name: 'Voice Rooms', position: 0 },
                { id: 'cat_general', name: 'General Category', position: 2 }
            ]);

            // 2. POST /voice/hubs with new category creation via discordClient
            const createWithNewCatRes = await fetch(`${baseUrl}/api/guilds/${voiceGuildId}/voice/hubs`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Cookie: cookie },
                body: JSON.stringify({
                    name: 'Squad Lobby',
                    categoryId: '__new__',
                    createCategoryName: 'Dynamic Squads'
                })
            });
            expect(createWithNewCatRes.status).toBe(201);
            const createWithNewCatData = await createWithNewCatRes.json();
            expect(createWithNewCatData.success).toBe(true);
            expect(createWithNewCatData.hub).toEqual(expect.objectContaining({
                hubChannelId: 'created_ch_102',
                guildId: voiceGuildId,
                categoryId: 'created_ch_101',
                name: 'Squad Lobby',
                categoryName: 'Dynamic Squads',
                existsInDiscord: true
            }));

            const persistedHub = db.prepare('SELECT * FROM voice_hubs WHERE hubChannelId = ?').get('created_ch_102');
            expect(persistedHub).toEqual({
                hubChannelId: 'created_ch_102',
                guildId: voiceGuildId,
                categoryId: 'created_ch_101'
            });

            // 3. POST /voice/hubs fallback to Discord REST fetch when discordClient is detached
            setDiscordClient(null);
            const prevToken = process.env.DISCORD_TOKEN;
            process.env.DISCORD_TOKEN = '"mock_bot_token_m1"';
            const realFetch = global.fetch;
            global.fetch = async (url, options) => {
                const urlStr = String(url);
                if (urlStr.startsWith('https://discord.com/api/v10/guilds/')) {
                    const parsedBody = JSON.parse(options.body);
                    return new Response(
                        JSON.stringify({
                            id: parsedBody.type === 4 ? 'rest_cat_901' : 'rest_hub_902',
                            name: parsedBody.name,
                            type: parsedBody.type,
                            parent_id: parsedBody.parent_id || null
                        }),
                        { status: 201, headers: { 'Content-Type': 'application/json' } }
                    );
                }
                return realFetch(url, options);
            };

            try {
                const restCreateRes = await realFetch(`${baseUrl}/api/guilds/${voiceGuildId}/voice/hubs`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Cookie: cookie },
                    body: JSON.stringify({
                        name: 'REST Join Hub',
                        createCategoryName: 'REST Voice Category'
                    })
                });
                expect(restCreateRes.status).toBe(201);
                const restData = await restCreateRes.json();
                expect(restData.hub).toEqual(expect.objectContaining({
                    hubChannelId: 'rest_hub_902',
                    categoryId: 'rest_cat_901',
                    name: 'REST Join Hub',
                    categoryName: 'REST Voice Category'
                }));

                const restRow = db.prepare('SELECT * FROM voice_hubs WHERE hubChannelId = ?').get('rest_hub_902');
                expect(restRow).toEqual({
                    hubChannelId: 'rest_hub_902',
                    guildId: voiceGuildId,
                    categoryId: 'rest_cat_901'
                });
            } finally {
                global.fetch = realFetch;
                if (prevToken === undefined) delete process.env.DISCORD_TOKEN;
                else process.env.DISCORD_TOKEN = prevToken;
            }
        });

        it('M2 Moderation Warnings API: GET /warnings supports pagination, search, and username enrichment and DELETE revokes or returns 404', async () => {
            const warnGuildId = 'm2_warn_guild_' + Date.now();
            const cookie = await loginForGuilds([{ id: warnGuildId, name: 'Moderation Server', owner: true }]);

            setDiscordClient({
                users: {
                    cache: new Map([
                        ['mod_77', { id: 'mod_77', username: 'ChiefMod' }]
                    ])
                },
                guilds: {
                    cache: new Map([
                        [
                            warnGuildId,
                            {
                                id: warnGuildId,
                                name: 'Moderation Server',
                                members: {
                                    cache: new Map([
                                        ['offender_1', { id: 'offender_1', user: { id: 'offender_1', username: 'SpamBotUser' } }],
                                        ['offender_2', { id: 'offender_2', user: { id: 'offender_2', username: 'CapsShouter' } }]
                                    ])
                                }
                            }
                        ]
                    ])
                }
            });

            const insertWarn = db.prepare('INSERT INTO warnings (userId, guildId, reason, moderatorId) VALUES (?, ?, ?, ?)');
            const w1 = insertWarn.run('offender_1', warnGuildId, 'Posting invite links', 'mod_77');
            insertWarn.run('offender_2', warnGuildId, 'Excessive caps lock', 'mod_77');
            insertWarn.run('offender_1', warnGuildId, 'Repeated spam in general', 'mod_77');

            // 1. Paginated fetch (limit=2, page=1 & page=2) + username/moderatorName enrichment
            const page1Res = await fetch(`${baseUrl}/api/guilds/${warnGuildId}/warnings?page=1&limit=2`, {
                headers: { Cookie: cookie }
            });
            expect(page1Res.status).toBe(200);
            const page1 = await page1Res.json();
            expect(page1.total).toBe(3);
            expect(page1.page).toBe(1);
            expect(page1.limit).toBe(2);
            expect(page1.totalPages).toBe(2);
            expect(page1.warnings).toHaveLength(2);
            expect(page1.warnings[0]).toEqual(expect.objectContaining({
                userId: 'offender_1',
                username: 'SpamBotUser',
                moderatorId: 'mod_77',
                moderatorName: 'ChiefMod',
                reason: 'Repeated spam in general'
            }));

            const page2Res = await fetch(`${baseUrl}/api/guilds/${warnGuildId}/warnings?page=2&limit=2`, {
                headers: { Cookie: cookie }
            });
            const page2 = await page2Res.json();
            expect(page2.warnings).toHaveLength(1);
            expect(page2.warnings[0].id).toBe(Number(w1.lastInsertRowid));

            // 2. Search by enriched username and reason
            const searchRes = await fetch(`${baseUrl}/api/guilds/${warnGuildId}/warnings?search=CapsShouter`, {
                headers: { Cookie: cookie }
            });
            const searchData = await searchRes.json();
            expect(searchData.total).toBe(1);
            expect(searchData.warnings[0].reason).toBe('Excessive caps lock');

            // 3. DELETE existing warning -> 200, then second DELETE or missing ID -> 404
            const delRes = await fetch(`${baseUrl}/api/guilds/${warnGuildId}/warnings/${w1.lastInsertRowid}`, {
                method: 'DELETE',
                headers: { Cookie: cookie }
            });
            expect(delRes.status).toBe(200);
            const delData = await delRes.json();
            expect(delData).toEqual({ success: true, deletedId: Number(w1.lastInsertRowid) });

            const missingDelRes = await fetch(`${baseUrl}/api/guilds/${warnGuildId}/warnings/${w1.lastInsertRowid}`, {
                method: 'DELETE',
                headers: { Cookie: cookie }
            });
            expect(missingDelRes.status).toBe(404);
        });

        it('M3 Economy Shop API: CRUD, validation (400 on invalid price/name/stock), and settings export/import round-trip', async () => {
            const shopGuildId = 'm3_shop_guild_' + Date.now();
            const restoredGuildId = 'm3_restored_guild_' + Date.now();
            const cookie = await loginForGuilds([
                { id: shopGuildId, name: 'Economy Shop Server', owner: true },
                { id: restoredGuildId, name: 'Restored Shop Server', owner: true }
            ]);

            setDiscordClient({
                guilds: {
                    cache: new Map([
                        [
                            shopGuildId,
                            {
                                id: shopGuildId,
                                name: 'Economy Shop Server',
                                roles: {
                                    cache: new Map([
                                        ['900100200300400500', { id: '900100200300400500', name: 'Gold Patron', hexColor: '#f1c40f' }]
                                    ])
                                }
                            }
                        ]
                    ])
                }
            });

            // 1. Validation rejections (empty name, price < 0, stock < -1) -> 400
            for (const badBody of [
                { name: '   ', price: 100, stock: -1 },
                { name: 'Negative Item', price: -5, stock: -1 },
                { name: 'Bad Stock Item', price: 100, stock: -2 }
            ]) {
                const badRes = await fetch(`${baseUrl}/api/guilds/${shopGuildId}/shop`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Cookie: cookie },
                    body: JSON.stringify(badBody)
                });
                expect(badRes.status).toBe(400);
            }

            // 2. Create two shop items (with quoted roleId sanitization)
            const createHighRes = await fetch(`${baseUrl}/api/guilds/${shopGuildId}/shop`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Cookie: cookie },
                body: JSON.stringify({
                    name: 'Gold Patron Role',
                    description: 'Shiny gold hoisted role',
                    price: 1500,
                    roleId: '"900100200300400500"',
                    stock: 5
                })
            });
            expect(createHighRes.status).toBe(201);
            const createdHigh = (await createHighRes.json()).item;
            expect(createdHigh).toEqual(expect.objectContaining({
                name: 'Gold Patron Role',
                price: 1500,
                roleId: '900100200300400500',
                roleName: 'Gold Patron',
                roleColor: '#f1c40f',
                stock: 5,
                purchaseCount: 0
            }));

            const createLowRes = await fetch(`${baseUrl}/api/guilds/${shopGuildId}/shop`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Cookie: cookie },
                body: JSON.stringify({
                    name: 'Cookie Badge',
                    description: 'Collectible snack',
                    price: 100,
                    stock: -1
                })
            });
            expect(createLowRes.status).toBe(201);
            const createdLow = (await createLowRes.json()).item;

            // Seed an inventory purchase to verify purchaseCount enrichment and cascade cleanup on DELETE
            db.prepare(`
                INSERT INTO user_inventory (guildId, userId, itemId, itemName, roleId, quantity, purchasedAt)
                VALUES (?, ?, ?, ?, '', 3, ?)
            `).run(shopGuildId, 'buyer_1', createdLow.id, 'Cookie Badge', Date.now());

            // 3. GET /shop returns items sorted price ASC, id ASC with purchaseCount
            const listRes = await fetch(`${baseUrl}/api/guilds/${shopGuildId}/shop`, {
                headers: { Cookie: cookie }
            });
            expect(listRes.status).toBe(200);
            const listData = await listRes.json();
            expect(listData.items.map(i => i.name)).toEqual(['Cookie Badge', 'Gold Patron Role']);
            expect(listData.items[0].purchaseCount).toBe(3);

            // 4. PUT /shop/:itemId updates item & rejects invalid price (400) / missing item (404)
            const badPut = await fetch(`${baseUrl}/api/guilds/${shopGuildId}/shop/${createdHigh.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', Cookie: cookie },
                body: JSON.stringify({ price: -10 })
            });
            expect(badPut.status).toBe(400);

            const missingPut = await fetch(`${baseUrl}/api/guilds/${shopGuildId}/shop/999999`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', Cookie: cookie },
                body: JSON.stringify({ price: 200 })
            });
            expect(missingPut.status).toBe(404);

            const putRes = await fetch(`${baseUrl}/api/guilds/${shopGuildId}/shop/${createdHigh.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', Cookie: cookie },
                body: JSON.stringify({ price: 1200, stock: 10 })
            });
            expect(putRes.status).toBe(200);
            const putData = await putRes.json();
            expect(putData.item.price).toBe(1200);
            expect(putData.item.stock).toBe(10);

            // 5. DELETE /shop/:itemId removes item and associated user_inventory rows
            const delRes = await fetch(`${baseUrl}/api/guilds/${shopGuildId}/shop/${createdLow.id}`, {
                method: 'DELETE',
                headers: { Cookie: cookie }
            });
            expect(delRes.status).toBe(200);
            const remainingInv = db.prepare('SELECT * FROM user_inventory WHERE guildId = ? AND itemId = ?').all(shopGuildId, createdLow.id);
            expect(remainingInv).toHaveLength(0);

            // 6. Export & Import round-trip including shop_items, module_embed_colors, and multi-role command_roles
            await fetch(`${baseUrl}/api/guilds/${shopGuildId}/settings`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Cookie: cookie },
                body: JSON.stringify({
                    module_embed_colors: { economy: '#00AAFF', xp: '#FF55AA' },
                    command_roles: { 'voice lock': ['111111111111111111', '222222222222222222'] }
                })
            });

            const exportRes = await fetch(`${baseUrl}/api/guilds/${shopGuildId}/settings/export`, {
                headers: { Cookie: cookie }
            });
            expect(exportRes.status).toBe(200);
            const bundle = await exportRes.json();
            expect(bundle.shop_items).toEqual([
                {
                    name: 'Gold Patron Role',
                    description: 'Shiny gold hoisted role',
                    price: 1200,
                    roleId: '900100200300400500',
                    stock: 10
                }
            ]);

            const importRes = await fetch(`${baseUrl}/api/guilds/${restoredGuildId}/settings/import`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Cookie: cookie },
                body: JSON.stringify(bundle)
            });
            expect(importRes.status).toBe(200);
            const imported = await importRes.json();
            expect(imported.settings.module_embed_colors).toEqual({ economy: '#00AAFF', xp: '#FF55AA' });
            expect(imported.settings.command_roles).toEqual({
                'voice lock': ['111111111111111111', '222222222222222222']
            });
            expect(imported.shop_items).toEqual(bundle.shop_items);
        });

        it('UI static & design-system verification: zero emojis, zero duplicate static DOM IDs, SVG-only gear buttons, #guildSelect removed, :root tokens defined, and zero decorative glassmorphism/gradients', () => {
            const htmlPath = new URL('../dashboard/public/index.html', import.meta.url);
            const fullHtml = fs.readFileSync(htmlPath, 'utf8');

            // 1. Zero emoji characters anywhere in index.html
            const emojiMatches = fullHtml.match(/[\p{Extended_Pictographic}\p{Emoji_Presentation}]/gu) || [];
            expect(emojiMatches).toHaveLength(0);

            // 1b. Zero duplicate static id="..." attributes in HTML markup
            const bodyMatch = fullHtml.match(/<body[^>]*>([\s\S]*?)<script>/i);
            expect(bodyMatch).not.toBeNull();
            const staticIds = [...bodyMatch[1].matchAll(/\bid\s*=\s*["']([^"']+)["']/gi)].map(m => m[1]);
            const seenIds = new Set();
            const duplicateIds = [];
            for (const id of staticIds) {
                if (seenIds.has(id)) duplicateIds.push(id);
                seenIds.add(id);
            }
            expect(duplicateIds).toEqual([]);

            // 2. Server dropdown (#guildSelect) is completely removed from HTML, JS, and parsed DOM
            expect(fullHtml).not.toContain('guildSelect');
            const { document } = createDashboardDomHarness({ baseUrl, cookieHeader: '' });
            expect(document.getElementById('guildSelect')).toBeNull();
            expect(document.querySelector('select#guildSelect')).toBeNull();

            // 2b. Old module modals are replaced by inline #moduleWorkspace_<mod> panels while #confirmModal remains
            for (const mod of ['general', 'economy', 'moderation', 'xp', 'gamerole', 'voice']) {
                expect(document.getElementById(`${mod}Modal`)).toBeNull();
                expect(document.getElementById(`moduleWorkspace_${mod}`)).not.toBeNull();
                expect(document.getElementById(`workspace_toggle_${mod}`)).not.toBeNull();
                expect(document.getElementById(`subnav_dot_${mod}`)).not.toBeNull();
            }
            expect(document.getElementById('confirmModal')).not.toBeNull();
            expect(document.getElementById('auditRoutingCard')).not.toBeNull();
            expect(document.getElementById('modulesNavToggle')).not.toBeNull();
            expect(document.getElementById('modulesSubnav')).not.toBeNull();

            // 3. Gear buttons contain an <svg> icon and zero visible "Settings" text
            const gearButtons = document.querySelectorAll('.module-settings-btn');
            expect(gearButtons.length).toBeGreaterThanOrEqual(6);
            for (const btn of gearButtons) {
                expect(btn.querySelector('svg')).not.toBeNull();
                expect(btn.textContent.trim()).toBe('');
                expect(btn.innerHTML).not.toContain('Settings');
            }

            // 4. <style> :root defines organized tokens for colors, typography, spacing, border-radius, shadows, and component dimensions
            const styleMatch = fullHtml.match(/<style>([\s\S]*?)<\/style>/i);
            expect(styleMatch).not.toBeNull();
            const styleCss = styleMatch[1];

            const rootMatch = styleCss.match(/:root\s*\{([\s\S]*?)\}/);
            expect(rootMatch).not.toBeNull();
            const rootTokens = rootMatch[1];

            const requiredTokens = [
                // Colors (neutral charcoal surfaces, borders, text, single primary accent, semantic status)
                '--color-bg-canvas',
                '--color-bg-surface',
                '--color-bg-subtle',
                '--color-bg-elevated',
                '--color-bg-hover',
                '--color-border-subtle',
                '--color-border',
                '--color-border-strong',
                '--color-text-primary',
                '--color-text-secondary',
                '--color-text-muted',
                '--color-accent',
                '--color-accent-hover',
                '--color-accent-subtle',
                '--color-success',
                '--color-warning',
                '--color-danger',
                // Typography
                '--font-sans',
                '--font-mono',
                '--text-xs',
                '--text-sm',
                '--text-base',
                '--text-md',
                '--text-lg',
                '--text-xl',
                '--weight-regular',
                '--weight-medium',
                '--weight-semibold',
                // Spacing
                '--space-1',
                '--space-2',
                '--space-3',
                '--space-4',
                '--space-5',
                '--space-6',
                '--space-8',
                // Border-radius (4px–10px)
                '--radius-xs',
                '--radius-sm',
                '--radius-md',
                '--radius-lg',
                // Shadows
                '--shadow-sm',
                '--shadow-md',
                '--shadow-lg',
                // Component dimensions
                '--sidebar-width',
                '--header-height',
                '--control-height',
                '--control-height-sm'
            ];
            for (const token of requiredTokens) {
                expect(rootTokens).toContain(`${token}:`);
            }
            expect(rootTokens).toMatch(/--color-accent:\s*#5865f2/i);
            expect(rootTokens).toMatch(/--radius-xs:\s*4px/);
            expect(rootTokens).toMatch(/--radius-lg:\s*10px/);

            // 5. Clean flat styling: no radial-gradient, linear-gradient, backdrop-filter glassmorphism, or ambient glows
            expect(styleCss).not.toContain('radial-gradient(');
            expect(styleCss).not.toContain('linear-gradient(');
            expect(styleCss).not.toContain('backdrop-filter:');
            expect(styleCss).not.toContain('-webkit-backdrop-filter:');
            expect(styleCss).not.toContain('--accent-glow');

            // 6. Accessible focus/disabled states and responsive breakpoints
            expect(styleCss).toContain(':focus-visible');
            expect(styleCss).toContain('button:disabled');
            expect(styleCss).toContain('@media (max-width: 1280px)');
            expect(styleCss).toContain('@media (max-width: 1024px)');
            expect(styleCss).toContain('@media (max-width: 640px)');
        });

        it('UI Modernization Navigation: clicking .server-item in #serversGrid switches active guild cleanly without #guildSelect or false-positive #floatingSaveBar', async () => {
            const alphaGuildId = 'nav_alpha_' + Date.now();
            const betaGuildId = 'nav_beta_' + Date.now();

            setDiscordClient({
                guilds: {
                    cache: new Map([
                        [
                            alphaGuildId,
                            {
                                id: alphaGuildId,
                                name: 'Alpha Workspace',
                                icon: null,
                                channels: { cache: new Map(), async fetch() { return this.cache; } },
                                roles: { cache: new Map(), async fetch() { return this.cache; } }
                            }
                        ],
                        [
                            betaGuildId,
                            {
                                id: betaGuildId,
                                name: 'Beta Workspace',
                                icon: null,
                                channels: { cache: new Map(), async fetch() { return this.cache; } },
                                roles: { cache: new Map(), async fetch() { return this.cache; } }
                            }
                        ]
                    ])
                }
            });

            const cookieHeader = await loginForGuilds([
                { id: alphaGuildId, name: 'Alpha Workspace', owner: true },
                { id: betaGuildId, name: 'Beta Workspace', owner: true }
            ]);

            await fetch(`${baseUrl}/api/guilds/${alphaGuildId}/settings`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
                body: JSON.stringify({ xp_min: 11, xp_max: 22, module_economy_enabled: true })
            });
            await fetch(`${baseUrl}/api/guilds/${betaGuildId}/settings`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
                body: JSON.stringify({ xp_min: 18, xp_max: 36, module_economy_enabled: false })
            });

            const { document, api } = createDashboardDomHarness({ baseUrl, cookieHeader });
            const saveBar = document.getElementById('floatingSaveBar');

            expect(document.getElementById('guildSelect')).toBeNull();

            // Authenticate and populate #serversGrid via checkAuth()
            await api.checkAuth();
            await new Promise(r => setTimeout(r, 150));

            expect(document.getElementById('authenticatedShell').style.display).toBe('grid');
            expect(document.getElementById('publicTopbar').style.display).toBe('none');
            expect(document.getElementById('landingLoginCard').style.display).toBe('none');

            const serverItems = document.querySelectorAll('#serversGrid .server-item');
            expect(serverItems).toHaveLength(2);
            expect(serverItems[0].getAttribute('data-guild-id')).toBe(alphaGuildId);
            expect(serverItems[1].getAttribute('data-guild-id')).toBe(betaGuildId);

            // Alpha Workspace auto-selected on initial load
            expect(api.getState().currentGuildId).toBe(alphaGuildId);
            expect(serverItems[0].classList.contains('selected')).toBe(true);
            expect(serverItems[1].classList.contains('selected')).toBe(false);
            expect(document.getElementById('selectedServerTitle').textContent).toBe('Alpha Workspace');
            expect(document.getElementById('selectedServerBadge').textContent).toBe(`ID: ${alphaGuildId}`);
            expect(document.getElementById('xp_min').value).toBe('11');
            expect(document.getElementById('module_economy_enabled').checked).toBe(true);
            expect(api.isFormDirty()).toBe(false);
            expect(saveBar.classList.contains('visible')).toBe(false);

            // Click second .server-item in #serversGrid to switch to Beta Workspace
            serverItems[1].click();
            await new Promise(r => setTimeout(r, 150));

            expect(api.getState().currentGuildId).toBe(betaGuildId);
            expect(serverItems[0].classList.contains('selected')).toBe(false);
            expect(serverItems[1].classList.contains('selected')).toBe(true);
            expect(document.getElementById('selectedServerTitle').textContent).toBe('Beta Workspace');
            expect(document.getElementById('selectedServerBadge').textContent).toBe(`ID: ${betaGuildId}`);
            expect(document.getElementById('xp_min').value).toBe('18');
            expect(document.getElementById('module_economy_enabled').checked).toBe(false);
            expect(api.isFormDirty()).toBe(false);
            expect(saveBar.classList.contains('visible')).toBe(false);

            // Expandable Modules dropdown starts collapsed and expands/collapses cleanly without dirtying #settingsForm
            const navButtons = document.querySelectorAll('#workspaceNav .workspace-nav-btn');
            expect(navButtons.length).toBe(3);

            const overviewBtn = document.querySelector('#workspaceNav [data-workspace-view="all"]');
            const modulesNavToggle = document.getElementById('modulesNavToggle');
            const modulesSubnav = document.getElementById('modulesSubnav');
            const auditBtn = document.querySelector('#workspaceNav [data-workspace-view="audit"]');

            expect(overviewBtn.classList.contains('active')).toBe(true);
            expect(modulesSubnav.style.display).toBe('none');
            expect(modulesNavToggle.getAttribute('aria-expanded')).toBe('false');
            expect(api.getModulesNavExpanded()).toBe(false);

            // Click Modules toggle -> expands subnav revealing all 6 modules without dirtying form
            modulesNavToggle.click();
            expect(modulesNavToggle.getAttribute('aria-expanded')).toBe('true');
            expect(modulesNavToggle.classList.contains('expanded')).toBe(true);
            expect(modulesSubnav.style.display).toBe('flex');
            expect(api.getModulesNavExpanded()).toBe(true);
            expect(api.isFormDirty()).toBe(false);
            expect(saveBar.classList.contains('visible')).toBe(false);

            const subnavBtns = document.querySelectorAll('#modulesSubnav .workspace-subnav-btn');
            expect(subnavBtns).toHaveLength(6);
            expect(subnavBtns.map(b => b.getAttribute('data-module-nav'))).toEqual([
                'general',
                'economy',
                'moderation',
                'xp',
                'gamerole',
                'voice'
            ]);
            expect(subnavBtns.map(b => b.querySelector('span').textContent.trim())).toEqual([
                'General',
                'Economy',
                'Moderation',
                'XP &amp; Leveling',
                'GameRole',
                'Temporary Voice'
            ]);

            // Click Modules toggle again -> collapses subnav without dirtying form
            modulesNavToggle.click();
            expect(modulesNavToggle.getAttribute('aria-expanded')).toBe('false');
            expect(modulesNavToggle.classList.contains('expanded')).toBe(false);
            expect(modulesSubnav.style.display).toBe('none');
            expect(api.getModulesNavExpanded()).toBe(false);
            expect(api.isFormDirty()).toBe(false);
            expect(saveBar.classList.contains('visible')).toBe(false);

            // Clicking Overview, each module subnav item, and Audit Logs switches views cleanly without dirtying form
            for (const btn of [overviewBtn, ...subnavBtns, auditBtn]) {
                btn.click();
                await new Promise(r => setTimeout(r, 40));
                expect(btn.classList.contains('active')).toBe(true);
                expect(api.isFormDirty()).toBe(false);
                expect(saveBar.classList.contains('visible')).toBe(false);
            }
        });

        it('Audit Log Workspace Isolation: Overview hides #auditRoutingCard & #auditLogsCard, while Audit Logs view displays both and persists settings via #settingsForm', async () => {
            const auditIsoGuildId = 'audit_iso_guild_' + Date.now();
            const channelCache = new Map([
                ['101010101010101010', { id: '101010101010101010', name: 'staff-audit', type: 0, position: 0 }],
                ['202020202020202020', { id: '202020202020202020', name: 'security-logs', type: 0, position: 1 }]
            ]);

            setDiscordClient({
                guilds: {
                    cache: new Map([
                        [
                            auditIsoGuildId,
                            {
                                id: auditIsoGuildId,
                                name: 'Audit Isolation Server',
                                channels: { cache: channelCache, async fetch() { return channelCache; } },
                                roles: { cache: new Map(), async fetch() { return this.cache; } }
                            }
                        ]
                    ])
                }
            });

            const cookieHeader = await loginForGuilds([{ id: auditIsoGuildId, name: 'Audit Isolation Server', owner: true }]);
            const { document, api } = createDashboardDomHarness({ baseUrl, cookieHeader });
            const saveBar = document.getElementById('floatingSaveBar');

            await api.loadAllCommands();
            await api.loadGuildSettings(auditIsoGuildId, 'Audit Isolation Server');
            await new Promise(r => setTimeout(r, 130));

            const settingsCard = document.getElementById('settingsCard');
            const statsGrid = document.getElementById('statsGrid');
            const auditRoutingCard = document.getElementById('auditRoutingCard');
            const auditLogsCard = document.getElementById('auditLogsCard');
            const bentoAuditDock = document.getElementById('bentoAuditDock');

            // 1. On Overview ('all'), #settingsCard & #statsGrid are visible while #auditRoutingCard & #auditLogsCard are hidden
            expect(api.getState().currentWorkspaceView).toBe('all');
            expect(statsGrid.style.display).toBe('flex');
            expect(settingsCard.style.display).toBe('block');
            expect(auditRoutingCard.style.display).toBe('none');
            expect(auditLogsCard.style.display).toBe('none');
            expect(bentoAuditDock.style.display).toBe('none');

            // Verify Audit Log inputs were moved out of #settingsCard into #auditRoutingCard and remain bound to #settingsForm
            expect(settingsCard.querySelector('#log_channel_id')).toBeNull();
            expect(auditRoutingCard.querySelector('#log_channel_id')).not.toBeNull();
            expect(document.getElementById('log_channel_id').getAttribute('form')).toBe('settingsForm');
            expect(auditRoutingCard.querySelector('#embed_color_hex_core')).not.toBeNull();

            const logEventKeys = [
                'log_events_member_join',
                'log_events_member_leave',
                'log_events_member_update',
                'log_events_message_delete',
                'log_events_channels',
                'log_events_roles',
                'log_events_moderation',
                'log_events_voice',
                'log_events_commands'
            ];
            for (const key of logEventKeys) {
                expect(settingsCard.querySelector(`#${key}`)).toBeNull();
                const checkbox = auditRoutingCard.querySelector(`#${key}`);
                expect(checkbox).not.toBeNull();
                expect(checkbox.getAttribute('form')).toBe('settingsForm');
            }

            // 2. Clicking Audit Logs ([data-workspace-view="audit"]) displays BOTH #auditRoutingCard and #auditLogsCard and hides #settingsCard cleanly
            const auditNavBtn = document.querySelector('#workspaceNav [data-workspace-view="audit"]');
            auditNavBtn.click();
            await new Promise(r => setTimeout(r, 50));

            expect(api.getState().currentWorkspaceView).toBe('audit');
            expect(auditNavBtn.classList.contains('active')).toBe(true);
            expect(settingsCard.style.display).toBe('none');
            expect(statsGrid.style.display).toBe('none');
            expect(auditRoutingCard.style.display).toBe('block');
            expect(auditLogsCard.style.display).toBe('block');
            expect(bentoAuditDock.style.display).toBe('block');
            expect(api.isFormDirty()).toBe(false);
            expect(saveBar.classList.contains('visible')).toBe(false);

            // 3. Editing log_channel_id, log_events_* checkboxes, and core embed color inside Audit Logs workspace marks #settingsForm dirty and saves cleanly
            const logSearch = document.getElementById('log_channel_search');
            const logDropdown = document.getElementById('log_channel_dropdown');
            logSearch.focus();
            const secChannelOpt = logDropdown.children.find(el => el.innerHTML.includes('#security-logs'));
            expect(secChannelOpt).toBeDefined();
            secChannelOpt.click();

            const voiceEventToggle = document.getElementById('log_events_voice');
            voiceEventToggle.checked = true;
            voiceEventToggle.dispatchEvent({ type: 'change', bubbles: true, target: voiceEventToggle });

            const joinEventToggle = document.getElementById('log_events_member_join');
            joinEventToggle.checked = false;
            joinEventToggle.dispatchEvent({ type: 'change', bubbles: true, target: joinEventToggle });

            api.setModuleEmbedColor('core', '#3366FF');

            expect(api.isFormDirty()).toBe(true);
            expect(saveBar.classList.contains('visible')).toBe(true);

            document.getElementById('settingsForm').requestSubmit();
            await new Promise(r => setTimeout(r, 80));

            expect(api.isFormDirty()).toBe(false);
            expect(saveBar.classList.contains('visible')).toBe(false);

            const savedRes = await fetch(`${baseUrl}/api/guilds/${auditIsoGuildId}/settings`, {
                headers: { Cookie: cookieHeader }
            });
            const savedJson = await savedRes.json();
            expect(savedJson.settings.log_channel_id).toBe('202020202020202020');
            expect(savedJson.settings.log_events_voice).toBe(true);
            expect(savedJson.settings.log_events_member_join).toBe(false);
            expect(savedJson.settings.module_embed_colors.core).toBe('#3366FF');
        });

        it('Per-Module Workspaces & Two-Way Enable/Disable Sync: module panels pair with studios and sync #workspace_toggle_<mod>, #module_<mod>_enabled, #subnav_dot_<mod>, and #floatingSaveBar', async () => {
            const modSyncGuildId = 'mod_sync_guild_' + Date.now();

            setDiscordClient({
                guilds: {
                    cache: new Map([
                        [
                            modSyncGuildId,
                            {
                                id: modSyncGuildId,
                                name: 'Module Workspace Server',
                                channels: {
                                    cache: new Map([
                                        ['303030303030303030', { id: '303030303030303030', name: 'xp-feed', type: 0, position: 0 }]
                                    ]),
                                    async fetch() { return this.cache; }
                                },
                                roles: {
                                    cache: new Map([
                                        ['404040404040404040', { id: '404040404040404040', name: 'Staff', position: 3, managed: false, hexColor: '#5865f2' }]
                                    ]),
                                    async fetch() { return this.cache; }
                                }
                            }
                        ]
                    ])
                }
            });

            const cookieHeader = await loginForGuilds([{ id: modSyncGuildId, name: 'Module Workspace Server', owner: true }]);
            const { document, api } = createDashboardDomHarness({ baseUrl, cookieHeader });
            const saveBar = document.getElementById('floatingSaveBar');

            await api.loadAllCommands();
            await api.loadGuildSettings(modSyncGuildId, 'Module Workspace Server');
            await new Promise(r => setTimeout(r, 130));

            const moduleMatrix = [
                {
                    mod: 'general',
                    expectedInputs: ['#embed_color_hex_general'],
                    studioVisible: { shop: false, warnings: false, voice: false }
                },
                {
                    mod: 'economy',
                    expectedInputs: ['#embed_color_hex_economy'],
                    studioVisible: { shop: true, warnings: false, voice: false }
                },
                {
                    mod: 'moderation',
                    expectedInputs: ['#embed_color_hex_moderation'],
                    studioVisible: { shop: false, warnings: true, voice: false }
                },
                {
                    mod: 'xp',
                    expectedInputs: ['#xp_min', '#xp_max', '#xp_voice_per_minute', '#xp_channel_id', '#role_rewards_enabled', '#roleRewardsList', '#embed_color_hex_xp'],
                    studioVisible: { shop: false, warnings: false, voice: false }
                },
                {
                    mod: 'gamerole',
                    expectedInputs: ['#gamerole_prefix', '#gamerole_position', '#gamerole_color', '#embed_color_hex_gamerole'],
                    studioVisible: { shop: false, warnings: false, voice: false }
                },
                {
                    mod: 'voice',
                    expectedInputs: ['#voice_naming_scheme', '#voice_default_limit', '#voiceHubsCount', '#voiceHubsList', '#embed_color_hex_voice'],
                    studioVisible: { shop: false, warnings: false, voice: true }
                }
            ];

            // 1. Clicking each module item under #modulesSubnav displays ONLY that module's workspace & paired studio without dirtying #settingsForm
            for (const entry of moduleMatrix) {
                const subnavBtn = document.querySelector(`#modulesSubnav .workspace-subnav-btn[data-module-nav="${entry.mod}"]`);
                expect(subnavBtn).not.toBeNull();
                subnavBtn.click();
                await new Promise(r => setTimeout(r, 50));

                expect(api.getState().currentWorkspaceView).toBe(`module:${entry.mod}`);
                expect(subnavBtn.classList.contains('active')).toBe(true);
                expect(document.getElementById('settingsCard').style.display).toBe('none');
                expect(document.getElementById('auditRoutingCard').style.display).toBe('none');
                expect(document.getElementById('auditLogsCard').style.display).toBe('none');

                for (const other of moduleMatrix) {
                    const panel = document.getElementById(`moduleWorkspace_${other.mod}`);
                    expect(panel.style.display).toBe(other.mod === entry.mod ? 'block' : 'none');
                }

                const activePanel = document.getElementById(`moduleWorkspace_${entry.mod}`);
                for (const selector of entry.expectedInputs) {
                    expect(activePanel.querySelector(selector)).not.toBeNull();
                }
                expect(activePanel.querySelector(`.module-cmd-roles[data-module="${entry.mod}"]`)).not.toBeNull();

                expect(document.getElementById('shopStudioCard').style.display).toBe(entry.studioVisible.shop ? 'block' : 'none');
                expect(document.getElementById('warningsConsoleCard').style.display).toBe(entry.studioVisible.warnings ? 'block' : 'none');
                expect(document.getElementById('voiceStudioCard').style.display).toBe(entry.studioVisible.voice ? 'block' : 'none');

                expect(api.isFormDirty()).toBe(false);
                expect(saveBar.classList.contains('visible')).toBe(false);
            }

            // 2. Two-way sync: toggling #workspace_toggle_<mod> syncs #module_<mod>_enabled, #subnav_dot_<mod>, #activeModulesCount, and #floatingSaveBar
            await api.setWorkspaceView('module:xp');
            const xpWorkspaceToggle = document.getElementById('workspace_toggle_xp');
            const xpPrimaryCheckbox = document.getElementById('module_xp_enabled');
            const xpSubnavDot = document.getElementById('subnav_dot_xp');
            const xpToggleLabel = document.getElementById('workspace_toggle_label_xp');

            expect(api.captureFormState()).not.toHaveProperty('workspace_toggle_xp');
            expect(xpWorkspaceToggle.checked).toBe(true);
            expect(xpPrimaryCheckbox.checked).toBe(true);
            expect(xpSubnavDot.getAttribute('data-enabled')).toBe('true');
            expect(xpSubnavDot.classList.contains('enabled')).toBe(true);
            expect(document.getElementById('activeModulesCount').textContent).toBe('6 / 6');

            // Toggle off inside module workspace -> marks dirty, updates primary checkbox + status dot + KPI
            xpWorkspaceToggle.checked = false;
            xpWorkspaceToggle.dispatchEvent({ type: 'change', bubbles: true, target: xpWorkspaceToggle });

            expect(xpPrimaryCheckbox.checked).toBe(false);
            expect(xpSubnavDot.getAttribute('data-enabled')).toBe('false');
            expect(xpSubnavDot.classList.contains('disabled')).toBe(true);
            expect(xpToggleLabel.textContent).toBe('Disabled');
            expect(document.getElementById('activeModulesCount').textContent).toBe('5 / 6');
            expect(api.isFormDirty()).toBe(true);
            expect(saveBar.classList.contains('visible')).toBe(true);

            // Reverting #workspace_toggle_xp clears dirty state
            xpWorkspaceToggle.checked = true;
            xpWorkspaceToggle.dispatchEvent({ type: 'change', bubbles: true, target: xpWorkspaceToggle });
            expect(xpPrimaryCheckbox.checked).toBe(true);
            expect(xpSubnavDot.getAttribute('data-enabled')).toBe('true');
            expect(document.getElementById('activeModulesCount').textContent).toBe('6 / 6');
            expect(api.isFormDirty()).toBe(false);
            expect(saveBar.classList.contains('visible')).toBe(false);

            // Reset button restores both #module_xp_enabled and #workspace_toggle_xp + #subnav_dot_xp
            xpWorkspaceToggle.checked = false;
            xpWorkspaceToggle.dispatchEvent({ type: 'change', bubbles: true, target: xpWorkspaceToggle });
            expect(saveBar.classList.contains('visible')).toBe(true);

            document.getElementById('resetBtn').click();
            expect(xpPrimaryCheckbox.checked).toBe(true);
            expect(xpWorkspaceToggle.checked).toBe(true);
            expect(xpSubnavDot.getAttribute('data-enabled')).toBe('true');
            expect(xpToggleLabel.textContent).toBe('Enabled');
            expect(api.isFormDirty()).toBe(false);
            expect(saveBar.classList.contains('visible')).toBe(false);

            // Toggling primary checkbox on Overview also syncs #workspace_toggle_<mod> and #subnav_dot_<mod>, and saving persists cleanly
            await api.setWorkspaceView('all');
            const econPrimary = document.getElementById('module_economy_enabled');
            const econWorkspaceToggle = document.getElementById('workspace_toggle_economy');
            const econSubnavDot = document.getElementById('subnav_dot_economy');

            econPrimary.checked = false;
            econPrimary.dispatchEvent({ type: 'change', bubbles: true, target: econPrimary });
            expect(econWorkspaceToggle.checked).toBe(false);
            expect(econSubnavDot.getAttribute('data-enabled')).toBe('false');
            expect(api.isFormDirty()).toBe(true);
            expect(saveBar.classList.contains('visible')).toBe(true);

            document.getElementById('settingsForm').requestSubmit();
            await new Promise(r => setTimeout(r, 80));

            expect(api.isFormDirty()).toBe(false);
            expect(saveBar.classList.contains('visible')).toBe(false);
            expect(econWorkspaceToggle.checked).toBe(false);
            expect(econSubnavDot.getAttribute('data-enabled')).toBe('false');

            const verifyRes = await fetch(`${baseUrl}/api/guilds/${modSyncGuildId}/settings`, {
                headers: { Cookie: cookieHeader }
            });
            const verifyJson = await verifyRes.json();
            expect(verifyJson.settings.module_economy_enabled).toBe(false);
        });

        it('M4, M5 & Studio Dirty-State Isolation: multi-role combobox chips/cascade, custom embed color dirty state, and clean auxiliary Studio inputs', async () => {
            const uiGuildId = 'ui_overhaul_guild_' + Date.now();
            const channelCache = new Map([
                ['cat_1', { id: 'cat_1', name: 'Voice Hub Category', type: 4, position: 0 }],
                ['ch_log', { id: 'ch_log', name: 'audit-log', type: 0, position: 1 }]
            ]);

            setDiscordClient({
                guilds: {
                    cache: new Map([
                        [
                            uiGuildId,
                            {
                                id: uiGuildId,
                                name: 'Bento UI Server',
                                channels: {
                                    cache: channelCache,
                                    async fetch() {
                                        return channelCache;
                                    },
                                    async create(opts) {
                                        const created = {
                                            id: 'ui_created_' + Date.now(),
                                            name: opts.name,
                                            type: opts.type,
                                            position: 2,
                                            parentId: opts.parent || null
                                        };
                                        channelCache.set(created.id, created);
                                        return created;
                                    }
                                },
                                roles: {
                                    cache: new Map([
                                        ['333333333333333333', { id: '333333333333333333', name: 'Moderator', position: 6, managed: false, hexColor: '#5865f2' }],
                                        ['444444444444444444', { id: '444444444444444444', name: 'VIP', position: 5, managed: false, hexColor: '#23a55a' }],
                                        ['555555555555555555', { id: '555555555555555555', name: 'DJ', position: 4, managed: false, hexColor: '#f1c40f' }]
                                    ]),
                                    async fetch() {
                                        return this.cache;
                                    }
                                }
                            }
                        ]
                    ])
                }
            });

            const cookieHeader = await loginForGuilds([{ id: uiGuildId, name: 'Bento UI Server', owner: true }]);
            const harness = createDashboardDomHarness({ baseUrl, cookieHeader });
            const { document, api } = harness;
            const saveBar = document.getElementById('floatingSaveBar');

            await api.loadAllCommands();
            await api.loadGuildSettings(uiGuildId, 'Bento UI Server');
            await new Promise(r => setTimeout(r, 130));

            expect(api.isFormDirty()).toBe(false);
            expect(saveBar.classList.contains('visible')).toBe(false);

            // --- Part A: Auxiliary inputs in Voice Hub Studio, Economy Shop composer, Warnings search, and Workspace switcher NEVER mark #settingsForm dirty ---
            const auxiliaryEdits = [
                ['voiceHubCreateName', 'Custom Squad Hub'],
                ['voiceHubCategorySelect', 'cat_1'],
                ['voiceHubNewCategoryName', 'Temp Voice Rooms'],
                ['shopItemName', 'Diamond Sword'],
                ['shopItemPrice', '750'],
                ['shopItemStock', '15'],
                ['shopItemRoleSelect', '444444444444444444'],
                ['shopItemDesc', 'Legendary weapon role'],
                ['warningsSearchInput', 'spam']
            ];

            for (const [inputId, nextVal] of auxiliaryEdits) {
                const el = document.getElementById(inputId);
                expect(el).not.toBeNull();
                el.value = nextVal;
                el.dispatchEvent({ type: 'input', bubbles: true, target: el });
                el.dispatchEvent({ type: 'change', bubbles: true, target: el });
                expect(api.isFormDirty()).toBe(false);
                expect(saveBar.classList.contains('visible')).toBe(false);
            }

            // Switching workspace views never marks form dirty
            await api.setWorkspaceView('shop');
            expect(document.getElementById('moduleWorkspace_economy').style.display).toBe('block');
            expect(document.getElementById('shopStudioCard').style.display).toBe('block');
            await api.setWorkspaceView('all');
            expect(api.isFormDirty()).toBe(false);
            expect(saveBar.classList.contains('visible')).toBe(false);

            // Executing studio actions (create hub, create shop item) keeps #floatingSaveBar hidden
            const hubResult = await api.createVoiceHub();
            expect(hubResult.success).toBe(true);
            const shopResult = await api.saveShopItem();
            expect(shopResult.success).toBe(true);
            expect(api.isFormDirty()).toBe(false);
            expect(saveBar.classList.contains('visible')).toBe(false);

            // --- Part B: Custom module embed color editing marks form dirty, and reverting/saving clears dirty state ---
            const econHexInput = document.getElementById('embed_color_hex_economy');
            expect(econHexInput).not.toBeNull();
            econHexInput.value = '#12AB34';
            econHexInput.dispatchEvent({ type: 'input', bubbles: true, target: econHexInput });

            expect(api.getModuleEmbedColors().economy).toBe('#12AB34');
            expect(api.isFormDirty()).toBe(true);
            expect(saveBar.classList.contains('visible')).toBe(true);

            // Reverting via resetModuleEmbedColor clears dirty state
            api.resetModuleEmbedColor('economy');
            expect(api.getModuleEmbedColors().economy).toBeUndefined();
            expect(api.isFormDirty()).toBe(false);
            expect(saveBar.classList.contains('visible')).toBe(false);

            // Setting custom color again and saving persists and clears dirty state
            api.setModuleEmbedColor('xp', '#00DDAA');
            expect(api.isFormDirty()).toBe(true);
            expect(saveBar.classList.contains('visible')).toBe(true);

            document.getElementById('settingsForm').requestSubmit();
            await new Promise(r => setTimeout(r, 80));
            expect(api.isFormDirty()).toBe(false);
            expect(saveBar.classList.contains('visible')).toBe(false);

            // --- Part C: Multi-role command combobox toggling multiple roles, cascading to subcommands, removing role chip, and saving arrays ---
            await api.openModal('voiceModal');
            const voiceSearch = document.getElementById('cmd_role_search_voice');
            const voiceDrop = document.getElementById('cmd_role_drop_voice');
            const voiceChips = document.getElementById('cmd_role_chips_voice');
            expect(voiceSearch).not.toBeNull();

            // Select first role (@Moderator) on parent /voice
            voiceSearch.focus();
            const modOption = voiceDrop.children.find(el => el.innerHTML.includes('@Moderator'));
            expect(modOption).toBeDefined();
            modOption.click();

            // Select second role (@VIP) on parent /voice -> becomes multi-role array & cascades to subcommands
            voiceSearch.focus();
            const vipOption = voiceDrop.children.find(el => el.innerHTML.includes('@VIP'));
            expect(vipOption).toBeDefined();
            vipOption.click();

            expect(api.getCommandRoles()['voice']).toEqual(['333333333333333333', '444444444444444444']);
            expect(api.getCommandRoles()['voice lock']).toEqual(['333333333333333333', '444444444444444444']);
            expect(voiceChips.querySelectorAll('[data-remove-role]').length).toBe(2);
            expect(api.isFormDirty()).toBe(true);
            expect(saveBar.classList.contains('visible')).toBe(true);

            // Add third role (@DJ) to 'voice lock' subcommand, then remove @Moderator chip from 'voice lock' -> subcommand holds ['444444444444444444', '555555555555555555'] while parent retains ['333333333333333333', '444444444444444444']
            const lockSearch = document.getElementById('cmd_role_search_voice_lock');
            const lockDrop = document.getElementById('cmd_role_drop_voice_lock');
            const lockChips = document.getElementById('cmd_role_chips_voice_lock');
            lockSearch.focus();
            const djSubOption = lockDrop.children.find(el => el.innerHTML.includes('@DJ'));
            expect(djSubOption).toBeDefined();
            djSubOption.click();
            expect(api.getCommandRoles()['voice lock']).toEqual([
                '333333333333333333',
                '444444444444444444',
                '555555555555555555'
            ]);

            const removeModChipBtn = lockChips.querySelector('[data-remove-role="333333333333333333"]');
            expect(removeModChipBtn).not.toBeNull();
            removeModChipBtn.click();

            expect(api.getCommandRoles()['voice']).toEqual(['333333333333333333', '444444444444444444']);
            expect(api.getCommandRoles()['voice lock']).toEqual(['444444444444444444', '555555555555555555']);

            // Save settings -> persists command_roles arrays & module_embed_colors to backend and clears dirty state
            api.closeModal('voiceModal');
            document.getElementById('settingsForm').requestSubmit();
            await new Promise(r => setTimeout(r, 80));

            expect(api.isFormDirty()).toBe(false);
            expect(saveBar.classList.contains('visible')).toBe(false);

            const verifyRes = await fetch(`${baseUrl}/api/guilds/${uiGuildId}/settings`, {
                headers: { Cookie: cookieHeader }
            });
            const verifyJson = await verifyRes.json();
            expect(verifyJson.settings.module_embed_colors).toEqual({ xp: '#00DDAA' });
            expect(verifyJson.settings.command_roles.voice).toEqual(['333333333333333333', '444444444444444444']);
            expect(verifyJson.settings.command_roles['voice lock']).toEqual(['444444444444444444', '555555555555555555']);
        });

        it('Rate Limiting Middleware: enforces RateLimit-* headers, 429 + Retry-After on /auth, /api/auth, and /api, IP isolation, and resetAllRateLimiters()', async () => {
            try {
                // 1. /auth/discord enforces authRateLimiter (max 30 per IP)
                let lastAuthRes = null;
                for (let i = 1; i <= 30; i++) {
                    lastAuthRes = await fetch(`${baseUrl}/auth/discord`, {
                        headers: { 'X-Forwarded-For': '198.51.100.11' },
                        redirect: 'manual'
                    });
                    expect(lastAuthRes.status).not.toBe(429);
                }
                expect(lastAuthRes.headers.get('ratelimit-limit')).toBe('30');
                expect(lastAuthRes.headers.get('ratelimit-remaining')).toBe('0');
                expect(Number(lastAuthRes.headers.get('ratelimit-reset'))).toBeGreaterThanOrEqual(1);

                const blockedAuthRes = await fetch(`${baseUrl}/auth/discord`, {
                    headers: { 'X-Forwarded-For': '198.51.100.11' },
                    redirect: 'manual'
                });
                expect(blockedAuthRes.status).toBe(429);
                expect(Number(blockedAuthRes.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
                const blockedAuthBody = await blockedAuthRes.json();
                expect(blockedAuthBody.error).toContain('Too many authentication attempts');
                expect(blockedAuthBody.retryAfter).toBeGreaterThanOrEqual(1);

                // 2. /api/auth/me also enforces authRateLimiter (max 30 per IP)
                for (let i = 1; i <= 30; i++) {
                    const okRes = await fetch(`${baseUrl}/api/auth/me`, {
                        headers: { 'X-Forwarded-For': '198.51.100.12' }
                    });
                    expect(okRes.status).toBe(200);
                }
                const blockedApiAuthRes = await fetch(`${baseUrl}/api/auth/me`, {
                    headers: { 'X-Forwarded-For': '198.51.100.12' }
                });
                expect(blockedApiAuthRes.status).toBe(429);
                expect(Number(blockedApiAuthRes.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);

                // 3. /api/stats enforces apiRateLimiter (max 300 per IP) while keeping other IPs unaffected
                const firstApiRes = await fetch(`${baseUrl}/api/stats`, {
                    headers: { 'X-Forwarded-For': '198.51.100.13' }
                });
                expect(firstApiRes.status).toBe(200);
                expect(firstApiRes.headers.get('ratelimit-limit')).toBe('300');
                expect(firstApiRes.headers.get('ratelimit-remaining')).toBe('299');
                expect(Number(firstApiRes.headers.get('ratelimit-reset'))).toBeGreaterThanOrEqual(1);

                for (let batchStart = 2; batchStart <= 300; batchStart += 50) {
                    const batchEnd = Math.min(300, batchStart + 49);
                    const reqs = [];
                    for (let i = batchStart; i <= batchEnd; i++) {
                        reqs.push(fetch(`${baseUrl}/api/stats`, {
                            headers: { 'X-Forwarded-For': '198.51.100.13' }
                        }));
                    }
                    const responses = await Promise.all(reqs);
                    for (const r of responses) {
                        expect(r.status).toBe(200);
                    }
                }

                const blockedApiRes = await fetch(`${baseUrl}/api/stats`, {
                    headers: { 'X-Forwarded-For': '198.51.100.13' }
                });
                expect(blockedApiRes.status).toBe(429);
                expect(Number(blockedApiRes.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
                const blockedApiBody = await blockedApiRes.json();
                expect(blockedApiBody.error).toContain('Too many API requests');

                // Unrelated IP still succeeds
                const otherIpRes = await fetch(`${baseUrl}/api/stats`, {
                    headers: { 'X-Forwarded-For': '198.51.100.14' }
                });
                expect(otherIpRes.status).toBe(200);

                // resetAllRateLimiters() clears counters immediately
                resetAllRateLimiters();
                const afterResetRes = await fetch(`${baseUrl}/auth/discord`, {
                    headers: { 'X-Forwarded-For': '198.51.100.11' },
                    redirect: 'manual'
                });
                expect(afterResetRes.status).not.toBe(429);
            } finally {
                resetAllRateLimiters();
            }
        });

        it('Disaster Recovery SQLite Backups API & #exportDbBackupBtn UI: list, create, export/download gunzip verification, delete, auth guards, and 400 traversal protection', async () => {
            const tempBackupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sugoibot-dash-backups-'));
            const prevBackupDir = process.env.BACKUP_DIR;
            process.env.BACKUP_DIR = tempBackupDir;

            try {
                // 1. Unauthenticated requests return 401 across all backup endpoints
                expect((await fetch(`${baseUrl}/api/backups`)).status).toBe(401);
                expect((await fetch(`${baseUrl}/api/backups`, { method: 'POST' })).status).toBe(401);
                expect((await fetch(`${baseUrl}/api/backups/export`)).status).toBe(401);
                expect((await fetch(`${baseUrl}/api/backups/sugoibot-backup-2026.sqlite.gz/download`)).status).toBe(401);
                expect((await fetch(`${baseUrl}/api/backups/sugoibot-backup-2026.sqlite.gz`, { method: 'DELETE' })).status).toBe(401);

                // 2. Non-admin session (no manageable guilds) returns 403
                const viewerCookie = await loginForGuilds([
                    { id: 'viewer_only_guild', name: 'Read Only Server', permissions: '0', owner: false }
                ], { id: 'viewer_u1', username: 'ViewerUser' });

                expect((await fetch(`${baseUrl}/api/backups`, { headers: { Cookie: viewerCookie } })).status).toBe(403);
                expect((await fetch(`${baseUrl}/api/backups`, { method: 'POST', headers: { Cookie: viewerCookie } })).status).toBe(403);
                expect((await fetch(`${baseUrl}/api/backups/export`, { headers: { Cookie: viewerCookie } })).status).toBe(403);
                expect((await fetch(`${baseUrl}/api/backups/sugoibot-backup-2026.sqlite.gz/download`, { headers: { Cookie: viewerCookie } })).status).toBe(403);
                expect((await fetch(`${baseUrl}/api/backups/sugoibot-backup-2026.sqlite.gz`, { method: 'DELETE', headers: { Cookie: viewerCookie } })).status).toBe(403);

                // 3. Admin session lifecycle: list -> create -> list -> export -> download -> traversal 400 -> delete -> 404
                const bkpGuildId = 'backup_admin_guild_' + Date.now();
                const adminCookie = await loginForGuilds([
                    { id: bkpGuildId, name: 'Backup Admin Server', owner: true }
                ], { id: 'bkp_admin_1', username: 'BackupAdmin' });

                const initialListRes = await fetch(`${baseUrl}/api/backups`, {
                    headers: { Cookie: adminCookie }
                });
                expect(initialListRes.status).toBe(200);
                expect(await initialListRes.json()).toEqual({ backups: [] });

                const createRes = await fetch(`${baseUrl}/api/backups`, {
                    method: 'POST',
                    headers: { Cookie: adminCookie }
                });
                expect(createRes.status).toBe(201);
                const createdData = await createRes.json();
                expect(createdData.success).toBe(true);
                expect(createdData.backup.filename).toMatch(/^sugoibot-backup-[A-Za-z0-9._-]+\.sqlite\.gz$/);
                expect(createdData.backup.sizeBytes).toBeGreaterThan(0);

                const secondListRes = await fetch(`${baseUrl}/api/backups`, {
                    headers: { Cookie: adminCookie }
                });
                expect(secondListRes.status).toBe(200);
                const secondListData = await secondListRes.json();
                expect(secondListData.backups).toHaveLength(1);
                expect(secondListData.backups[0].filename).toBe(createdData.backup.filename);

                // GET /api/backups/export returns valid gunzippable SQLite database
                const exportRes = await fetch(`${baseUrl}/api/backups/export`, {
                    headers: { Cookie: adminCookie }
                });
                expect(exportRes.status).toBe(200);
                expect(exportRes.headers.get('content-type')).toContain('application/gzip');
                expect(exportRes.headers.get('content-disposition')).toMatch(/attachment; filename="sugoibot-backup-.*\.sqlite\.gz"/);
                const exportedRaw = gunzipSync(Buffer.from(await exportRes.arrayBuffer()));
                expect(exportedRaw.subarray(0, 16).toString('utf8')).toBe('SQLite format 3\0');

                // GET /api/backups/:filename/download returns valid gunzippable SQLite database
                const downloadRes = await fetch(`${baseUrl}/api/backups/${encodeURIComponent(createdData.backup.filename)}/download`, {
                    headers: { Cookie: adminCookie }
                });
                expect(downloadRes.status).toBe(200);
                expect(downloadRes.headers.get('content-type')).toContain('application/gzip');
                expect(downloadRes.headers.get('content-disposition')).toContain(createdData.backup.filename);
                const downloadedRaw = gunzipSync(Buffer.from(await downloadRes.arrayBuffer()));
                expect(downloadedRaw.subarray(0, 16).toString('utf8')).toBe('SQLite format 3\0');

                // Path-traversal and malformed filenames return 400
                for (const badName of [
                    '..%2Fdatabase.sqlite',
                    '..%5Cdatabase.sqlite',
                    'sugoibot-backup-..sqlite.gz',
                    'arbitrary.sqlite'
                ]) {
                    const badDlRes = await fetch(`${baseUrl}/api/backups/${badName}/download`, {
                        headers: { Cookie: adminCookie }
                    });
                    expect(badDlRes.status).toBe(400);

                    const badDelRes = await fetch(`${baseUrl}/api/backups/${badName}`, {
                        method: 'DELETE',
                        headers: { Cookie: adminCookie }
                    });
                    expect(badDelRes.status).toBe(400);
                }

                // Missing valid backup filename returns 404
                const missingName = 'sugoibot-backup-1999-01-01T00-00-00-000Z.sqlite.gz';
                expect((await fetch(`${baseUrl}/api/backups/${missingName}/download`, { headers: { Cookie: adminCookie } })).status).toBe(404);
                expect((await fetch(`${baseUrl}/api/backups/${missingName}`, { method: 'DELETE', headers: { Cookie: adminCookie } })).status).toBe(404);

                // DELETE /api/backups/:filename removes snapshot and subsequent DELETE returns 404
                const delRes = await fetch(`${baseUrl}/api/backups/${encodeURIComponent(createdData.backup.filename)}`, {
                    method: 'DELETE',
                    headers: { Cookie: adminCookie }
                });
                expect(delRes.status).toBe(200);
                expect(await delRes.json()).toEqual({
                    success: true,
                    deleted: createdData.backup.filename
                });
                expect((await fetch(`${baseUrl}/api/backups/${encodeURIComponent(createdData.backup.filename)}`, {
                    method: 'DELETE',
                    headers: { Cookie: adminCookie }
                })).status).toBe(404);

                // 4. Dashboard UI #exportDbBackupBtn downloads .sqlite.gz cleanly without marking #settingsForm dirty
                setDiscordClient({
                    guilds: {
                        cache: new Map([
                            [bkpGuildId, {
                                id: bkpGuildId,
                                name: 'Backup Admin Server',
                                channels: { cache: new Map(), async fetch() { return this.cache; } },
                                roles: { cache: new Map(), async fetch() { return this.cache; } }
                            }]
                        ])
                    }
                });

                const { document, api } = createDashboardDomHarness({ baseUrl, cookieHeader: adminCookie });
                await api.loadAllCommands();
                await api.loadGuildSettings(bkpGuildId, 'Backup Admin Server');
                await new Promise(r => setTimeout(r, 120));

                const exportDbBtn = document.getElementById('exportDbBackupBtn');
                expect(exportDbBtn).not.toBeNull();
                expect(exportDbBtn.querySelector('svg')).not.toBeNull();
                expect(exportDbBtn.querySelector('span')?.textContent).toBe('Backup DB');

                const dlResult = await api.exportDatabaseBackup();
                expect(dlResult).not.toBeNull();
                expect(dlResult.filename).toMatch(/^sugoibot-backup-.*\.sqlite\.gz$/);
                expect(dlResult.sizeBytes).toBeGreaterThan(0);
                expect(api.isFormDirty()).toBe(false);
                expect(document.getElementById('floatingSaveBar').classList.contains('visible')).toBe(false);
            } finally {
                if (prevBackupDir === undefined) delete process.env.BACKUP_DIR;
                else process.env.BACKUP_DIR = prevBackupDir;
                fs.rmSync(tempBackupDir, { recursive: true, force: true });
            }
        });

        it('GitHub Issue #2: GET /voice prunes stale Room (<channelId>) rows via discordClient & REST fallback, /voice/stream pushes live SSE updates, and DOM connectVoiceStream updates #voiceStudioCard with zero live indicator', async () => {
            const issue2GuildId = 'issue2_voice_guild_' + Date.now();
            const cookieHeader = await loginForGuilds([
                { id: issue2GuildId, name: 'Issue 2 Voice Server', owner: true }
            ]);

            let emptyChannelDeleted = false;
            const channelCache = new Map([
                ['cat_voice', { id: 'cat_voice', name: 'Temporary Voice', type: 4, position: 0 }],
                ['hub_main', { id: 'hub_main', name: 'Join to Create', type: 2, position: 1, parentId: 'cat_voice' }],
                [
                    'active_room_777',
                    {
                        id: 'active_room_777',
                        name: "sugoi.js's Room",
                        type: 2,
                        position: 2,
                        parentId: 'cat_voice',
                        userLimit: 4,
                        members: new Map([['u_1', { id: 'u_1' }]])
                    }
                ],
                [
                    'empty_abandoned_room',
                    {
                        id: 'empty_abandoned_room',
                        name: 'Ghost Empty Room',
                        type: 2,
                        position: 3,
                        parentId: 'cat_voice',
                        userLimit: 0,
                        members: new Map(),
                        async delete() {
                            emptyChannelDeleted = true;
                            channelCache.delete('empty_abandoned_room');
                        }
                    }
                ]
            ]);

            setDiscordClient({
                guilds: {
                    cache: new Map([
                        [
                            issue2GuildId,
                            {
                                id: issue2GuildId,
                                name: 'Issue 2 Voice Server',
                                channels: {
                                    cache: channelCache,
                                    async fetch() {
                                        return channelCache;
                                    }
                                },
                                roles: {
                                    cache: new Map(),
                                    async fetch() {
                                        return this.cache;
                                    }
                                }
                            }
                        ]
                    ])
                }
            });

            db.prepare('INSERT OR REPLACE INTO voice_hubs (hubChannelId, guildId, categoryId) VALUES (?, ?, ?)').run(
                'hub_main',
                issue2GuildId,
                'cat_voice'
            );

            const staleChannelId = '1562165557103566918';
            const oldCreatedAt = Date.now() - 60_000;
            // Seed orphaned channel (deleted in Discord), abandoned empty room, and active room across voice_channels & voicemaster_channels
            db.prepare('INSERT OR REPLACE INTO voice_channels (channelId, guildId, ownerId, createdAt) VALUES (?, ?, ?, ?)').run(
                staleChannelId,
                issue2GuildId,
                'owner_stale',
                oldCreatedAt
            );
            db.prepare('INSERT OR REPLACE INTO voicemaster_channels (channelId, guildId, ownerId, createdAt) VALUES (?, ?, ?, ?)').run(
                staleChannelId,
                issue2GuildId,
                'owner_stale',
                oldCreatedAt
            );
            db.prepare('INSERT OR REPLACE INTO voice_channels (channelId, guildId, ownerId, createdAt) VALUES (?, ?, ?, ?)').run(
                'empty_abandoned_room',
                issue2GuildId,
                'owner_empty',
                oldCreatedAt
            );
            db.prepare('INSERT OR REPLACE INTO voice_channels (channelId, guildId, ownerId, createdAt) VALUES (?, ?, ?, ?)').run(
                'active_room_777',
                issue2GuildId,
                'owner_active',
                oldCreatedAt
            );

            // 1. GET /voice prunes orphaned Room (1562165557103566918) + empty abandoned room via discordClient
            const voiceRes = await fetch(`${baseUrl}/api/guilds/${issue2GuildId}/voice`, {
                headers: { Cookie: cookieHeader }
            });
            expect(voiceRes.status).toBe(200);
            const voiceData = await voiceRes.json();
            expect(voiceData.activeRooms).toEqual([
                expect.objectContaining({
                    channelId: 'active_room_777',
                    ownerId: 'owner_active',
                    name: "sugoi.js's Room",
                    userLimit: 4
                })
            ]);
            expect(JSON.stringify(voiceData.activeRooms)).not.toContain(`Room (${staleChannelId})`);
            expect(emptyChannelDeleted).toBe(true);
            expect(db.prepare('SELECT * FROM voice_channels WHERE channelId = ?').get(staleChannelId)).toBeUndefined();
            expect(db.prepare('SELECT * FROM voicemaster_channels WHERE channelId = ?').get(staleChannelId)).toBeUndefined();
            expect(db.prepare('SELECT * FROM voice_channels WHERE channelId = ?').get('empty_abandoned_room')).toBeUndefined();

            // 2. GET /voice REST fallback also prunes stale Room (1562165557103566918) when discordClient is detached
            setDiscordClient(null);
            db.prepare('INSERT OR REPLACE INTO voice_channels (channelId, guildId, ownerId, createdAt) VALUES (?, ?, ?, ?)').run(
                staleChannelId,
                issue2GuildId,
                'owner_stale_rest',
                oldCreatedAt
            );
            db.prepare('INSERT OR REPLACE INTO voicemaster_channels (channelId, guildId, ownerId, createdAt) VALUES (?, ?, ?, ?)').run(
                staleChannelId,
                issue2GuildId,
                'owner_stale_rest',
                oldCreatedAt
            );

            const prevToken = process.env.DISCORD_TOKEN;
            process.env.DISCORD_TOKEN = '"mock_issue2_rest_token"';
            const realFetch = global.fetch;
            global.fetch = async (url, options) => {
                if (String(url) === `https://discord.com/api/v10/guilds/${issue2GuildId}/channels`) {
                    return new Response(
                        JSON.stringify([
                            { id: 'cat_voice', name: 'Temporary Voice', type: 4, position: 0 },
                            { id: 'hub_main', name: 'Join to Create', type: 2, position: 1, parent_id: 'cat_voice' },
                            { id: 'active_room_777', name: "sugoi.js's Room", type: 2, position: 2, parent_id: 'cat_voice', user_limit: 4 }
                        ]),
                        { status: 200, headers: { 'Content-Type': 'application/json' } }
                    );
                }
                return realFetch(url, options);
            };

            try {
                const restVoiceRes = await realFetch(`${baseUrl}/api/guilds/${issue2GuildId}/voice`, {
                    headers: { Cookie: cookieHeader }
                });
                expect(restVoiceRes.status).toBe(200);
                const restVoiceData = await restVoiceRes.json();
                expect(restVoiceData.activeRooms).toHaveLength(1);
                expect(restVoiceData.activeRooms[0].channelId).toBe('active_room_777');
                expect(db.prepare('SELECT * FROM voice_channels WHERE channelId = ?').get(staleChannelId)).toBeUndefined();
                expect(db.prepare('SELECT * FROM voicemaster_channels WHERE channelId = ?').get(staleChannelId)).toBeUndefined();
            } finally {
                global.fetch = realFetch;
                if (prevToken === undefined) delete process.env.DISCORD_TOKEN;
                else process.env.DISCORD_TOKEN = prevToken;
            }

            // Re-attach live discordClient for SSE stream & DOM tests
            setDiscordClient({
                guilds: {
                    cache: new Map([
                        [
                            issue2GuildId,
                            {
                                id: issue2GuildId,
                                name: 'Issue 2 Voice Server',
                                channels: { cache: channelCache, async fetch() { return channelCache; } },
                                roles: { cache: new Map(), async fetch() { return this.cache; } }
                            }
                        ]
                    ])
                }
            });

            // 3. GET /api/guilds/:guildId/voice/stream SSE auth guards + real-time push on emitVoiceUpdate
            expect((await fetch(`${baseUrl}/api/guilds/${issue2GuildId}/voice/stream`)).status).toBe(401);
            expect((await fetch(`${baseUrl}/api/guilds/forbidden_guild/voice/stream`, { headers: { Cookie: cookieHeader } })).status).toBe(403);

            const abortController = new AbortController();
            const streamRes = await fetch(`${baseUrl}/api/guilds/${issue2GuildId}/voice/stream`, {
                headers: { Cookie: cookieHeader },
                signal: abortController.signal
            });
            expect(streamRes.status).toBe(200);
            expect(streamRes.headers.get('content-type')).toContain('text/event-stream');

            const reader = streamRes.body.getReader();
            const decoder = new TextDecoder();
            let sseBuffer = '';

            const readNextDataPayload = async () => {
                while (true) {
                    const blocks = sseBuffer.split('\n\n');
                    sseBuffer = blocks.pop() || '';
                    for (const block of blocks) {
                        const lines = block.split('\n');
                        const hasEventConnected = lines.some(l => l.startsWith('event: connected'));
                        const dataLine = lines.find(l => l.startsWith('data: '));
                        if (!hasEventConnected && dataLine) {
                            return JSON.parse(dataLine.slice(6));
                        }
                    }
                    const chunk = await reader.read();
                    if (chunk.done) throw new Error('SSE stream ended unexpectedly');
                    sseBuffer += decoder.decode(chunk.value, { stream: true });
                }
            };

            try {
                const initialSnapshot = await readNextDataPayload();
                expect(initialSnapshot.guildId).toBe(issue2GuildId);
                expect(initialSnapshot.activeRooms.map(r => r.channelId)).toEqual(['active_room_777']);

                // Add a new temporary room and emit voice update -> pushed immediately over SSE
                channelCache.set('live_room_888', {
                    id: 'live_room_888',
                    name: 'Squad Alpha',
                    type: 2,
                    position: 4,
                    parentId: 'cat_voice',
                    userLimit: 5,
                    members: new Map([['u_2', { id: 'u_2' }]])
                });
                db.prepare('INSERT OR REPLACE INTO voice_channels (channelId, guildId, ownerId, createdAt) VALUES (?, ?, ?, ?)').run(
                    'live_room_888',
                    issue2GuildId,
                    'owner_alpha',
                    Date.now()
                );
                emitVoiceUpdate(issue2GuildId);

                const secondSnapshot = await readNextDataPayload();
                expect(secondSnapshot.activeRooms.map(r => r.name)).toEqual(["sugoi.js's Room", 'Squad Alpha']);

                // Delete channel from Discord cache and emitVoiceUpdate -> SSE prunes stale DB row and pushes clean list
                channelCache.delete('live_room_888');
                emitVoiceUpdate(issue2GuildId);

                const thirdSnapshot = await readNextDataPayload();
                expect(thirdSnapshot.activeRooms.map(r => r.channelId)).toEqual(['active_room_777']);
                expect(db.prepare('SELECT * FROM voice_channels WHERE channelId = ?').get('live_room_888')).toBeUndefined();
            } finally {
                abortController.abort();
            }

            // 4. DOM connectVoiceStream live updates + category dropdown preservation + zero #floatingSaveBar dirty state + ZERO "live" indicator
            const eventSourceInstances = [];
            class MockEventSource {
                constructor(url) {
                    this.url = url;
                    this.closed = false;
                    this.onmessage = null;
                    this.onerror = null;
                    this.listeners = new Map();
                    eventSourceInstances.push(this);
                }
                addEventListener(type, fn) {
                    if (!this.listeners.has(type)) this.listeners.set(type, []);
                    this.listeners.get(type).push(fn);
                }
                close() {
                    this.closed = true;
                }
            }

            const { document, api } = createDashboardDomHarness({
                baseUrl,
                cookieHeader,
                EventSource: MockEventSource
            });
            const saveBar = document.getElementById('floatingSaveBar');

            await api.loadAllCommands();
            await api.selectGuild(issue2GuildId, 'Issue 2 Voice Server');
            await new Promise(r => setTimeout(r, 130));
            await api.setWorkspaceView('module:voice');

            const voiceStreamEs = eventSourceInstances.find(es => es.url === `/api/guilds/${issue2GuildId}/voice/stream`);
            expect(voiceStreamEs).toBeDefined();
            expect(voiceStreamEs.closed).toBe(false);

            const catSelect = document.getElementById('voiceHubCategorySelect');
            catSelect.value = 'cat_voice';
            const preservedOptionNode = catSelect.children[1];
            expect(preservedOptionNode).toBeDefined();

            // Push live room update via SSE EventSource
            voiceStreamEs.onmessage({
                data: JSON.stringify({
                    guildId: issue2GuildId,
                    hubs: [{ hubChannelId: 'hub_main', name: 'Join to Create', categoryName: 'Temporary Voice' }],
                    categories: [{ id: 'cat_voice', name: 'Temporary Voice', position: 0 }],
                    activeRooms: [
                        { channelId: 'active_room_777', ownerId: 'owner_active', name: "sugoi.js's Room", userLimit: 4 },
                        { channelId: 'live_room_999', ownerId: 'owner_duo', name: 'Duo Queue', userLimit: 2 }
                    ]
                })
            });

            expect(document.getElementById('voiceActiveRoomsCount').textContent).toBe('2 Active');
            const roomsHtml = document.getElementById('voiceActiveRoomsList').innerHTML;
            expect(roomsHtml).toContain("sugoi.js&#39;s Room");
            expect(roomsHtml).toContain('Duo Queue');
            expect(roomsHtml).toContain('Cap: 2');
            // Unchanged categories must NOT rebuild #voiceHubCategorySelect innerHTML
            expect(catSelect.children[1]).toBe(preservedOptionNode);
            expect(catSelect.value).toBe('cat_voice');
            expect(api.isFormDirty()).toBe(false);
            expect(saveBar.classList.contains('visible')).toBe(false);

            // Push empty rooms update via SSE EventSource
            voiceStreamEs.onmessage({
                data: JSON.stringify({
                    guildId: issue2GuildId,
                    hubs: [{ hubChannelId: 'hub_main', name: 'Join to Create', categoryName: 'Temporary Voice' }],
                    categories: [{ id: 'cat_voice', name: 'Temporary Voice', position: 0 }],
                    activeRooms: []
                })
            });
            expect(document.getElementById('voiceActiveRoomsCount').textContent).toBe('0 Active');
            expect(document.getElementById('voiceActiveRoomsList').innerHTML).toContain('No active temporary rooms right now.');
            expect(api.isFormDirty()).toBe(false);
            expect(saveBar.classList.contains('visible')).toBe(false);

            // STRICT REQUIREMENT: ZERO "Live" / "Live Stream" badge, status dot, or indicator in #voiceStudioCard
            const voiceStudioCard = document.getElementById('voiceStudioCard');
            expect(voiceStudioCard.querySelector('.audit-status-badge')).toBeNull();
            expect(voiceStudioCard.querySelector('.status-dot')).toBeNull();
            const allVoiceStudioText = [
                voiceStudioCard.textContent,
                voiceStudioCard.innerHTML,
                ...voiceStudioCard.querySelectorAll('span, div, h3, button').map(el => `${el.textContent} ${el.innerHTML}`)
            ].join(' ');
            expect(allVoiceStudioText).toContain('Active Temporary Rooms');
            expect(allVoiceStudioText).not.toMatch(/\bLive\b/i);
            expect(allVoiceStudioText).not.toMatch(/Live Stream/i);

            const rawHtml = fs.readFileSync(new URL('../dashboard/public/index.html', import.meta.url), 'utf8');
            const voiceCardMarkupMatch = rawHtml.match(/<section[^>]*id="voiceStudioCard"[\s\S]*?<\/section>/i);
            expect(voiceCardMarkupMatch).not.toBeNull();
            expect(voiceCardMarkupMatch[0]).toContain('Active Temporary Rooms');
            expect(voiceCardMarkupMatch[0]).not.toMatch(/\bLive\b/i);
            expect(voiceCardMarkupMatch[0]).not.toMatch(/Live Stream/i);

            // renderLoggedOut() cleanly disconnects voice EventSource
            api.renderLoggedOut();
            expect(voiceStreamEs.closed).toBe(true);
        });
    });
});
