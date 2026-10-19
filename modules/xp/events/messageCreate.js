import { Events } from 'discord.js';
import { Member } from '../../../lib/classes/Member.js';
import { SettingsManager } from '../../../lib/settings.js';

export default {
    name: Events.MessageCreate,
    async execute(message) {
        if (message.author.bot || !message.guild) return;

        const moduleEnabled = SettingsManager.getGuildJson(message.guild.id, 'module_xp_enabled', true);
        if (!moduleEnabled) return;

        const enabled = SettingsManager.getGuildJson(message.guild.id, 'xp_enabled', true);
        if (!enabled) return;

        const min = SettingsManager.getJson('xp_min', 10);
        const max = SettingsManager.getJson('xp_max', 20);
        const xpToAdd = Math.floor(Math.random() * (max - min + 1)) + min;

        const member = new Member(message.member);
        const result = await member.addXP(xpToAdd);

        if (result.leveledUp) {
            await message.reply(`Congrats ${message.author}! Level up to **${result.level}**!`);
        }
    },
};
