import { Events } from 'discord.js';
import { startVoiceXpInterval } from '../../xp/events/voiceStateUpdate.js';

export default {
    name: Events.ClientReady,
    once: true,
    async execute(client) {
        console.log(`Ready! Logged in as ${client.user.tag}`);

        // Initialize background Voice XP tracking loop and register active voice users
        try {
            startVoiceXpInterval(client);
        } catch (err) {
            console.error('[XP ERROR] Failed to start voice XP loop:', err);
        }

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
