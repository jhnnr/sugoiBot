import { Events } from 'discord.js';

export default {
    name: Events.ClientReady,
    once: true,
    async execute(client) {
        console.log(`Ready! Logged in as ${client.user.tag}`);

        if (client.guilds?.cache) {
            for (const guild of client.guilds.cache.values()) {
                try {
                    const invites = await guild.invites.fetch();
                    client.invites.set(guild.id, new Map(invites.map(inv => [inv.code, inv.uses || 0])));
                } catch {
                    // Bot might lack Manage Guild permission to fetch invites
                }
            }
        }
    },
};
