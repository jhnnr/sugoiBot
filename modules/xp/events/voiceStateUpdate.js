import { Events, AuditLogEvent, PermissionFlagsBits } from 'discord.js';
import { Member } from '../../../lib/classes/Member.js';
import { SettingsManager } from '../../../lib/settings.js';
import { loggingService } from '../../../lib/bot/loggingService.js';

// Keyed by `${guildId}_${userId}`
export const voiceCollection = new Map();
let voiceXpInterval = null;
let initializedClient = null;

export async function awardVoiceXP(memberObj, minutes, guildId) {
    if (!memberObj || minutes <= 0) return;
    const xpPerMinute = SettingsManager.getGuildJson(guildId, 'xp_voice_per_minute', 5);
    const xpToAdd = minutes * xpPerMinute;
    if (xpToAdd <= 0) return;

    const member = new Member(memberObj);
    const result = await member.addXP(xpToAdd);

    if (result.leveledUp) {
        const roleRewardsEnabled = SettingsManager.getGuildJson(guildId, 'role_rewards_enabled', true);
        let roleEarnedText = '';

        if (roleRewardsEnabled) {
            const rewards = SettingsManager.getGuildJson(guildId, 'role_rewards', {});
            const rewardRoleId = rewards[String(result.level)];

            if (rewardRoleId && memberObj.roles) {
                const rewardRole = memberObj.guild.roles.cache.get(rewardRoleId) || await memberObj.guild.roles.fetch(rewardRoleId).catch(() => null);
                if (rewardRole && !memberObj.roles.cache.has(rewardRole.id)) {
                    await memberObj.roles.add(rewardRole.id).catch(() => {});
                    roleEarnedText = ` You unlocked the **${rewardRole.name}** role!`;
                }
            }
        }

        const rawChannel = SettingsManager.getGuild(guildId, 'xp_channel_id');
        const targetChannelId = rawChannel ? String(rawChannel).replace(/^["']|["']$/g, '').trim() : '';
        const targetChannel = targetChannelId ? (memberObj.guild.channels.cache.get(targetChannelId) || await memberObj.guild.channels.fetch(targetChannelId).catch(() => null)) : null;

        const congratsText = `Congrats ${memberObj}! You leveled up to **${result.level}** by hanging out in voice!${roleEarnedText}`;
        if (targetChannel && typeof targetChannel.send === 'function') {
            await targetChannel.send(congratsText).catch(() => {});
        } else {
            try {
                await memberObj.send(congratsText);
            } catch (e) {}
        }
    }
}

export function startVoiceXpInterval(client) {
    if (voiceXpInterval || !client) return;
    initializedClient = client;

    // Scan existing connected voice members on startup
    if (client.guilds?.cache) {
        for (const guild of client.guilds.cache.values()) {
            if (!guild.channels?.cache) continue;
            for (const channel of guild.channels.cache.values()) {
                if (channel.isVoiceBased?.() && channel.members) {
                    for (const member of channel.members.values()) {
                        if (!member.user?.bot && channel.id !== guild.afkChannelId) {
                            const key = `${guild.id}_${member.id}`;
                            voiceCollection.set(key, {
                                guildId: guild.id,
                                userId: member.id,
                                channelId: channel.id,
                                joinedAt: Date.now(),
                                lastAwardedAt: Date.now()
                            });
                        }
                    }
                }
            }
        }
    }

    voiceXpInterval = setInterval(async () => {
        if (!initializedClient) return;

        const now = Date.now();
        for (const [key, session] of Array.from(voiceCollection.entries())) {
            const guild = initializedClient.guilds?.cache?.get(session.guildId);
            if (!guild) {
                voiceCollection.delete(key);
                continue;
            }

            const moduleEnabled = SettingsManager.getGuildJson(session.guildId, 'module_xp_enabled', true);
            const xpEnabled = SettingsManager.getGuildJson(session.guildId, 'xp_enabled', true);
            if (!moduleEnabled || !xpEnabled) continue;

            const member = guild.members?.cache?.get(session.userId);
            if (!member || !member.voice?.channelId || member.voice.channelId !== session.channelId) {
                voiceCollection.delete(key);
                continue;
            }

            // Do not award XP if in AFK channel or deafened
            if (member.voice.channelId === guild.afkChannelId || member.voice.deaf || member.voice.selfDeaf) {
                session.lastAwardedAt = now;
                continue;
            }

            if (now - session.lastAwardedAt >= 60000) {
                const minutes = Math.floor((now - session.lastAwardedAt) / 60000);
                session.lastAwardedAt = now;
                await awardVoiceXP(member, minutes, session.guildId).catch(() => {});
            }
        }
    }, 60000);

    if (voiceXpInterval.unref) voiceXpInterval.unref();
}

export default {
    name: Events.VoiceStateUpdate,
    async execute(oldState, newState) {
        const memberObj = newState.member ?? oldState.member;
        if (!memberObj || memberObj.user?.bot || !memberObj.guild) return;

        const userId = memberObj.id;
        const guild = memberObj.guild;
        const sessionKey = `${guild.id}_${userId}`;

        // Ensure voice XP loop is started
        if (memberObj.client && !voiceXpInterval) {
            startVoiceXpInterval(memberObj.client);
        }

        // --- Voice State Logging ---
        if (!oldState.channelId && newState.channelId) {
            // Joined voice channel
            const channelName = newState.channel?.name || 'voice';
            loggingService.log(guild, {
                description: `📥 ${memberObj} joined voice channel **${channelName}**`,
                color: 0x57F287,
                eventType: 'log_events_voice',
                user: memberObj.user
            }).catch(() => {});
        } else if (oldState.channelId && !newState.channelId) {
            // Left voice channel
            const channelName = oldState.channel?.name || 'voice';
            let disconnectorInfo = '';

            if (guild.members?.me?.permissions?.has(PermissionFlagsBits.ViewAuditLog)) {
                try {
                    const logs = await guild.fetchAuditLogs({
                        type: AuditLogEvent.MemberDisconnect,
                        limit: 1
                    }).catch(() => null);

                    const entry = logs?.entries?.first();
                    if (entry && (Date.now() - entry.createdTimestamp < 3500)) {
                        disconnectorInfo = ` by ${entry.executor}`;
                    }
                } catch {}
            }

            const actionVerb = disconnectorInfo ? 'was disconnected from' : 'left';
            loggingService.log(guild, {
                description: `📤 ${memberObj} ${actionVerb} voice channel **${channelName}**${disconnectorInfo}`,
                color: 0xED4245,
                eventType: 'log_events_voice',
                user: memberObj.user
            }).catch(() => {});
        } else if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
            // Switched voice channels
            const fromName = oldState.channel?.name || 'voice';
            const toName = newState.channel?.name || 'voice';
            let moverInfo = '';

            if (guild.members?.me?.permissions?.has(PermissionFlagsBits.ViewAuditLog)) {
                try {
                    const logs = await guild.fetchAuditLogs({
                        type: AuditLogEvent.MemberMove,
                        limit: 1
                    }).catch(() => null);

                    const entry = logs?.entries?.first();
                    if (entry && (Date.now() - entry.createdTimestamp < 3500)) {
                        moverInfo = ` by ${entry.executor}`;
                    }
                } catch {}
            }

            const actionVerb = moverInfo ? 'was moved' : 'moved';
            loggingService.log(guild, {
                description: `🔀 ${memberObj} ${actionVerb} from voice channel **${fromName}** to **${toName}**${moverInfo}`,
                color: 0x5865F2,
                eventType: 'log_events_voice',
                user: memberObj.user
            }).catch(() => {});
        }

        // --- Voice XP Tracking ---
        const moduleEnabled = SettingsManager.getGuildJson(guild.id, 'module_xp_enabled', true);
        const enabled = SettingsManager.getGuildJson(guild.id, 'xp_enabled', true);
        if (!moduleEnabled || !enabled) {
            voiceCollection.delete(sessionKey);
            return;
        }

        // Joined voice channel
        if (!oldState.channelId && newState.channelId) {
            if (newState.channelId !== guild.afkChannelId) {
                voiceCollection.set(sessionKey, {
                    guildId: guild.id,
                    userId,
                    channelId: newState.channelId,
                    joinedAt: Date.now(),
                    lastAwardedAt: Date.now()
                });
            }
        }

        // Left voice channel
        if (oldState.channelId && !newState.channelId) {
            const session = voiceCollection.get(sessionKey);
            if (session) {
                const elapsedSinceLastAward = Date.now() - session.lastAwardedAt;
                const minutes = Math.floor(elapsedSinceLastAward / 60000);
                // If more than 30 seconds since last minute award, grant a final minute
                const finalMinutes = minutes > 0 ? minutes : (elapsedSinceLastAward >= 30000 ? 1 : 0);

                if (finalMinutes > 0 && oldState.channelId !== guild.afkChannelId && !oldState.deaf && !oldState.selfDeaf) {
                    await awardVoiceXP(memberObj, finalMinutes, guild.id);
                }
                voiceCollection.delete(sessionKey);
            }
        }

        // Changed voice channel
        if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
            const session = voiceCollection.get(sessionKey);
            if (session) {
                const elapsedSinceLastAward = Date.now() - session.lastAwardedAt;
                const minutes = Math.floor(elapsedSinceLastAward / 60000);
                const finalMinutes = minutes > 0 ? minutes : (elapsedSinceLastAward >= 30000 ? 1 : 0);

                if (finalMinutes > 0 && oldState.channelId !== guild.afkChannelId && !oldState.deaf && !oldState.selfDeaf) {
                    await awardVoiceXP(memberObj, finalMinutes, guild.id);
                }
            }

            if (newState.channelId !== guild.afkChannelId) {
                voiceCollection.set(sessionKey, {
                    guildId: guild.id,
                    userId,
                    channelId: newState.channelId,
                    joinedAt: Date.now(),
                    lastAwardedAt: Date.now()
                });
            } else {
                voiceCollection.delete(sessionKey);
            }
        }
    },
};
