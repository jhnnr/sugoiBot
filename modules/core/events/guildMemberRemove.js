import { Events } from 'discord.js';
import { loggingService } from '../../../lib/bot/loggingService.js';

export default {
    name: Events.GuildMemberRemove,
    async execute(member) {
        if (!member.guild) return;

        const { guild } = member;

        await loggingService.log(guild, {
            description: `📤 **${member.user?.tag || member.id}** left the server`,
            color: 0xED4245,
            eventType: 'log_events_member_leave',
            user: member.user
        });
    },
};
