import { Events } from 'discord.js';
import {
    getVoiceRecord,
    isHubChannel,
    emitVoiceUpdate
} from '../lib/voiceHelper.js';

export default {
    name: Events.ChannelUpdate,
    async execute(oldChannel, newChannel) {
        if (!newChannel?.id) return;

        const guildId = newChannel.guildId || newChannel.guild?.id || oldChannel?.guildId || oldChannel?.guild?.id;
        if (!guildId) return;

        const changed = !oldChannel
            || oldChannel.name !== newChannel.name
            || oldChannel.userLimit !== newChannel.userLimit
            || oldChannel.parentId !== newChannel.parentId;

        if (!changed) return;

        try {
            if (getVoiceRecord(newChannel.id) || isHubChannel(newChannel.id)) {
                emitVoiceUpdate(guildId);
            }
        } catch (error) {
            console.error('[ERROR] Voice channelUpdate error:', error.message);
        }
    },
};
