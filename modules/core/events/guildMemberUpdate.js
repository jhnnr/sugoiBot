import { Events, EmbedBuilder } from 'discord.js';
import { loggingService } from '../../../lib/bot/loggingService.js';
import { SettingsManager } from '../../../lib/settings.js';

export default {
    name: Events.GuildMemberUpdate,
    async execute(oldMember, newMember) {
        if (!oldMember.guild) return;

        // Check if server avatar changed
        if (oldMember.avatar !== newMember.avatar) {
            const guild = newMember.guild;
            const oldAvatarUrl = oldMember.displayAvatarURL({ size: 256 });
            const newAvatarUrl = newMember.displayAvatarURL({ size: 256 });

            await loggingService.log(guild, {
                title: 'Server Avatar Changed',
                description: `**${newMember.user.tag}** (<@${newMember.id}>) updated their server profile picture in **${guild.name}**.\n\n` +
                    `• [Previous Avatar](${oldAvatarUrl})\n` +
                    `• [New Avatar](${newAvatarUrl})`,
                color: 0x5865F2,
                thumbnail: oldAvatarUrl,
                image: newAvatarUrl,
                eventType: 'log_events_member_update',
                user: newMember.user,
                fields: [{ name: 'User ID', value: newMember.id }]
            });
        }
    },
};
