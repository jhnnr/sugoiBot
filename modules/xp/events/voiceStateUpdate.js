import { Events, AuditLogEvent, PermissionFlagsBits } from 'discord.js';
import { Member } from '../../../lib/classes/Member.js';
import { SettingsManager } from '../../../lib/settings.js';
import { loggingService } from '../../../lib/bot/loggingService.js';

const voiceCollection = new Map();

export default {
    name: Events.VoiceStateUpdate,
    async execute(oldState, newState) {
        const memberObj = newState.member ?? oldState.member;
        if (!memberObj || memberObj.user?.bot || !memberObj.guild) return;

        const userId = memberObj.id;
        const guild = memberObj.guild;

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
        const moduleEnabled = SettingsManager.getGuildJson(memberObj.guild.id, 'module_xp_enabled', true);
        const enabled = SettingsManager.getGuildJson(memberObj.guild.id, 'xp_enabled', true);
        if (!moduleEnabled || !enabled) return;

        // Joined a voice channel
        if (!oldState.channelId && newState.channelId) {
            voiceCollection.set(userId, Date.now());
        }

        // Left a voice channel
        if (oldState.channelId && !newState.channelId) {
            const joinTime = voiceCollection.get(userId);
            if (joinTime) {
                const timeSpent = Date.now() - joinTime;
                const minutes = Math.floor(timeSpent / 60000);
                
                if (minutes > 0) {
                    const xpPerMinute = SettingsManager.getJson('xp_voice_per_minute', 5);
                    const xpToAdd = minutes * xpPerMinute;
                    
                    const member = new Member(memberObj);
                    const result = await member.addXP(xpToAdd);

                    if (result.leveledUp) {
                        const rewards = SettingsManager.getGuildJson(memberObj.guild.id, 'role_rewards', {});
                        const rewardRoleId = rewards[String(result.level)];
                        let roleEarnedText = '';

                        if (rewardRoleId && memberObj.roles) {
                            const rewardRole = memberObj.guild.roles.cache.get(rewardRoleId) || await memberObj.guild.roles.fetch(rewardRoleId).catch(() => null);
                            if (rewardRole && !memberObj.roles.cache.has(rewardRole.id)) {
                                await memberObj.roles.add(rewardRole.id).catch(() => {});
                                roleEarnedText = ` You unlocked the **${rewardRole.name}** role!`;
                            }
                        }

                        const rawChannel = SettingsManager.getGuild(memberObj.guild.id, 'xp_channel_id');
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
                voiceCollection.delete(userId);
            }
        }

        // Changed voice channel
        if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
            const joinTime = voiceCollection.get(userId);
            if (joinTime) {
                const timeSpent = Date.now() - joinTime;
                const minutes = Math.floor(timeSpent / 60000);
                
                if (minutes > 0) {
                    const xpPerMinute = SettingsManager.getJson('xp_voice_per_minute', 5);
                    const xpToAdd = minutes * xpPerMinute;
                    
                    const member = new Member(memberObj);
                    const result = await member.addXP(xpToAdd);

                    if (result.leveledUp) {
                        const rewards = SettingsManager.getGuildJson(memberObj.guild.id, 'role_rewards', {});
                        const rewardRoleId = rewards[String(result.level)];
                        let roleEarnedText = '';

                        if (rewardRoleId && memberObj.roles) {
                            const rewardRole = memberObj.guild.roles.cache.get(rewardRoleId) || await memberObj.guild.roles.fetch(rewardRoleId).catch(() => null);
                            if (rewardRole && !memberObj.roles.cache.has(rewardRole.id)) {
                                await memberObj.roles.add(rewardRole.id).catch(() => {});
                                roleEarnedText = ` You unlocked the **${rewardRole.name}** role!`;
                            }
                        }

                        const rawChannel = SettingsManager.getGuild(memberObj.guild.id, 'xp_channel_id');
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
                    // Reset join time to now for the new channel
                    voiceCollection.set(userId, Date.now());
                }
            } else {
                voiceCollection.set(userId, Date.now());
            }
        }
    },
};
