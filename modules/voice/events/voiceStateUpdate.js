import { Events, ChannelType, PermissionFlagsBits } from 'discord.js';
import db from '../../../lib/database.js';
import { SettingsManager } from '../../../lib/settings.js';
import {
    getVoiceHubConfig,
    getHubConfig,
    isHubChannel,
    getVoiceRecord,
    getUserVoiceSettings,
    createVoiceInterfaceEmbed,
    createVoiceInterfaceComponents
} from '../lib/voiceHelper.js';

export default {
    name: Events.VoiceStateUpdate,
    async execute(oldState, newState) {
        const guild = newState.guild ?? oldState.guild;
        if (!guild) return;

        // Check module settings for this server
        const isModuleEnabled = SettingsManager.getGuildJson(guild.id, 'module_voice_enabled', true)
            && SettingsManager.getGuildJson(guild.id, 'module_voicemaster_enabled', true);
        const isVoiceActive = SettingsManager.getGuildJson(guild.id, 'voice_enabled', true)
            && SettingsManager.getGuildJson(guild.id, 'voicemaster_enabled', true);

        if (!isModuleEnabled || !isVoiceActive) return;

        const member = newState.member ?? oldState.member;
        if (member?.user?.bot) return;

        try {
            // --- 1. JOIN TO CREATE (User enters any registered hub channel) ---
            const hubConfig = getHubConfig(newState.channelId);
            if (hubConfig && member) {
                // Check user's cross-server persistent channel name
                const userSettings = getUserVoiceSettings(member.id);
                let baseName;

                if (userSettings?.customName) {
                    baseName = userSettings.customName;
                } else {
                    const namingTemplate = SettingsManager.getGuild(guild.id, 'voice_naming_scheme')
                        || SettingsManager.getGuild(guild.id, 'voicemaster_naming_scheme')
                        || "{username}'s Room";
                    baseName = namingTemplate.replace('{username}', member.displayName || member.user.username);
                }

                // Support multiple channels: number identical channel names cleanly
                let channelName = baseName;
                const existingMatches = guild.channels?.cache
                    ? guild.channels.cache.filter(c => c.parentId === hubConfig.categoryId && c.name.startsWith(baseName)).size
                    : 0;

                if (existingMatches > 0) {
                    channelName = `${baseName} (${existingMatches + 1})`;
                }

                const defaultLimit = SettingsManager.getGuildJson(guild.id, 'voice_default_limit', 0);
                const roomLimit = (userSettings?.customLimit !== undefined && userSettings?.customLimit !== null)
                    ? userSettings.customLimit
                    : defaultLimit;

                // Create the temporary voice channel
                const newChannel = await guild.channels.create({
                    name: channelName,
                    type: ChannelType.GuildVoice,
                    parent: hubConfig.categoryId || undefined,
                    userLimit: roomLimit || undefined,
                    permissionOverwrites: [
                        {
                            id: member.id,
                            allow: [
                                PermissionFlagsBits.Connect,
                                PermissionFlagsBits.Speak,
                                PermissionFlagsBits.ManageChannels,
                                PermissionFlagsBits.MoveMembers,
                                PermissionFlagsBits.MuteMembers,
                                PermissionFlagsBits.DeafenMembers,
                            ],
                        },
                    ],
                });

                // Store in database
                db.prepare(`
                    INSERT INTO voice_channels (channelId, guildId, ownerId, createdAt)
                    VALUES (?, ?, ?, ?)
                `).run(newChannel.id, guild.id, member.id, Date.now());

                db.prepare(`
                    INSERT INTO voicemaster_channels (channelId, guildId, ownerId, createdAt)
                    VALUES (?, ?, ?, ?)
                `).run(newChannel.id, guild.id, member.id, Date.now());

                // Move member into the new room
                await member.voice.setChannel(newChannel.id).catch(() => {});

                // Send control interface directly in the new voice channel's chat box!
                const embed = createVoiceInterfaceEmbed();
                const components = createVoiceInterfaceComponents();
                await newChannel.send({ embeds: [embed], components }).catch(() => {});
            }

            // --- 2. AUTO-DELETE (When temporary room becomes empty) ---
            if (oldState.channelId && !isHubChannel(oldState.channelId)) {
                const record = getVoiceRecord(oldState.channelId);
                if (record) {
                    const channel = oldState.channel;
                    if (channel && channel.members.size === 0) {
                        db.prepare('DELETE FROM voice_channels WHERE channelId = ?').run(oldState.channelId);
                        db.prepare('DELETE FROM voicemaster_channels WHERE channelId = ?').run(oldState.channelId);
                        await channel.delete('Temporary voice room empty').catch(() => {});
                    }
                }
            }
        } catch (error) {
            console.error('[ERROR] Voice room lifecycle error:', error.message);
        }
    },
};
