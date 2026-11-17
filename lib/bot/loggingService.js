import { EmbedBuilder } from 'discord.js';
import { EventEmitter } from 'node:events';
import db from '../database.js';
import { SettingsManager } from '../settings.js';

const auditEmitter = new EventEmitter();
auditEmitter.setMaxListeners(100);
const guildSubscribers = new Map();

try {
    if (db?.open && typeof db.prepare === 'function') {
        const cols = db.prepare('PRAGMA table_info(audit_logs)').all();
        if (cols.length > 0 && !cols.some(c => c.name === 'userTag')) {
            db.exec('ALTER TABLE audit_logs ADD COLUMN userTag TEXT');
        }
    }
} catch {}

function cleanMentionUsername(rawName) {
    if (!rawName || typeof rawName !== 'string') return null;
    const cleaned = rawName.trim().replace(/^@+/, '').replace(/#0$/, '').trim();
    return cleaned || null;
}

/**
 * Resolve Discord mention tokens (<@id>, <@!id>, <#id>, <@&id>) into human-readable names for dashboard audit logs
 * @param {string} description
 * @param {object} context
 * @returns {string}
 */
export function resolveAuditMentions(description, { guild = null, client = null, user = null, author = null, extraUsers = null } = {}) {
    if (typeof description !== 'string' || !description) {
        return description || '';
    }

    const resolvedClient = client || guild?.client || null;

    let resolved = description.replace(/<@!?(\d+)>/g, (match, id) => {
        let username = null;

        // a) Passed user object
        if (user && String(user.id) === id) {
            username = cleanMentionUsername(user.username || user.tag || user.globalName || author?.name);
        }

        // b) Client bot user
        if (!username && resolvedClient?.user && String(resolvedClient.user.id) === id) {
            username = cleanMentionUsername(resolvedClient.user.username || resolvedClient.user.tag || resolvedClient.user.globalName);
        }

        // c) Guild member cache or client users cache
        if (!username) {
            const member = guild?.members?.cache?.get?.(id);
            if (member) {
                const memberUser = member.user || member;
                username = cleanMentionUsername(memberUser.username || memberUser.tag || memberUser.globalName || member.displayName);
            }
        }
        if (!username) {
            const cachedUser = guild?.client?.users?.cache?.get?.(id)
                || client?.users?.cache?.get?.(id)
                || extraUsers?.get?.(id);
            if (cachedUser) {
                username = cleanMentionUsername(cachedUser.username || cachedUser.tag || cachedUser.globalName);
            }
        }

        // d) Existing rows in SQLite audit_logs
        if (!username && db?.open && typeof db.prepare === 'function') {
            try {
                const row = db.prepare(`
                    SELECT username, userTag FROM audit_logs
                    WHERE userId = ?
                      AND (
                          (username IS NOT NULL AND username != '' AND username != 'System')
                          OR (userTag IS NOT NULL AND userTag != '' AND userTag != 'System')
                      )
                    ORDER BY timestamp DESC, id DESC
                    LIMIT 1
                `).get(String(id));
                const dbUser = (row?.username && row.username !== 'System') ? row.username : row?.userTag;
                if (dbUser && dbUser !== 'System') {
                    username = cleanMentionUsername(dbUser);
                }
            } catch {
                try {
                    const row = db.prepare(`
                        SELECT username FROM audit_logs
                        WHERE userId = ? AND username IS NOT NULL AND username != '' AND username != 'System'
                        ORDER BY timestamp DESC, id DESC
                        LIMIT 1
                    `).get(String(id));
                    if (row?.username) {
                        username = cleanMentionUsername(row.username);
                    }
                } catch {}
            }
        }

        return username ? `@${username}` : match;
    });

    resolved = resolved.replace(/<#(\d+)>/g, (match, id) => {
        const channel = guild?.channels?.cache?.get?.(id) || resolvedClient?.channels?.cache?.get?.(id);
        if (channel?.name) {
            return `#${String(channel.name).replace(/^#+/, '')}`;
        }
        return match;
    });

    resolved = resolved.replace(/<@&(\d+)>/g, (match, id) => {
        const role = guild?.roles?.cache?.get?.(id);
        if (role?.name) {
            return `@${String(role.name).replace(/^@+/, '')}`;
        }
        return match;
    });

    return resolved;
}

export const loggingService = {
    events: auditEmitter,
    emitter: auditEmitter,
    resolveAuditMentions,

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
        userTag = null,
        author = null,
        guild = null,
        client = null,
        extraUsers = null,
        timestamp = Date.now()
    } = {}) {
        const resolvedGuild = typeof guildOrId === 'object' && guildOrId !== null ? guildOrId : guild;
        const resolvedClient = client || resolvedGuild?.client || null;
        const targetGuildId = typeof guildOrId === 'object' && guildOrId !== null ? guildOrId.id : guildOrId;
        if (!targetGuildId) return null;

        const userId = user?.id || null;
        const rawUsername = author?.name || user?.username || user?.tag || user?.globalName || userTag || 'System';
        const username = cleanMentionUsername(rawUsername) || 'System';
        const userAvatar = author?.iconURL
            || (typeof user?.displayAvatarURL === 'function' ? user.displayAvatarURL({ size: 128 }) : null)
            || (user?.avatar && user?.id ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64` : null)
            || user?.avatarURL
            || null;
        const normalizedFields = Array.isArray(fields) ? fields : [];
        const resolvedDescription = resolveAuditMentions(description || 'No description provided', {
            guild: resolvedGuild,
            client: resolvedClient,
            user,
            author,
            extraUsers
        });

        const entry = {
            id: timestamp,
            guildId: String(targetGuildId),
            eventType: eventType || 'general',
            title: title || null,
            description: resolvedDescription,
            color: typeof color === 'number' ? color : 0x00AE86,
            userId: userId ? String(userId) : null,
            username: String(username),
            userTag: String(username),
            userAvatar: userAvatar || null,
            fields: normalizedFields,
            timestamp: Number(timestamp) || Date.now()
        };

        try {
            if (db?.open && typeof db.prepare === 'function') {
                let info;
                try {
                    const insertStmt = db.prepare(`
                        INSERT INTO audit_logs (guildId, eventType, title, description, color, userId, username, userTag, userAvatar, fields, timestamp)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `);
                    info = insertStmt.run(
                        entry.guildId,
                        entry.eventType,
                        entry.title,
                        entry.description,
                        entry.color,
                        entry.userId,
                        entry.username,
                        entry.userTag,
                        entry.userAvatar,
                        JSON.stringify(entry.fields),
                        entry.timestamp
                    );
                } catch {
                    const insertStmt = db.prepare(`
                        INSERT INTO audit_logs (guildId, eventType, title, description, color, userId, username, userAvatar, fields, timestamp)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `);
                    info = insertStmt.run(
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
                }
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
    getAuditLogs(guildId, { limit = 50, eventType = null, search = null, guild = null, client = null } = {}) {
        if (!guildId) return [];
        const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 250);
        try {
            if (!db?.open || typeof db.prepare !== 'function') return [];

            const resolvedGuild = guild || client?.guilds?.cache?.get?.(String(guildId)) || null;
            const resolvedClient = client || resolvedGuild?.client || null;

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

                const rawRowName = (row.username && row.username !== 'System')
                    ? row.username
                    : (row.userTag || row.username || 'System');
                const resolvedUsername = cleanMentionUsername(rawRowName) || 'System';
                const rowUser = row.userId && resolvedUsername !== 'System'
                    ? { id: row.userId, username: resolvedUsername, tag: resolvedUsername }
                    : null;
                const resolvedDescription = resolveAuditMentions(row.description || '', {
                    guild: resolvedGuild,
                    client: resolvedClient,
                    user: rowUser
                });

                const item = {
                    id: row.id,
                    guildId: row.guildId,
                    eventType: row.eventType || 'general',
                    title: row.title || null,
                    description: resolvedDescription,
                    color: row.color ?? 0x00AE86,
                    userId: row.userId || null,
                    username: resolvedUsername,
                    userTag: resolvedUsername,
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
     * @param {object|string} titleOrOptions 
     * @param {string} [maybeDescription]
     * @param {number} [maybeColor]
     * @param {object} [maybeOptions]
     */
    async log(guild, titleOrOptions = {}, maybeDescription = undefined, maybeColor = 0x00AE86, maybeOptions = {}) {
        if (!guild) return;

        let options;
        if (typeof titleOrOptions === 'object' && titleOrOptions !== null) {
            options = titleOrOptions;
        } else {
            options = {
                ...(typeof maybeOptions === 'object' && maybeOptions !== null ? maybeOptions : {}),
                title: titleOrOptions,
                description: maybeDescription,
                color: maybeColor ?? 0x00AE86
            };
        }

        const {
            title,
            description,
            color = 0x00AE86,
            fields = [],
            eventType = null,
            thumbnail = null,
            image = null,
            user = null,
            author = null,
            footerText = null
        } = options;

        if (eventType) {
            const enabled = SettingsManager.getGuildJson(guild.id, eventType, true);
            if (!enabled) return;
        }

        const extraUsers = new Map();
        if (typeof description === 'string' && description.includes('<@')) {
            const mentionMatches = [...description.matchAll(/<@!?(\d+)>/g)];
            const uniqueIds = [...new Set(mentionMatches.map(m => m[1]))];
            for (const id of uniqueIds) {
                const inPassedUser = Boolean(user?.id && String(user.id) === id && (user.username || user.tag || user.globalName));
                const inClientUser = Boolean(guild?.client?.user?.id && String(guild.client.user.id) === id && (guild.client.user.username || guild.client.user.tag));
                const inMemberCache = Boolean(guild?.members?.cache?.get?.(id));
                const inUserCache = Boolean(guild?.client?.users?.cache?.get?.(id));
                if (!inPassedUser && !inClientUser && !inMemberCache && !inUserCache) {
                    if (typeof guild?.client?.users?.fetch === 'function') {
                        const fetched = await guild.client.users.fetch(id).catch(() => null);
                        if (fetched) {
                            extraUsers.set(id, fetched);
                            if (typeof guild?.client?.users?.cache?.set === 'function') {
                                guild.client.users.cache.set(id, fetched);
                            }
                        }
                    }
                }
            }
        }

        this.recordAuditLog(guild.id, {
            title,
            description,
            color,
            fields,
            eventType,
            user,
            author,
            guild,
            client: guild?.client || null,
            extraUsers
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
