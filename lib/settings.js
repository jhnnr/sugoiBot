import db from './database.js';

export const SettingsManager = {
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

    validate(key, value) {
        if (key === 'xp_min' || key === 'xp_max') {
            if (typeof value !== 'number' || isNaN(value)) return false;
            
            if (key === 'xp_min') {
                const max = this.getJson('xp_max', 20);
                if (value > max) return false;
            }
            if (key === 'xp_max') {
                const min = this.getJson('xp_min', 10);
                if (value < min) return false;
            }
        }
        if (key === 'work_min' || key === 'work_max') {
            if (typeof value !== 'number' || isNaN(value) || value < 0) return false;

            if (key === 'work_min') {
                const max = this.getJson('work_max', 50);
                if (value > max) return false;
            }
            if (key === 'work_max') {
                const min = this.getJson('work_min', 10);
                if (value < min) return false;
            }
        }
        if (key === 'xp_voice_per_minute' || key === 'daily_amount') {
            if (typeof value !== 'number' || isNaN(value) || value < 0) return false;
        }
        if (key === 'xp_enabled' || key.startsWith('log_events_') || key.startsWith('module_')) {
            if (typeof value !== 'boolean') return false;
        }
        if (key === 'log_channel_id') {
            if (typeof value !== 'string') return false;
        }
        return true;
    },

    getGuild(guildId, key) {
        if (!guildId) return this.get(key);
        const row = db.prepare('SELECT value FROM guild_settings WHERE guildId = ? AND key = ?').get(guildId, key);
        const raw = row ? row.value : this.get(key);
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
        const setManyTx = db.transaction((items) => {
            for (const [key, val] of Object.entries(items)) {
                if (!this.validate(key, val)) {
                    throw new Error(`Invalid value for setting ${key}: ${val}`);
                }
                const serialized = JSON.stringify(val);
                this.setGuild(guildId, key, serialized);
            }
        });
        setManyTx(entries);
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
