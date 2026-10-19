import { Events, ActivityType } from 'discord.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import db from '../../../lib/database.js';
import { SettingsManager } from '../../../lib/settings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultWhitelistPath = path.join(__dirname, '..', 'defaultWhitelist.json');
let defaultWhitelist = {};
try {
    defaultWhitelist = JSON.parse(fs.readFileSync(defaultWhitelistPath, 'utf8'));
} catch {}

export default {
    name: Events.PresenceUpdate,
    async execute(oldPresence, newPresence) {
        if (!newPresence || !newPresence.guild) return;

        const guild = newPresence.guild;
        const member = newPresence.member;
        if (!member || member.user?.bot) return;

        // Check module settings for this server
        const isModuleEnabled = SettingsManager.getGuildJson(guild.id, 'module_gamerole_enabled', true);
        const isGameRoleActive = SettingsManager.getGuildJson(guild.id, 'gamerole_enabled', true);
        if (!isModuleEnabled || !isGameRoleActive) return;

        const rolePrefix = SettingsManager.getGuild(guild.id, 'gamerole_prefix') || 'PLAYING ';
        const roleColor = SettingsManager.getGuild(guild.id, 'gamerole_color') || '#ff0000';

        const oldActivity = oldPresence?.activities?.find(a => a.type === ActivityType.Playing);
        const newActivity = newPresence.activities?.find(a => a.type === ActivityType.Playing);

        const findRoleInGuild = (name) => {
            if (!guild.roles?.cache) return null;
            const lower = name.toLowerCase();
            if (typeof guild.roles.cache.find === 'function') {
                return guild.roles.cache.find(r => r.name.toLowerCase() === lower);
            }
            const values = typeof guild.roles.cache.values === 'function' ? Array.from(guild.roles.cache.values()) : guild.roles.cache;
            return values.find(r => r.name.toLowerCase() === lower);
        };

        try {
            // --- 1. REMOVE OLD ROLE (Stopped playing or switched games) ---
            if (oldActivity && oldActivity.name) {
                const stoppedPlaying = !newActivity;
                const switchedGame = newActivity && newActivity.name !== oldActivity.name;

                if (stoppedPlaying || switchedGame) {
                    const oldRoleName = rolePrefix + oldActivity.name;
                    const roleToRemove = findRoleInGuild(oldRoleName);

                    if (roleToRemove && member.roles?.cache?.has(roleToRemove.id)) {
                        await member.roles.remove(roleToRemove.id).catch(() => {});
                    }
                }
            }

            // --- 2. ADD NEW ROLE (If playing a whitelisted game) ---
            if (newActivity && newActivity.name) {
                const gameName = newActivity.name.trim();

                let resolvedRoleName = null;
                const customEntry = db.prepare(
                    'SELECT roleName FROM gamerole_whitelist WHERE guildId = ? AND LOWER(gameName) = LOWER(?)'
                ).get(guild.id, gameName);

                if (customEntry) {
                    resolvedRoleName = customEntry.roleName || gameName;
                } else {
                    // Check default whitelist
                    const lowerGame = gameName.toLowerCase();
                    const defaultMatch = Object.entries(defaultWhitelist).find(
                        ([k]) => k.toLowerCase() === lowerGame
                    );
                    if (defaultMatch) {
                        resolvedRoleName = defaultMatch[1];
                    }
                }

                if (resolvedRoleName) {
                    const targetRoleName = rolePrefix + resolvedRoleName;
                    let targetRole = findRoleInGuild(targetRoleName);

                    // Create role if it does not exist
                    if (!targetRole) {
                        const highestPos = guild.roles.highest?.rawPosition || 1;
                        targetRole = await guild.roles.create({
                            name: targetRoleName,
                            mentionable: true,
                            hoist: true,
                            colors: { primaryColor: roleColor },
                            position: Math.max(1, highestPos - 2)
                        }).catch(() => null);
                    }

                    if (targetRole && !member.roles?.cache?.has(targetRole.id)) {
                        await member.roles.add(targetRole.id).catch(() => {});
                    }
                }
            }
        } catch (error) {
            // Gracefully ignore role permission or hierarchy errors
        }
    },
};
