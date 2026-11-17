import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import vm from 'vm';
import { app, setDiscordClient, setBotGuildsCache, clearBotGuildsCache } from '../dashboard/server.js';
import { loggingService } from '../lib/bot/loggingService.js';
import db from '../lib/database.js';

const VOID_TAGS = new Set([
    'AREA', 'BASE', 'BR', 'COL', 'EMBED', 'HR', 'IMG', 'INPUT',
    'LINK', 'META', 'PARAM', 'SOURCE', 'TRACK', 'WBR'
]);

function createDashboardDomHarness({ baseUrl, cookieHeader, customFetch }) {
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

        const attrRegex = /\[([a-zA-Z0-9_-]+)=(?:"([^"]*)"|'([^']*)'|([^\]]*))\]/g;
        let m;
        while ((m = attrRegex.exec(rem)) !== null) {
            const attrName = m[1];
            const attrVal = m[2] ?? m[3] ?? m[4] ?? '';
            if (el.getAttribute(attrName) !== attrVal) return false;
        }
        rem = rem.replace(attrRegex, '');

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
            this.dispatchEvent({ type: 'focus', bubbles: false, target: this });
        }

        blur() {
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
    windowObj.window = windowObj;

    vmContext = vm.createContext(windowObj);

    const instrumentedScript = `${scriptMatch[1].replace(/checkAuth\(\);\s*$/, '')}
window.__dashboardTestApi = {
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
    getState: () => ({
        currentGuildId,
        originalFormState,
        initialFormState,
        hasUserEditedForm,
        isSwitchingGuild,
        currentRoleRewards,
        currentCommandRoles,
        auditLogsCache
    })
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

        it('clicking gear buttons and opening/closing any module modal never marks the form dirty or shows #floatingSaveBar', async () => {
            const { document, api } = await setupAuthenticatedDashboard();
            const saveBar = document.getElementById('floatingSaveBar');

            expect(api.isFormDirty()).toBe(false);
            expect(api.checkFormDirty()).toBe(false);
            expect(saveBar.classList.contains('visible')).toBe(false);
            expect(api.captureFormState()).toEqual(api.getState().initialFormState);

            const modalIds = [
                'generalModal',
                'economyModal',
                'moderationModal',
                'xpModal',
                'gameroleModal',
                'voiceModal'
            ];

            for (const modalId of modalIds) {
                const gearBtn = document.querySelector(`[onclick="openModal('${modalId}')"]`);
                expect(gearBtn).not.toBeNull();

                // Click gear button (triggers both bubbling document click listeners and openModal)
                await gearBtn.click();

                const modalEl = document.getElementById(modalId);
                expect(modalEl.style.display).toBe('flex');
                expect(document.body.style.overflow).toBe('hidden');
                expect(api.isFormDirty()).toBe(false);
                expect(saveBar.classList.contains('visible')).toBe(false);

                // Close modal via closeModal
                api.closeModal(modalId);
                expect(modalEl.style.display).toBe('none');
                expect(document.body.style.overflow).toBe('');
                expect(api.isFormDirty()).toBe(false);
                expect(api.checkFormDirty()).toBe(false);
                expect(saveBar.classList.contains('visible')).toBe(false);
                expect(api.captureFormState()).toEqual(api.getState().initialFormState);

                // Also test opening and closing via modal backdrop click
                await gearBtn.click();
                modalEl.dispatchEvent({ type: 'click', bubbles: true, target: modalEl });
                expect(modalEl.style.display).toBe('none');
                expect(api.isFormDirty()).toBe(false);
                expect(saveBar.classList.contains('visible')).toBe(false);
            }

            // Ensure subcommand role override ('voice lock' -> '444444444444444444') was not overwritten by parent command cascade on outside clicks
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
});
