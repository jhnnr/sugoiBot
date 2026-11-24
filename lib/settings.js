import db from './database.js';

const schemaRegistry = new Map();

export const DEFAULT_MODULE_EMBED_COLORS = {
    core: '#5865F2',
    general: '#5865F2',
    economy: '#F1C40F',
    moderation: '#ED4245',
    xp: '#9B59B6',
    gamerole: '#FF0000',
    voice: '#57F287'
};

export const SettingsManager = {
    registerSchema(schemas, moduleName = null) {
        if (!schemas) return;
        const list = Array.isArray(schemas) ? schemas : [schemas];
        for (const s of list) {
            if (s && s.key) {
                schemaRegistry.set(s.key, { ...s, module: (moduleName || s.module || '').toLowerCase() });
            }
        }
    },

    getSchema(key) {
        return schemaRegistry.get(key) || null;
    },

    getModuleSchemas(moduleName) {
        if (!moduleName) return [];
        const norm = moduleName.toLowerCase();
        const results = [];
        for (const [key, schema] of schemaRegistry.entries()) {
            if (schema.module === norm || key.startsWith(norm + '_')) {
                results.push(schema);
            }
        }
        return results;
    },

    getModuleSettings(guildId, moduleName) {
        const schemas = this.getModuleSchemas(moduleName);
        const result = {};
        for (const schema of schemas) {
            result[schema.key] = this.getGuildJson(guildId, schema.key, schema.defaultValue);
        }
        return result;
    },

    get(key) {
        const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
        if (!row || row.value === undefined || row.value === null) return null;
        try {
            const parsed = JSON.parse(row.value);
            return typeof parsed === 'string' ? parsed : row.value;
        } catch {
            return row.value;
        }
    },

    set(key, value) {
        db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
    },

    getAll() {
        const rows = db.prepare('SELECT key, value FROM settings').all();
        const result = {};
        for (const row of rows) {
            try {
                result[row.key] = JSON.parse(row.value);
            } catch {
                result[row.key] = row.value;
            }
        }
        return result;
    },

    validate(key, value, context = null) {
        // Dynamic schema validation for registered module settings
        const schema = schemaRegistry.get(key);
        if (schema) {
            if (schema.type === 'number') {
                if (typeof value !== 'number' || isNaN(value)) return false;
                if (schema.min !== undefined && value < schema.min) return false;
                if (schema.max !== undefined && value > schema.max) return false;
            } else if (schema.type === 'boolean') {
                if (typeof value !== 'boolean') return false;
            } else if (schema.type === 'string' || schema.type === 'channel') {
                if (typeof value !== 'string') return false;
            } else if (schema.type === 'object') {
                if (typeof value !== 'object' || value === null) return false;
            }
        }

        if (key === 'xp_min' || key === 'xp_max') {
            if (typeof value !== 'number' || isNaN(value)) return false;
            
            if (key === 'xp_min') {
                const max = (context && typeof context === 'object' && typeof context.xp_max === 'number' && !isNaN(context.xp_max))
                    ? context.xp_max
                    : this.getJson('xp_max', 20);
                if (value > max) return false;
            }
            if (key === 'xp_max') {
                const min = (context && typeof context === 'object' && typeof context.xp_min === 'number' && !isNaN(context.xp_min))
                    ? context.xp_min
                    : this.getJson('xp_min', 10);
                if (value < min) return false;
            }
        }
        if (key === 'work_min' || key === 'work_max') {
            if (typeof value !== 'number' || isNaN(value) || value < 0) return false;

            if (key === 'work_min') {
                const max = (context && typeof context === 'object' && typeof context.work_max === 'number' && !isNaN(context.work_max))
                    ? context.work_max
                    : this.getJson('work_max', 50);
                if (value > max) return false;
            }
            if (key === 'work_max') {
                const min = (context && typeof context === 'object' && typeof context.work_min === 'number' && !isNaN(context.work_min))
                    ? context.work_min
                    : this.getJson('work_min', 10);
                if (value < min) return false;
            }
        }
        if (key === 'xp_voice_per_minute' || key === 'daily_amount') {
            if (typeof value !== 'number' || isNaN(value) || value < 0) return false;
        }
        if (key === 'xp_enabled' || key.startsWith('log_events_') || (key.startsWith('module_') && key !== 'module_embed_colors')) {
            if (typeof value !== 'boolean') return false;
        }
        if (key === 'log_channel_id' || key === 'xp_channel_id' || key.endsWith('_channel_id')) {
            if (typeof value !== 'string') return false;
        }
        if (key === 'module_embed_colors') {
            if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
            for (const v of Object.values(value)) {
                if (typeof v !== 'string' || (v !== '' && !/^#[0-9A-Fa-f]{6}$/.test(v))) {
                    return false;
                }
            }
        }
        if (key === 'command_roles' || key === 'role_rewards') {
            if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
            if (key === 'command_roles') {
                for (const v of Object.values(value)) {
                    if (typeof v === 'string') continue;
                    if (Array.isArray(v) && v.every(item => typeof item === 'string')) continue;
                    return false;
                }
            }
        }
        return true;
    },

    normalizeCommandRoles(rawValue) {
        if (rawValue === null || rawValue === undefined) return [];
        const list = Array.isArray(rawValue) ? rawValue : (typeof rawValue === 'string' ? [rawValue] : []);
        const seen = new Set();
        const normalized = [];
        for (const item of list) {
            if (typeof item !== 'string') continue;
            const cleaned = item.trim().replace(/^["']|["']$/g, '').trim();
            if (cleaned && !seen.has(cleaned)) {
                seen.add(cleaned);
                normalized.push(cleaned);
            }
        }
        return normalized;
    },

    getEmbedColor(guildId, moduleName, fallbackColor = 0x5865F2) {
        const colors = this.getGuildJson(guildId, 'module_embed_colors', {});
        if (colors && typeof colors === 'object' && !Array.isArray(colors)) {
            const hex = colors[String(moduleName || '').toLowerCase()];
            if (typeof hex === 'string' && /^#[0-9A-Fa-f]{6}$/.test(hex)) {
                return parseInt(hex.slice(1), 16);
            }
        }
        if (typeof fallbackColor === 'string' && /^#[0-9A-Fa-f]{6}$/.test(fallbackColor)) {
            return parseInt(fallbackColor.slice(1), 16);
        }
        return fallbackColor;
    },

    getGuild(guildId, key) {
        if (!guildId) return this.get(key);
        const row = db.prepare('SELECT value FROM guild_settings WHERE guildId = ? AND key = ?').get(guildId, key);
        // Strictly isolate channel IDs to their specific guild without global fallback
        const raw = row ? row.value : (key === 'log_channel_id' || key === 'xp_channel_id' || key.endsWith('_channel_id') ? null : this.get(key));
        if (!raw) return null;
        try {
            const parsed = JSON.parse(raw);
            return typeof parsed === 'string' ? parsed : raw;
        } catch {
            return raw;
        }
    },

    setGuild(guildId, key, value) {
        if (!guildId) return this.set(key, value);
        db.prepare('INSERT OR REPLACE INTO guild_settings (guildId, key, value) VALUES (?, ?, ?)').run(guildId, key, value);
    },

    setGuildMany(guildId, entries) {
        if (!guildId || !entries) return;
        const sanitizedItems = {};
        for (const [key, rawVal] of Object.entries(entries)) {
            if ((key === 'log_channel_id' || key === 'xp_channel_id' || key.endsWith('_channel_id')) && typeof rawVal === 'string') {
                sanitizedItems[key] = rawVal.replace(/^["']|["']$/g, '').trim();
            } else if (key === 'command_roles' && typeof rawVal === 'object' && rawVal !== null && !Array.isArray(rawVal)) {
                const cleanedRoles = {};
                for (const [cmdKey, roleVal] of Object.entries(rawVal)) {
                    if (typeof roleVal === 'string') {
                        cleanedRoles[cmdKey] = roleVal.trim().replace(/^["']|["']$/g, '').trim();
                    } else if (Array.isArray(roleVal) && roleVal.every(item => typeof item === 'string')) {
                        cleanedRoles[cmdKey] = this.normalizeCommandRoles(roleVal);
                    } else {
                        cleanedRoles[cmdKey] = roleVal;
                    }
                }
                sanitizedItems[key] = cleanedRoles;
            } else {
                sanitizedItems[key] = rawVal;
            }
        }
        const setManyTx = db.transaction((items) => {
            for (const [key, val] of Object.entries(items)) {
                if (!this.validate(key, val, items)) {
                    throw new Error(`Invalid value for setting ${key}: ${val}`);
                }
                const serialized = JSON.stringify(val);
                this.setGuild(guildId, key, serialized);
            }
        });
        setManyTx(sanitizedItems);
    },

    getAllGuild(guildId) {
        if (!guildId) return this.getAll();
        const rows = db.prepare('SELECT key, value FROM guild_settings WHERE guildId = ?').all(guildId);
        const result = {};
        for (const row of rows) {
            try {
                result[row.key] = JSON.parse(row.value);
            } catch {
                result[row.key] = row.value;
            }
        }
        return result;
    },

    getGuildJson(guildId, key, defaultValue) {
        const value = this.getGuild(guildId, key);
        if (!value) return defaultValue;
        try {
            const parsed = JSON.parse(value);
            if (!this.validate(key, parsed)) return defaultValue;
            return parsed;
        } catch {
            return defaultValue;
        }
    },

    setGuildJson(guildId, key, value) {
        if (!this.validate(key, value)) {
            throw new Error(`Invalid value for setting ${key}: ${value}`);
        }
        this.setGuild(guildId, key, JSON.stringify(value));
    },

    getJson(key, defaultValue) {
        const value = this.get(key);
        if (!value) return defaultValue;
        try {
            const parsed = JSON.parse(value);
            if (!this.validate(key, parsed)) return defaultValue;
            return parsed;
        } catch {
            return defaultValue;
        }
    },

    setJson(key, value) {
        if (!this.validate(key, value)) {
            throw new Error(`Invalid value for setting ${key}: ${value}`);
        }
        this.set(key, JSON.stringify(value));
    }
};
