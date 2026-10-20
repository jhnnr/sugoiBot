import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadCommands } from './commandHandler.js';
import { loadEvents } from './eventHandler.js';
import { SettingsManager } from '../lib/settings.js';

export async function loadModules(client) {
    const modulesPath = path.join(process.cwd(), 'modules');
    if (!fs.existsSync(modulesPath)) return;

    const modules = fs.readdirSync(modulesPath).filter(file => {
        return fs.statSync(path.join(modulesPath, file)).isDirectory();
    });

    for (const moduleName of modules) {
        const moduleDir = path.join(modulesPath, moduleName);

        // Load Module Info
        const indexPath = path.join(moduleDir, 'index.js');
        if (fs.existsSync(indexPath)) {
            const moduleUrl = pathToFileURL(indexPath).href;
            const moduleInfo = (await import(moduleUrl)).default;
            client.modules.set(moduleName, moduleInfo);

            if (moduleInfo?.settings) {
                SettingsManager.registerSchema(moduleInfo.settings);
            }
        }

        // Delegate to specific handlers
        await loadEvents(client, moduleDir);
        await loadCommands(client, moduleDir);
    }
}
