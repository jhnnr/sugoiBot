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

        // Fetch member if uncached
        let member = newPresence.member;
        if (!member && newPresence.userId) {
            member = await guild.members.fetch(newPresence.userId).catch(() => null);
        }
        if (!member || member.user?.bot) return;

        // Check module settings for this server
        const isModuleEnabled = SettingsManager.getGuildJson(guild.id, 'module_gamerole_enabled', true);
        const isGameRoleActive = SettingsManager.getGuildJson(guild.id, 'gamerole_enabled', true);
        if (!isModuleEnabled || !isGameRoleActive) return;

        const rawPrefix = SettingsManager.getGuild(guild.id, 'gamerole_prefix');
        const rolePrefix = rawPrefix !== null && rawPrefix !== undefined
            ? (rawPrefix.trim() ? `${rawPrefix.trim()} ` : '')
            : 'PLAYING ';
        const roleColor = SettingsManager.getGuild(guild.id, 'gamerole_color') || '#ff0000';

        const isGameActivity = (act) => {
            if (!act || !act.name) return false;
            // ActivityType.Playing = 0, ActivityType.Streaming = 1
            return act.type === ActivityType.Playing || act.type === ActivityType.Streaming || act.type === 0 || act.type === 1;
        };

        const oldActivity = oldPresence?.activities?.find(isGameActivity);
        const newActivity = newPresence.activities?.find(isGameActivity);

        const findRoleInGuild = async (name) => {
            if (!guild.roles?.cache) return null;
            const lower = name.toLowerCase();
            let role;
            if (typeof guild.roles.cache.find === 'function') {
                role = guild.roles.cache.find(r => r.name.toLowerCase() === lower);
            } else {
                const values = typeof guild.roles.cache.values === 'function' ? Array.from(guild.roles.cache.values()) : guild.roles.cache;
                role = values.find(r => r.name.toLowerCase() === lower);
            }

            if (!role && typeof guild.roles.fetch === 'function') {
                const fetched = await guild.roles.fetch().catch(() => null);
                if (fetched) {
                    if (typeof guild.roles.cache.find === 'function') {
                        role = guild.roles.cache.find(r => r.name.toLowerCase() === lower);
                    } else if (typeof fetched.find === 'function') {
                        role = fetched.find(r => r.name.toLowerCase() === lower);
                    }
                }
            }
            return role;
        };

        try {
            // --- 1. REMOVE OLD ROLE (Stopped playing or switched games) ---
            if (oldActivity && oldActivity.name) {
                const stoppedPlaying = !newActivity;
                const switchedGame = newActivity && newActivity.name.toLowerCase() !== oldActivity.name.toLowerCase();

                if (stoppedPlaying || switchedGame) {
                    let oldRoleTarget = oldActivity.name;
                    const oldCustom = db.prepare(
                        'SELECT roleName FROM gamerole_whitelist WHERE guildId = ? AND LOWER(gameName) = LOWER(?)'
                    ).get(guild.id, oldActivity.name);

                    if (oldCustom && oldCustom.roleName && oldCustom.roleName !== '__DISABLED__') {
                        oldRoleTarget = oldCustom.roleName;
                    } else {
                        const lowerOld = oldActivity.name.toLowerCase();
                        const oldMatch = Object.entries(defaultWhitelist).find(([k]) => k.toLowerCase() === lowerOld);
                        if (oldMatch) oldRoleTarget = oldMatch[1];
                    }

                    const oldRoleName = rolePrefix + oldRoleTarget;
                    const roleToRemove = (await findRoleInGuild(oldRoleName)) || (await findRoleInGuild(rolePrefix + oldActivity.name));

                    if (roleToRemove && member.roles?.cache?.has(roleToRemove.id)) {
                        await member.roles.remove(roleToRemove.id).catch(err => {
                            console.error(`[GAMEROLE ERROR] Failed to remove role "${roleToRemove.name}" from ${member.user?.tag}:`, err.message);
                        });
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
                    if (customEntry.roleName === '__DISABLED__') {
                        return; // Explicitly disabled for this guild
                    }
                    resolvedRoleName = customEntry.roleName || gameName;
                } else {
                    // Check default whitelist (case-insensitive)
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
                    let targetRole = await findRoleInGuild(targetRoleName);

                    // Create role if it does not exist
                    if (!targetRole) {
                        targetRole = await guild.roles.create({
                            name: targetRoleName,
                            mentionable: true,
                            hoist: true,
                            colors: { primaryColor: roleColor }
                        }).catch(err => {
                            console.error(`[GAMEROLE ERROR] Failed to create role "${targetRoleName}" in guild "${guild.name}":`, err.message);
                            return null;
                        });

                        if (targetRole) {
                            try {
                                const botHighestPos = guild.members?.me?.roles?.highest?.position || 1;
                                const prefixCheck = (rolePrefix.trim() || 'PLAYING').toLowerCase();

                                // Find all other existing playing roles in this guild
                                const existingPlayingRoles = Array.from(guild.roles?.cache?.values() || []).filter(r => 
                                    r.id !== targetRole.id && 
                                    r.name.toLowerCase().startsWith(prefixCheck)
                                );

                                let targetPos = 1;
                                if (existingPlayingRoles.length > 0) {
                                    // Place at the bottom of all existing PLAYING roles
                                    const lowestPlayingPos = Math.min(...existingPlayingRoles.map(r => r.position));
                                    targetPos = Math.max(1, Math.min(botHighestPos - 1, lowestPlayingPos));
                                } else {
                                    // No existing playing roles: fall back to configured gamerole_position or directly below bot
                                    const desiredPos = SettingsManager.getGuildJson(guild.id, 'gamerole_position', 0);
                                    targetPos = desiredPos > 0
                                        ? Math.min(botHighestPos - 1, Math.max(1, desiredPos))
                                        : Math.max(1, botHighestPos - 1);
                                }

                                if (targetPos > 0 && targetRole.position !== targetPos) {
                                    await targetRole.setPosition(targetPos).catch(e => {
                                        console.warn(`[GAMEROLE] Could not set position ${targetPos} for role "${targetRole.name}":`, e.message);
                                    });
                                }
                            } catch {}
                        }
                    }

                    if (targetRole && !member.roles?.cache?.has(targetRole.id)) {
                        await member.roles.add(targetRole.id).catch(err => {
                            console.error(`[GAMEROLE ERROR] Failed to assign role "${targetRole.name}" to ${member.user?.tag}:`, err.message);
                        });
                    }
                }
            }
        } catch (error) {
            console.error(`[GAMEROLE ERROR] Error processing presence update in guild "${guild.name}":`, error);
        }
    },
};
