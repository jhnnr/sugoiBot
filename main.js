import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '.env') });
dotenv.config();

import { GigaClient } from './lib/bot/GigaClient.js';
import { loadModules } from './handlers/moduleHandler.js';
import { deployCommands } from './deploy-commands.js';
import { startDashboard } from './dashboard/server.js';

const client = new GigaClient();

process.on('unhandledRejection', (reason, promise) => {
    client.logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
    client.logger.error('Uncaught Exception thrown:', error);
});

async function start() {
    client.logger.info('Starting Sugoi Bot...');
    startDashboard(client);
    await loadModules(client);
    
    // Deploy commands without blocking bot startup
    deployCommands().catch(err => client.logger.error('Failed to deploy application commands:', err));

    await client.login(process.env.DISCORD_TOKEN);
}

start().catch(err => client.logger.error('Bot failed to start:', err));
