import { EmbedBuilder } from 'discord.js';
import { EventEmitter } from 'node:events';
import db from '../database.js';
import { SettingsManager } from '../settings.js';

const auditEmitter = new EventEmitter();
auditEmitter.setMaxListeners(100);
const guildSubscribers = new Map();

export const loggingService = {
    events: auditEmitter,
    emitter: auditEmitter,

    /**
     * Subscribe to real-time audit log events for a specific guild
     * @param {string} guildId
     * @param {function} listener
     * @returns {function} Unsubscribe callback
     */
    subscribe(guildId, listener) {
        if (!guildId || typeof listener !== 'function') {
            return () => {};
        }
        const key = String(guildId);
        if (!guildSubscribers.has(key)) {
            guildSubscribers.set(key, new Set());
        }
        const set = guildSubscribers.get(key);
        set.add(listener);

        return () => {
            set.delete(listener);
            if (set.size === 0) {
                guildSubscribers.delete(key);
            }
        };
    },

    /**
     * Persist an audit log entry to SQLite and emit real-time notifications
     * @param {string|object} guildOrId
     * @param {object} payload
     */
    recordAuditLog(guildOrId, {
        title = null,
        description = '',
        color = 0x00AE86,
        fields = [],
        eventType = null,
        user = null,
        author = null,
        timestamp = Date.now()
    } = {}) {
        const targetGuildId = typeof guildOrId === 'object' && guildOrId !== null ? guildOrId.id : guildOrId;
        if (!targetGuildId) return null;

        const userId = user?.id || null;
        const username = author?.name || user?.username || user?.tag || 'System';
        const userAvatar = author?.iconURL
            || (typeof user?.displayAvatarURL === 'function' ? user.displayAvatarURL({ size: 128 }) : null)
            || (user?.avatar && user?.id ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64` : null)
            || user?.avatarURL
            || null;
        const normalizedFields = Array.isArray(fields) ? fields : [];

        const entry = {
            id: timestamp,
            guildId: String(targetGuildId),
            eventType: eventType || 'general',
            title: title || null,
            description: description || 'No description provided',
            color: typeof color === 'number' ? color : 0x00AE86,
            userId: userId ? String(userId) : null,
            username: String(username),
            userAvatar: userAvatar || null,
            fields: normalizedFields,
            timestamp: Number(timestamp) || Date.now()
        };

        try {
            if (db?.open && typeof db.prepare === 'function') {
                const insertStmt = db.prepare(`
                    INSERT INTO audit_logs (guildId, eventType, title, description, color, userId, username, userAvatar, fields, timestamp)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `);
                const info = insertStmt.run(
                    entry.guildId,
                    entry.eventType,
                    entry.title,
                    entry.description,
                    entry.color,
                    entry.userId,
                    entry.username,
                    entry.userAvatar,
                    JSON.stringify(entry.fields),
                    entry.timestamp
                );
                if (info?.lastInsertRowid !== undefined) {
                    entry.id = Number(info.lastInsertRowid);
                }

                // Prune old entries beyond latest 250 per guild
                db.prepare(`
                    DELETE FROM audit_logs
                    WHERE guildId = ? AND id NOT IN (
                        SELECT id FROM audit_logs
                        WHERE guildId = ?
                        ORDER BY timestamp DESC, id DESC
                        LIMIT 250
                    )
                `).run(entry.guildId, entry.guildId);
            }
        } catch {}

        try {
            auditEmitter.emit('auditLog', entry);
            const subs = guildSubscribers.get(entry.guildId);
            if (subs) {
                for (const fn of subs) {
                    try {
                        fn(entry);
                    } catch {}
                }
            }
        } catch {}

        return entry;
    },

    /**
     * Retrieve recent audit logs for a guild from SQLite
     * @param {string} guildId
     * @param {object} options
     */
    getAuditLogs(guildId, { limit = 50, eventType = null, search = null } = {}) {
        if (!guildId) return [];
        const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 250);
        try {
            if (!db?.open || typeof db.prepare !== 'function') return [];

            const params = [String(guildId)];
            let sql = 'SELECT * FROM audit_logs WHERE guildId = ?';
            if (eventType && eventType !== 'all') {
                sql += ' AND eventType = ?';
                params.push(String(eventType));
            }
            sql += ' ORDER BY timestamp DESC, id DESC LIMIT 250';

            const rows = db.prepare(sql).all(...params);
            const normalizedSearch = typeof search === 'string' && search.trim()
                ? search.trim().toLowerCase()
                : null;

            const results = [];
            for (const row of rows) {
                let parsedFields = [];
                if (row.fields) {
                    try {
                        const parsed = JSON.parse(row.fields);
                        if (Array.isArray(parsed)) parsedFields = parsed;
                    } catch {}
                }

                const item = {
                    id: row.id,
                    guildId: row.guildId,
                    eventType: row.eventType || 'general',
                    title: row.title || null,
                    description: row.description || '',
                    color: row.color ?? 0x00AE86,
                    userId: row.userId || null,
                    username: row.username || 'System',
                    userAvatar: row.userAvatar || null,
                    fields: parsedFields,
                    timestamp: row.timestamp
                };

                if (normalizedSearch) {
                    const haystack = [
                        item.title || '',
                        item.description || '',
                        item.username || '',
                        item.eventType || '',
                        ...parsedFields.map(f => `${f.name || ''} ${f.value || ''}`)
                    ].join(' ').toLowerCase();
                    if (!haystack.includes(normalizedSearch)) {
                        continue;
                    }
                }

                results.push(item);
                if (results.length >= safeLimit) break;
            }
            return results;
        } catch {
            return [];
        }
    },

    /**
     * Log an event to the configured log channel
     * @param {import('discord.js').Guild} guild 
     * @param {object} options 
     */
    async log(guild, { title, description, color = 0x00AE86, fields = [], eventType = null, thumbnail = null, image = null, user = null, author = null, footerText = null }) {
        if (!guild) return;

        if (eventType) {
            const enabled = SettingsManager.getGuildJson(guild.id, eventType, true);
            if (!enabled) return;
        }

        this.recordAuditLog(guild.id, {
            title,
            description,
            color,
            fields,
            eventType,
            user,
            author
        });

        const rawChannelId = SettingsManager.getGuild(guild.id, 'log_channel_id');
        if (!rawChannelId) return;

        const logChannelId = String(rawChannelId).replace(/^["']|["']$/g, '').trim();
        if (!logChannelId) return;

        const channel = guild.channels?.cache?.get(logChannelId)
            || await guild.channels?.fetch(logChannelId).catch(() => null)
            || await guild.client?.channels?.fetch(logChannelId).catch(() => null);

        if (!channel) {
            console.warn(`[LOGGING] Channel ID "${logChannelId}" could not be resolved for guild "${guild.name}" (${guild.id}). Check bot channel permissions.`);
            return;
        }

        const embed = new EmbedBuilder()
            .setColor(color)
            .setTimestamp();

        if (title) {
            embed.setTitle(title);
        }

        // Author header with small profile picture and username
        if (author) {
            embed.setAuthor(author);
        } else if (user) {
            const iconUrl = typeof user.displayAvatarURL === 'function'
                ? user.displayAvatarURL({ size: 128 })
                : null;
            embed.setAuthor({
                name: user.username || user.tag || 'User',
                iconURL: iconUrl || undefined
            });
        }

        embed.setDescription(description || 'No description provided');

        if (fields.length > 0) {
            embed.addFields(fields);
        }

        if (thumbnail) embed.setThumbnail(thumbnail);
        if (image) embed.setImage(image);

        if (footerText) {
            embed.setFooter({ text: footerText });
        }

        try {
            await channel.send({ embeds: [embed] });
        } catch (error) {
            console.error(`[ERROR] Failed to send log to channel ${logChannelId}:`, error.message);
        }
    }
};
