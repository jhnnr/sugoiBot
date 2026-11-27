import { Events } from 'discord.js';
import { reconcileGuildVoiceRooms } from '../lib/voiceHelper.js';

export default {
    name: Events.ClientReady,
    once: true,
    async execute(client) {
        if (!client?.guilds?.cache) return;

        for (const guild of client.guilds.cache.values()) {
            try {
                await reconcileGuildVoiceRooms(guild);
            } catch (error) {
                console.error(`[ERROR] Failed to reconcile voice rooms for guild ${guild?.id}:`, error.message);
            }
        }
    },
};
