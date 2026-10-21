import { Events } from 'discord.js';
import { loggingService } from '../../../lib/bot/loggingService.js';

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
                description: `<@${newMember.id}> updated their server profile!`,
                color: 0x5865F2,
                thumbnail: newAvatarUrl,
                eventType: 'log_events_member_update',
                user: newMember.user,
                fields: [
                    { name: 'Avatar', value: `[before](${oldAvatarUrl}) -> [after](${newAvatarUrl})` }
                ],
                footerText: `User ID: ${newMember.id}`
            });
        }
    },
};
