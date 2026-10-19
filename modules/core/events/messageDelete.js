import { Events } from 'discord.js';
import { loggingService } from '../../../lib/bot/loggingService.js';

export default {
    name: Events.MessageDelete,
    async execute(message) {
        if (!message.guild) return;
        if (message.author?.bot) return;

        const contentText = message.content?.substring(0, 1024) || '*No text content (embed or attachment)*';

        await loggingService.log(message.guild, {
            description: `🗑️ Message deleted in ${message.channel}\n${contentText}`,
            color: 0xED4245,
            eventType: 'log_events_message_delete',
            user: message.author
        });
    },
};
