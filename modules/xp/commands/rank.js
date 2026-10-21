import { SlashCommandBuilder, AttachmentBuilder } from 'discord.js';
import { Member } from '../../../lib/classes/Member.js';
import { generateRankCard } from '../../../lib/utils/rankCard.js';

export default {
    data: new SlashCommandBuilder()
        .setName('rank')
        .setDescription('Check your rank')
        .addUserOption(opt => opt.setName('user').setDescription('User to check')),
    async execute(interaction) {
        const targetUser = interaction.options.getUser('user') || interaction.user;
        const targetMember = interaction.options.getMember('user') || interaction.member;

        const member = new Member(targetMember);
        const data = member.getXP();
        data.rank = member.getRank();

        const getNeededXP = (lvl) => lvl * lvl * 100;
        const neededXP = getNeededXP(data.level);

        const cardBuffer = await generateRankCard(targetUser, data, neededXP);
        const attachment = new AttachmentBuilder(cardBuffer, { name: 'rank.png' });

        await interaction.reply({ files: [attachment] });
    },
};
