import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { Member } from '../../../lib/classes/Member.js';

export default {
    data: new SlashCommandBuilder()
        .setName('coinflip')
        .setDescription('Bet your coins on a coin flip!')
        .addIntegerOption(opt =>
            opt.setName('amount')
                .setDescription('Amount of coins to bet')
                .setRequired(true)
                .setMinValue(1))
        .addStringOption(opt =>
            opt.setName('side')
                .setDescription('Pick heads or tails')
                .setRequired(true)
                .addChoices(
                    { name: 'Heads', value: 'heads' },
                    { name: 'Tails', value: 'tails' }
                )),
    async execute(interaction) {
        const bet = interaction.options.getInteger('amount');
        const chosenSide = interaction.options.getString('side');
        const member = new Member(interaction.member);

        const currentBalance = member.getBalance();
        if (currentBalance < bet) {
            return interaction.reply({
                content: `You don't have enough coins! Your balance is **${currentBalance}** coins.`,
                ephemeral: true
            });
        }

        const coinResult = Math.random() < 0.5 ? 'heads' : 'tails';
        const won = coinResult === chosenSide;

        let newBalance;
        if (won) {
            newBalance = member.addBalance(bet);
        } else {
            newBalance = member.addBalance(-bet);
        }

        const embed = new EmbedBuilder()
            .setTitle(won ? '🎉 You Won!' : '💀 You Lost!')
            .setDescription(`The coin landed on **${coinResult.toUpperCase()}**!\n\n` +
                (won
                    ? `You won **${bet}** coins! Your new balance is **${newBalance}** coins.`
                    : `You lost **${bet}** coins. Your new balance is **${newBalance}** coins.`))
            .setColor(won ? 0x57F287 : 0xED4245)
            .setFooter({ text: `Bet: ${bet} coins on ${chosenSide}` })
            .setTimestamp();

        await interaction.reply({ embeds: [embed] });
    },
};
