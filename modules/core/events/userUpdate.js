import { Events } from 'discord.js';
import { loggingService } from '../../../lib/bot/loggingService.js';

export default {
    name: Events.UserUpdate,
    async execute(oldUser, newUser) {
        // Only log if the avatar has changed
        if (oldUser.avatar === newUser.avatar) return;

        const oldAvatarUrl = oldUser.displayAvatarURL({ size: 256 });
        const newAvatarUrl = newUser.displayAvatarURL({ size: 256 });

        const client = newUser.client;
        if (!client.guilds?.cache) return;

        for (const guild of client.guilds.cache.values()) {
            try {
                // Check if user is a member of this guild
                const member = await guild.members.fetch(newUser.id).catch(() => null);
                if (!member) continue;

                await loggingService.log(guild, {
                    description: `<@${newUser.id}> updated their profile!`,
                    color: 0x5865F2,
                    thumbnail: newAvatarUrl,
                    eventType: 'log_events_member_update',
                    user: newUser,
                    fields: [
                        { name: 'Avatar', value: `[before](${oldAvatarUrl}) -> [after](${newAvatarUrl})` }
                    ],
                    footerText: `User ID: ${newUser.id}`
                });
            } catch (err) {
                // Ignore guild fetch errors
            }
        }
    },
};
