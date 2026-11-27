import { Events } from 'discord.js';
import db from '../../../lib/database.js';
import {
    getVoiceRecord,
    isHubChannel,
    deleteVoiceRoomRecord,
    emitVoiceUpdate
} from '../lib/voiceHelper.js';

export default {
    name: Events.ChannelDelete,
    async execute(channel) {
        if (!channel?.id) return;

        try {
            let matched = false;
            const record = getVoiceRecord(channel.id);
            if (record) {
                deleteVoiceRoomRecord(channel.id);
                matched = true;
            }

            if (isHubChannel(channel.id)) {
                db.prepare?.('DELETE FROM voice_hubs WHERE hubChannelId = ?')?.run?.(channel.id);
                db.prepare?.('DELETE FROM voice_guilds WHERE hubChannelId = ?')?.run?.(channel.id);
                db.prepare?.('DELETE FROM voicemaster_guilds WHERE hubChannelId = ?')?.run?.(channel.id);
                matched = true;
            }

            const guildId = channel.guildId || channel.guild?.id || record?.guildId;
            if (matched && guildId) {
                emitVoiceUpdate(guildId);
            }
        } catch (error) {
            console.error('[ERROR] Voice channelDelete cleanup error:', error.message);
        }
    },
};
