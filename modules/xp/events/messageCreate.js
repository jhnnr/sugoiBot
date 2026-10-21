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
            // Check role reward for this level if enabled
            const roleRewardsEnabled = SettingsManager.getGuildJson(message.guild.id, 'role_rewards_enabled', true);
            let roleEarnedText = '';

            if (roleRewardsEnabled) {
                const rewards = SettingsManager.getGuildJson(message.guild.id, 'role_rewards', {});
                const rewardRoleId = rewards[String(result.level)];

                if (rewardRoleId && message.member?.roles) {
                    const rewardRole = message.guild.roles.cache.get(rewardRoleId) || await message.guild.roles.fetch(rewardRoleId).catch(() => null);
                    if (rewardRole && !message.member.roles.cache.has(rewardRole.id)) {
                        await message.member.roles.add(rewardRole.id).catch(() => {});
                        roleEarnedText = ` You unlocked the **${rewardRole.name}** role!`;
                    }
                }
            }

            const rawChannel = SettingsManager.getGuild(message.guild.id, 'xp_channel_id');
            const targetChannelId = rawChannel ? String(rawChannel).replace(/^["']|["']$/g, '').trim() : '';
            const targetChannel = targetChannelId ? (message.guild.channels.cache.get(targetChannelId) || await message.guild.channels.fetch(targetChannelId).catch(() => null)) : null;

            const congratsText = `Congrats ${message.author}! Level up to **${result.level}**!${roleEarnedText}`;
            if (targetChannel && typeof targetChannel.send === 'function') {
                await targetChannel.send(congratsText).catch(() => message.reply(congratsText));
            } else {
                await message.reply(congratsText);
            }
        }
    },
};
