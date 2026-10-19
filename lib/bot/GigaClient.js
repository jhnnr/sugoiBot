import { Client, Collection, GatewayIntentBits, Partials } from 'discord.js';
import { logger } from './logger.js';

export class GigaClient extends Client {
    constructor() {
        super({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent,
                GatewayIntentBits.GuildVoiceStates,
                GatewayIntentBits.GuildMembers,
                GatewayIntentBits.GuildInvites,
                GatewayIntentBits.GuildPresences,
            ],
            partials: [
                Partials.Message,
                Partials.Channel,
                Partials.GuildMember,
                Partials.User,
            ],
        });

        this.commands = new Collection();
        this.cooldowns = new Collection();
        this.modules = new Collection();
        this.invites = new Map();
        this.logger = logger;
    }
}
