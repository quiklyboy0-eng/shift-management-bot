import 'dotenv/config';
import { REST } from '@discordjs/rest';
import { Routes } from 'discord-api-types/v10';
import { SlashCommandBuilder } from 'discord.js';

const token = process.env.DISCORD_TOKEN;
let clientId = process.env.CLIENT_ID?.trim();
const guildId = process.env.GUILD_ID?.trim();

if (!token) {
  console.error('Missing DISCORD_TOKEN in environment.');
  process.exit(1);
}

if (!clientId || clientId === 'your_application_client_id_here') {
  clientId = undefined;
}

const rest = new REST({ version: '10' }).setToken(token);

async function resolveClientId() {
  if (clientId) return clientId;
  try {
    const application = await rest.get(Routes.oauth2CurrentApplication());
    return application?.id || application?.application?.id;
  } catch (error) {
    console.error('Could not resolve application client ID from the bot token:', error);
    return null;
  }
}

const shiftCommand = new SlashCommandBuilder()
  .setName('shift')
  .setDescription('Shift management system')
  .addSubcommand(subcommand =>
    subcommand
      .setName('manage')
      .setDescription('Open your shift dashboard and start a shift.'))
  .addSubcommand(subcommand =>
    subcommand
      .setName('online')
      .setDescription('Show users currently on shift.'))
  .addSubcommand(subcommand =>
    subcommand
      .setName('leaderboard')
      .setDescription('View a department shift leaderboard.')
      .addIntegerOption(option =>
        option.setName('wave')
          .setDescription('Wave number to view (default = current wave)')
          .setRequired(false)))
  .addSubcommand(subcommand =>
    subcommand
      .setName('remove')
      .setDescription('Remove a user\'s active or completed shift.')
      .addUserOption(option =>
        option.setName('user')
          .setDescription('The user whose shift should be removed.')
          .setRequired(true))
      .addIntegerOption(option =>
        option.setName('shift')
          .setDescription('The completed shift number to remove from history (1 = first completed shift).')
          .setRequired(false)));

const quotaCommand = new SlashCommandBuilder()
  .setName('quota')
  .setDescription('Quota management commands')
  .addSubcommand(subcommand =>
    subcommand
      .setName('end')
      .setDescription('End the current quota wave early and start a new one.'));

const commands = [shiftCommand, quotaCommand].map(command => command.toJSON());

async function cleanupGlobalCommands(resolvedClientId) {
  try {
    const globalCommands = await rest.get(Routes.applicationCommands(resolvedClientId));
    const duplicateGlobalCommands = globalCommands.filter(cmd => commands.some(c => c.name === cmd.name));

    if (!duplicateGlobalCommands.length) {
      console.log('No duplicate global commands found to remove.');
      return;
    }

    for (const cmd of duplicateGlobalCommands) {
      console.log(`Removing duplicate global command ${cmd.name} (${cmd.id})...`);
      await rest.delete(Routes.applicationCommand(resolvedClientId, cmd.id));
    }

    console.log('Duplicate global commands cleaned up.');
  } catch (error) {
    console.warn('Failed to clean up global commands:', error);
  }
}

(async () => {
  try {
    const resolvedClientId = await resolveClientId();
    if (!resolvedClientId) {
      console.error('Missing CLIENT_ID and could not resolve it from the bot token.');
      process.exit(1);
    }

    if (guildId) {
      console.log(`Registering commands to guild ${guildId}...`);
      await rest.put(
        Routes.applicationGuildCommands(resolvedClientId, guildId),
        { body: commands }
      );
      console.log('Guild commands registered successfully.');

      if (process.env.CLEAN_GLOBAL === 'true') {
        await cleanupGlobalCommands(resolvedClientId);
      }
    } else {
      console.log('Registering global commands...');
      await rest.put(
        Routes.applicationCommands(resolvedClientId),
        { body: commands }
      );
      console.log('Global commands registered successfully.');
    }
  } catch (error) {
    console.error('Failed to register commands:', error);
    process.exit(1);
  }
})();
