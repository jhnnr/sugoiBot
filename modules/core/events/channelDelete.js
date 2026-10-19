import { Events, AuditLogEvent, PermissionFlagsBits, ChannelType } from 'discord.js';
import { loggingService } from '../../../lib/bot/loggingService.js';

const CHANNEL_TYPE_NAMES = {
    [ChannelType.GuildText]: 'Text channel',
    [ChannelType.GuildVoice]: 'Voice channel',
    [ChannelType.GuildCategory]: 'Category',
    [ChannelType.GuildAnnouncement]: 'Announcement channel',
    [ChannelType.GuildStageVoice]: 'Stage channel',
    [ChannelType.GuildForum]: 'Forum channel',
};

export default {
    name: Events.ChannelDelete,
    async execute(channel) {
        if (!channel.guild) return;

        const guild = channel.guild;
        let deleter = null;

        if (guild.members?.me?.permissions?.has(PermissionFlagsBits.ViewAuditLog)) {
            try {
                const logs = await guild.fetchAuditLogs({
                    type: AuditLogEvent.ChannelDelete,
                    limit: 1
                }).catch(() => null);

                const entry = logs?.entries?.first();
                if (entry && (entry.targetId === channel.id || Date.now() - entry.createdTimestamp < 3500)) {
                    deleter = entry.executor;
                }
            } catch (err) {}
        }

        const typeName = CHANNEL_TYPE_NAMES[channel.type] || 'Channel';

        await loggingService.log(guild, {
            description: `🗑 ${typeName} deleted: **${channel.name}**`,
            color: 0xED4245,
            eventType: 'log_events_channels',
            user: deleter
        });
    },
};
