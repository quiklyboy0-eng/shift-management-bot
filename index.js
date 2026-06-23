import 'dotenv/config';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ComponentType,
  Colors,
} from 'discord.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, 'data');
const dataFile = path.join(dataDir, 'shifts.json');

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('Missing DISCORD_TOKEN in environment.');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.Channel],
});

const DEPARTMENTS = {
  Staff: {
    roleId: '1412955172547592245',
    color: 0x1F8B4C,
    label: 'Staff Shift',
    emoji: '🛡️',
  },
  Fire: {
    roleId: '1494287571453481021',
    color: 0xE03C31,
    label: 'Fire Department Shift',
    emoji: '🚒',
  },
  WSP: {
    roleId: '1494287579871318087',
    color: 0x2255A4,
    label: 'WSP Shift',
    emoji: '🚓',
  },
  DOT: {
    roleId: '1494287577820172329',
    color: 0xFFC300,
    label: 'DOT Shift',
    emoji: '🛣️',
  },
};

const STAFF_OVERRIDE_ROLE = '1519072293861593219';

async function resolveMember(interaction) {
  if (!interaction.guild) return interaction.member;

  try {
    const member = await interaction.guild.members.fetch(interaction.user.id);
    if (member && member.roles && member.roles.cache) {
      return member;
    }
  } catch (error) {
    console.warn('Could not fetch member from guild:', error);
  }

  return interaction.member;
}

function getMemberRoleIds(member) {
  if (!member?.roles) return [];
  if (member.roles.cache) {
    return member.roles.cache.map(role => role.id);
  }
  if (Array.isArray(member.roles)) {
    return member.roles;
  }
  if (Array.isArray(member.roles.value)) {
    return member.roles.value;
  }
  return [];
}

function hasStaffOverride(member) {
  const roleIds = getMemberRoleIds(member);
  const hasOverride = roleIds.includes(STAFF_OVERRIDE_ROLE);
  if (!hasOverride) {
    console.debug('Staff override check failed. Member role IDs:', roleIds);
  }
  return hasOverride;
}

const QUOTA_HOURS = 6;
const WAVE_LENGTH_DAYS = 14;
const QUOTA_RESET_MS = WAVE_LENGTH_DAYS * 24 * 60 * 60 * 1000;

const INITIAL_DATA = {
  users: {},
  waves: {},
  currentWaveStart: Date.now(),
  currentWaveBase: 1,
};

let CURRENT_WAVE_START = INITIAL_DATA.currentWaveStart;
let CURRENT_WAVE_BASE = INITIAL_DATA.currentWaveBase;

async function loadData() {
  await fs.ensureDir(dataDir);
  if (!(await fs.pathExists(dataFile))) {
    await fs.writeJson(dataFile, INITIAL_DATA, { spaces: 2 });
  }
  const data = await fs.readJson(dataFile);
  CURRENT_WAVE_START = data.currentWaveStart || INITIAL_DATA.currentWaveStart;
  CURRENT_WAVE_BASE = data.currentWaveBase || INITIAL_DATA.currentWaveBase;

  let migrated = false;
  for (const userData of Object.values(data.users || {})) {
    if (Array.isArray(userData.history)) {
      for (const record of userData.history) {
        if (record && record.waveNumber == null) {
          record.waveNumber = getWaveNumber(record.startedAt);
          migrated = true;
        }
      }
    }
  }

  if (migrated) {
    await fs.writeJson(dataFile, data, { spaces: 2 });
  }

  return data;
}

async function saveData(data) {
  await fs.writeJson(dataFile, data, { spaces: 2 });
}

function formatDuration(ms) {
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${String(minutes).padStart(2, '0')}m`;
}

function buildProgressBar(currentMs, targetMs, length = 18) {
  const ratio = Math.min(currentMs / targetMs, 1);
  const filled = Math.round(ratio * length);
  const empty = length - filled;
  return `[32m${'█'.repeat(filled)}[0m${'─'.repeat(empty)}`;
}

function buildVisualBar(currentMs, targetMs, length = 18) {
  const ratio = Math.min(currentMs / targetMs, 1);
  const filledCount = Math.round(ratio * length);
  const emptyCount = length - filledCount;
  const filled = '▰'.repeat(filledCount);
  const empty = '▱'.repeat(emptyCount);
  return `${filled}${empty}`;
}

function getCurrentWaveStart(now = Date.now()) {
  const firstStart = CURRENT_WAVE_START;
  const elapsed = now - firstStart;
  const waveIndex = Math.floor(elapsed / QUOTA_RESET_MS);
  return firstStart + waveIndex * QUOTA_RESET_MS;
}

function getWaveNumber(ts = Date.now()) {
  const firstStart = CURRENT_WAVE_START;
  const elapsed = ts - firstStart;
  return Math.floor(elapsed / QUOTA_RESET_MS) + CURRENT_WAVE_BASE;
}

function quotaStatusIcon(hoursWorked) {
  return hoursWorked >= QUOTA_HOURS ? '🟢' : '🔴';
}

function isOnShift(userData) {
  return Boolean(userData.activeShift);
}

function getAvailableDepartments(member) {
  if (hasStaffOverride(member)) {
    return Object.entries(DEPARTMENTS);
  }

  return Object.entries(DEPARTMENTS).filter(([, dept]) => {
    try {
      return Boolean(member?.roles?.cache?.has(dept.roleId));
    } catch (e) {
      return false;
    }
  });
}

function buildDashboardEmbed(member, userData, availableDepts) {
  const totalShifts = userData.completedShifts || 0;
  const totalWorkedMs = userData.totalShiftTime || 0;
  const totalBreakMs = userData.totalBreakTime || 0;
  const lastShift = userData.history?.slice(-1)[0];
  const currentWaveStart = getCurrentWaveStart();
  const currentWave = getWaveNumber();
  const waveKey = String(currentWave);
  const waveHours = userData.waveHours?.[waveKey] || 0;
  const quotaMs = QUOTA_HOURS * 60 * 60000;

  const progressBar = buildVisualBar(waveHours, quotaMs);
  const progressValue = `${formatDuration(waveHours)} / ${QUOTA_HOURS}h`;

  const activeShift = userData.activeShift;
  const activeShiftInfo = activeShift
    ? `**Shift:** ${DEPARTMENTS[activeShift.department].emoji} ${DEPARTMENTS[activeShift.department].label}
**Started:** <t:${Math.floor(activeShift.startedAt / 1000)}:R>
**Elapsed:** ${formatDuration(Date.now() - activeShift.startedAt)}
**On Break:** ${activeShift.onBreak ? 'Yes' : 'No'}`
    : 'No active shift at the moment.';

  const description = `**Welcome back, ${member.user.username}**
Select a shift type, track your hours, and keep quota progress visible in real time.

**Current Wave:** ${currentWave} • ${new Date(currentWaveStart).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} — <t:${Math.floor(currentWaveStart / 1000)}:R>`;

  return new EmbedBuilder()
    .setTitle('Shift Command Center')
    .setColor(availableDepts.length ? availableDepts[0][1].color : Colors.Blurple)
    .setDescription(description)
    .addFields(
      { name: '📊 Total Shifts Completed', value: `${totalShifts}`, inline: true },
      { name: '⏱️ Total Shift Time', value: `${formatDuration(totalWorkedMs)}`, inline: true },
      { name: '☕ Total Break Time', value: `${formatDuration(totalBreakMs)}`, inline: true },
      {
        name: '📈 Quota Progress',
        value: `${progressBar}
${progressValue} ${quotaStatusIcon(waveHours)}`,
        inline: false,
      },
      {
        name: '🚦 Current Session',
        value: activeShiftInfo,
        inline: false,
      }
    )
    .setFooter({ text: 'Quota resets every 2 weeks.' });
}

function buildOnlineEmbed(onlineUsers) {
  const embed = new EmbedBuilder()
    .setTitle('Live Shift Roster')
    .setDescription('Currently active shift sessions across departments.')
    .setColor(0x2F3136)
    .setFooter({ text: 'Automatically updates when users start or end shifts.' });

  if (!onlineUsers.length) {
    embed.addFields({ name: 'No active shifts', value: 'No members are on shift right now.', inline: false });
    return embed;
  }

  const fields = onlineUsers.map(item => ({
    name: `${item.department.emoji} ${item.department.label}`,
    value: `${item.member} • <t:${Math.floor(item.startedAt / 1000)}:R>
**Duration:** ${formatDuration(Date.now() - item.startedAt)} ${item.onBreak ? '\n**Status:** On Break' : ''}`,
    inline: false,
  }));

  embed.addFields(fields);
  return embed;
}

function buildActiveShiftEmbed(userId, userData) {
  const active = userData.activeShift;
  const dept = active ? DEPARTMENTS[active.department] : null;
  const embed = new EmbedBuilder()
    .setTitle(active ? `${dept.emoji} ${dept.label} — Active Shift` : 'Shift Session')
    .setColor(active ? dept.color : Colors.Blurple)
    .setFooter({ text: 'Use the buttons to manage this shift.' });

  if (!active) {
    embed.setDescription('No active shift.');
    return embed;
  }

  const elapsed = formatDuration(Date.now() - active.startedAt);
  const status = active.onBreak ? 'On Break' : 'On Duty';

  embed.setDescription(`<@${userId}>\n**Status:** ${status}`)
    .addFields(
      { name: 'Department', value: `${dept.emoji} ${dept.label}`, inline: true },
      { name: 'Started', value: `<t:${Math.floor(active.startedAt / 1000)}:R>`, inline: true },
      { name: 'Elapsed', value: elapsed, inline: true }
    );

  return embed;
}

function buildActiveShiftComponents(userId, userData) {
  if (!userData?.activeShift) return [];
  const ownerId = userId;
  const onBreak = Boolean(userData.activeShift.onBreak);

  const breakLabel = onBreak ? 'End Break' : 'Start Break';

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`start_break:${ownerId}`).setLabel(breakLabel).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`end_shift:${ownerId}`).setLabel('End Shift').setStyle(ButtonStyle.Danger)
  );

  return [row];
}

async function findBestPublicChannel(interaction) {
  if (!interaction.guild) return null;

  const tryChannelIds = [interaction.channelId, interaction.guild.systemChannelId].filter(Boolean);
  for (const cid of tryChannelIds) {
    const channel = await client.channels.fetch(cid).catch(() => null);
    if (!channel) continue;
    const isText = channel.isTextBased ? channel.isTextBased() : channel.isText?.();
    if (isText && channel.permissionsFor(client.user)?.has('SendMessages')) {
      console.debug('findBestPublicChannel selected channel', { channelId: cid, type: channel.type });
      return channel;
    }
  }

  if (interaction.channel) {
    const channel = interaction.channel;
    const isText = channel.isTextBased ? channel.isTextBased() : channel.isText?.();
    if (isText && channel.permissionsFor(client.user)?.has('SendMessages')) {
      console.debug('findBestPublicChannel selected interaction.channel', { channelId: channel.id, type: channel.type });
      return channel;
    }
  }

  const fetched = await interaction.guild.channels.fetch().catch(() => null);
  if (fetched) {
    const channel = fetched.find(c => {
      const isText = c.isTextBased ? c.isTextBased() : c.isText?.();
      return isText && c.permissionsFor && c.permissionsFor(client.user)?.has('SendMessages');
    }) || null;
    if (channel) {
      console.debug('findBestPublicChannel fallback selected channel', { channelId: channel.id, type: channel.type });
      return channel;
    }
  }

  if (interaction.guild.channels && interaction.guild.channels.cache) {
    const channel = interaction.guild.channels.cache.find(c => {
      const isText = c.isTextBased ? c.isTextBased() : c.isText?.();
      return isText && c.permissionsFor && c.permissionsFor(client.user)?.has('SendMessages');
    }) || null;
    if (channel) {
      console.debug('findBestPublicChannel cache fallback selected channel', { channelId: channel.id, type: channel.type });
      return channel;
    }
  }

  console.warn('findBestPublicChannel could not find any suitable text channel');
  return null;
}

async function resolveInteractionMessageChannel(interaction) {
  if (interaction.message?.channel) return interaction.message.channel;
  if (interaction.message?.channelId) {
    return await client.channels.fetch(interaction.message.channelId).catch(() => null);
  }
  if (interaction.channel) return interaction.channel;
  if (interaction.channelId) {
    return await client.channels.fetch(interaction.channelId).catch(() => null);
  }
  return null;
}

async function editInteractionMessage(interaction, payload) {
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(payload);
    } else {
      await interaction.update(payload);
    }
    console.debug('editInteractionMessage succeeded via update/editReply', { messageId: interaction.message?.id, channelId: interaction.channelId });
    return true;
  } catch (e) {
    console.debug('editInteractionMessage primary update failed', { err: String(e), messageId: interaction.message?.id, channelId: interaction.channelId });
    if (interaction.message?.editable) {
      try {
        await interaction.message.edit(payload);
        console.debug('editInteractionMessage succeeded via interaction.message.edit', { messageId: interaction.message.id, channelId: interaction.message.channelId });
        return true;
      } catch (editError) {
        console.debug('editInteractionMessage fallback interaction.message.edit failed', { err: String(editError), messageId: interaction.message?.id });
        return false;
      }
    }
    return false;
  }
}

async function updatePublicShiftMessageForUser(userId, userData) {
  try {
    console.debug('updatePublicShiftMessageForUser called', { userId, hasActive: !!userData.activeShift, dashboardMessage: userData.dashboardMessage, lastShiftMessage: userData.lastShiftMessage });
    let msgRef = userData.activeShift?.message || userData.dashboardMessage || userData.lastShiftMessage;
    if (!msgRef || !msgRef.channelId || !msgRef.messageId) {
      console.debug('updatePublicShiftMessageForUser no message refs', { userId });

      // If the user currently has an active shift, try to create a new public message
      if (userData.activeShift) {
        try {
          const fakeInteraction = { guild: client.guilds.cache.first(), channelId: null, channel: null };
          const targetChannel = await findBestPublicChannel(fakeInteraction);
          if (targetChannel && targetChannel.send) {
            const embed = buildActiveShiftEmbed(userId, userData);
            const components = buildActiveShiftComponents(userId, userData);
            const publicMsg = await targetChannel.send({ embeds: [embed], components }).catch(() => null);
            if (publicMsg) {
              // persist the newly created message reference
              const data = await loadData();
              await ensureUserData(data, userId);
              data.users[userId].activeShift = data.users[userId].activeShift || {};
              data.users[userId].activeShift.message = { channelId: targetChannel.id, messageId: publicMsg.id };
              data.users[userId].dashboardMessage = data.users[userId].dashboardMessage || { channelId: targetChannel.id, messageId: publicMsg.id };
              await saveData(data).catch(() => null);
              msgRef = data.users[userId].activeShift.message;
              console.debug('Created fallback public message for active shift', { userId, channelId: targetChannel.id, messageId: publicMsg.id });
            } else {
              console.debug('Failed to post fallback public message', { userId });
              return;
            }
          } else {
            console.debug('No available channel to post fallback public message', { userId });
            return;
          }
        } catch (e) {
          console.warn('Fallback public message creation failed', e);
          return;
        }
      } else {
        console.debug('updatePublicShiftMessageForUser skipping because no message refs and no active shift', { userId });
        return;
      }
    }
    let channel = await client.channels.fetch(msgRef.channelId).catch((err) => {
      console.debug('Failed to fetch channel for msgRef', { userId, channelId: msgRef.channelId, err: String(err) });
      return null;
    });

    // If the saved channel is missing or inaccessible, try to create a replacement
    if (!channel) {
      console.debug('Saved channel inaccessible; attempting fallback posting', { userId, channelId: msgRef?.channelId });
      if (!userData.activeShift) {
        console.debug('No active shift to recreate public/dashboard message for', { userId });
        return;
      }

      // try to find a suitable public channel using existing helper
      try {
        const fakeInteraction = { guild: client.guilds.cache.first(), channelId: null, channel: null };
        const targetChannel = await findBestPublicChannel(fakeInteraction);
        if (!targetChannel || !targetChannel.send) {
          console.debug('No accessible fallback channel found via findBestPublicChannel', { userId });
          return;
        }

        const embed = buildActiveShiftEmbed(userId, userData);
        const components = buildActiveShiftComponents(userId, userData);
        const publicMsg = await targetChannel.send({ embeds: [embed], components }).catch(() => null);
        if (!publicMsg) {
          console.debug('Fallback post failed', { userId, channelId: targetChannel.id });
          return;
        }

        // persist the newly created message reference and use it
        const data = await loadData();
        await ensureUserData(data, userId);
        data.users[userId].activeShift = data.users[userId].activeShift || {};
        data.users[userId].activeShift.message = { channelId: targetChannel.id, messageId: publicMsg.id };
        data.users[userId].dashboardMessage = data.users[userId].dashboardMessage || { channelId: targetChannel.id, messageId: publicMsg.id };
        await saveData(data).catch(() => null);
        msgRef = data.users[userId].activeShift.message;
        channel = targetChannel;
        console.debug('Created fallback public message for active shift (post-recovery)', { userId, channelId: targetChannel.id, messageId: publicMsg.id });
      } catch (e) {
        console.warn('Fallback posting after missing channel failed', e);
        return;
      }
    }
    const msg = await channel.messages.fetch(msgRef.messageId).catch((err) => {
      console.debug('Failed to fetch message for msgRef', { userId, messageId: msgRef.messageId, err: String(err) });
      return null;
    });
    if (!msg) {
      console.debug('updatePublicShiftMessageForUser aborting: message not found', { userId, messageId: msgRef?.messageId });
      return;
    }

    if (!userData.activeShift) {
      // shift ended - edit to show ended and remove components
      const endedEmbed = new EmbedBuilder()
        .setTitle('Shift Ended')
        .setDescription(`<@${userId}> ended their shift.`)
        .setColor(0x2F3136);
      await msg.edit({ embeds: [endedEmbed], components: [] }).catch(() => null);

      // also update dashboard if present
      try {
        if (userData.dashboardMessage) {
          const dchannel = await client.channels.fetch(userData.dashboardMessage.channelId).catch(() => null);
          if (dchannel) {
            const dmsg = await dchannel.messages.fetch(userData.dashboardMessage.messageId).catch(() => null);
            if (dmsg) {
              const member = await dchannel.guild.members.fetch(userId).catch(() => null);
              const avail = getAvailableDepartments(member || {});
              const dash = buildDashboardEmbed(member || { user: { username: 'User' } }, userData, avail);
              const startRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                  .setCustomId('start_shift')
                  .setLabel('Start Shift')
                  .setStyle(ButtonStyle.Success)
              );
              await dmsg.edit({ embeds: [dash], components: [startRow] }).catch(() => null);
            }
          }
        }
      } catch (e) {
        /* ignore dashboard update errors */
      }

      return;
    }

    const embed = buildActiveShiftEmbed(userId, userData);
    const components = buildActiveShiftComponents(userId, userData);
    await msg.edit({ embeds: [embed], components }).catch(() => null);

    // also update dashboard if present
    try {
      if (userData.dashboardMessage) {
        const dchannel = await client.channels.fetch(userData.dashboardMessage.channelId).catch(() => null);
        if (dchannel) {
          const dmsg = await dchannel.messages.fetch(userData.dashboardMessage.messageId).catch(() => null);
          if (dmsg) {
            const member = await dchannel.guild.members.fetch(userId).catch(() => null);
            const avail = getAvailableDepartments(member || {});
            const dash = buildDashboardEmbed(member || { user: { username: 'User' } }, userData, avail);
            await dmsg.edit({ embeds: [dash], components: buildActiveShiftComponents(userId, userData) }).catch(() => null);
          }
        }
      }
    } catch (e) {
      /* ignore dashboard update errors */
    }
  } catch (e) {
    console.warn('Failed to update public shift message for user', userId, e);
  }
}

// Periodic updater: refresh active/public/dashboard messages every intervalMs (default 10s)
let _periodicInterval = null;
const _lastAutoUpdateMap = new Map();
function startPeriodicUpdater(intervalMs = 10000) {
  if (_periodicInterval) clearInterval(_periodicInterval);
  _periodicInterval = setInterval(async () => {
    try {
      const data = await loadData();
      const now = Date.now();
      for (const [userId, userData] of Object.entries(data.users || {})) {
        if (!userData) continue;
        // update if there's an active shift, a recent public message, or a saved dashboard message
        if (!userData.activeShift && !userData.lastShiftMessage && !userData.activeShift?.message && !userData.dashboardMessage) continue;
        const last = _lastAutoUpdateMap.get(userId) || 0;
        if (now - last < intervalMs) continue;
        _lastAutoUpdateMap.set(userId, now);
        await updatePublicShiftMessageForUser(userId, userData).catch(() => null);
      }
    } catch (e) {
      console.warn('Periodic updater error', e);
    }
  }, intervalMs);
}

function stopPeriodicUpdater() {
  if (_periodicInterval) {
    clearInterval(_periodicInterval);
    _periodicInterval = null;
  }
}

function buildLeaderboardEmbed(department, leaderboardRows, waveNumber) {
  const color = department.color;
  const title = `${department.emoji} ${department.label} Leaderboard`;
  const suffix = waveNumber ? `Wave ${waveNumber}` : 'Current Wave';

  const description = `Quota Requirement: **6 Hours Every 2 Weeks**\nAutomatically Resets Every 2 Weeks.`;
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(color)
    .setDescription(description)
    .setFooter({ text: `Wave ${waveNumber} | Premium shift analytics` });

  if (!leaderboardRows.length) {
    embed.addFields({ name: 'No data available', value: 'No shift records were found for this department and wave.', inline: false });
    return embed;
  }

  embed.addFields(
    ...leaderboardRows.map(row => ({
      name: `${row.status} ${row.member}`,
      value: `**${row.total}** • ${row.progress}`,
      inline: false,
    }))
  );

  return embed;
}

function getDepartmentOptions(availableDepts) {
  return availableDepts.map(([key, dept]) => ({
    label: dept.label,
    value: key,
    description: `Start or view ${dept.label}`,
    emoji: dept.emoji,
  }));
}

async function ensureUserData(data, userId) {
  if (!data.users[userId]) {
    data.users[userId] = {
      completedShifts: 0,
      totalShiftTime: 0,
      totalBreakTime: 0,
      waveHours: {},
      history: [],
      activeShift: null,
    };
  }
  return data.users[userId];
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await loadData();
  // start periodic updater to keep live embeds fresh (~10s)
  startPeriodicUpdater(10000);
});

client.on('interactionCreate', async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      const commandName = interaction.commandName;
      const subcommand = interaction.options.getSubcommand();
      const member = await resolveMember(interaction);
      const data = await loadData();

      if (commandName === 'quota') {
        if (!hasStaffOverride(member)) {
          return interaction.reply({ content: 'Only staff may end the current quota wave early.', ephemeral: true });
        }

        if (subcommand === 'end') {
          const currentTime = Date.now();
          const currentWave = getWaveNumber(currentTime);
          data.currentWaveStart = currentTime;
          data.currentWaveBase = currentWave + 1;
          CURRENT_WAVE_START = currentTime;
          CURRENT_WAVE_BASE = currentWave + 1;
          await saveData(data);

          for (const [userId, userData] of Object.entries(data.users || {})) {
            await updatePublicShiftMessageForUser(userId, userData).catch(() => null);
          }

          return interaction.reply({ content: `Quota wave ended early and reset starting now. New wave begins <t:${Math.floor(currentTime / 1000)}:R>.`, ephemeral: true });
        }

        return interaction.reply({ content: 'Unknown quota command.', ephemeral: true });
      }

      const availableDepts = getAvailableDepartments(member);
      const userData = await ensureUserData(data, interaction.user.id);

      if (!availableDepts.length) {
        if (hasStaffOverride(member)) {
          console.log(`Staff override active for ${interaction.user.id}`);
          return await interaction.reply({ content: 'Staff override role detected. You now have access to all department commands.', ephemeral: true });
        }

        console.warn(`No department access for ${interaction.user.id}. Member roles: ${member?.roles?.cache?.map(r => r.id).join(', ')}`);
        return await interaction.reply({ content: 'You do not have access to any shift departments.', ephemeral: true });
      }

      switch (subcommand) {
        case 'manage': {
          const dashboardEmbed = buildDashboardEmbed(member, userData, availableDepts);
          const components = [];
          const startShiftRow = new ActionRowBuilder();

          if (!userData.activeShift) {
            startShiftRow.addComponents(
              new ButtonBuilder()
                .setCustomId('start_shift')
                .setLabel('Start Shift')
                .setStyle(ButtonStyle.Success)
            );
            components.push(startShiftRow);
          } else {
            startShiftRow.addComponents(
              new ButtonBuilder()
                .setCustomId(`start_break:${interaction.user.id}`)
                .setLabel(userData.activeShift.onBreak ? 'Resume Shift' : 'Start Break')
                .setStyle(ButtonStyle.Secondary),
              new ButtonBuilder()
                .setCustomId(`end_shift:${interaction.user.id}`)
                .setLabel('End Shift')
                .setStyle(ButtonStyle.Danger)
            );
            components.push(startShiftRow);
          }

          // Public dashboard (visible to everyone)
          await interaction.reply({ embeds: [dashboardEmbed], components, ephemeral: false });
          // save dashboard message reference so we can update it later
          try {
            const replyMsg = await interaction.fetchReply();
            userData.dashboardMessage = { channelId: interaction.channelId, messageId: replyMsg.id };
            await saveData(data);
            console.debug('Saved dashboard message reference', { userId: interaction.user.id, messageId: userData.dashboardMessage.messageId });
          } catch (e) {
            console.warn('Failed to save dashboard message reference', e);
          }
          break;
        }
        case 'online': {
          const onlineUsers = Object.entries(data.users)
            .filter(([, userData]) => userData.activeShift)
            .map(([userId, userData]) => ({
              member: `<@${userId}>`,
              department: DEPARTMENTS[userData.activeShift.department],
              startedAt: userData.activeShift.startedAt,
              onBreak: Boolean(userData.activeShift.onBreak),
            }));

          const onlineEmbed = buildOnlineEmbed(onlineUsers);
          await interaction.reply({ embeds: [onlineEmbed], ephemeral: false });
          break;
        }
        case 'leaderboard': {
          const waveNumber = interaction.options.getInteger('wave') || getWaveNumber();
          const waveKey = String(waveNumber);
          const availableOptions = availableDepts.map(([key]) => key);

          const selectMenu = new StringSelectMenuBuilder()
            .setCustomId(`leaderboard_select_${waveKey}`)
            .setMinValues(1)
            .setMaxValues(1)
            .setPlaceholder('Select department leaderboard')
            .addOptions(availableDepts.map(([key, dept]) => ({
              label: dept.label,
              value: key,
              description: `View ${dept.label} leaderboard for wave ${waveNumber}`,
              emoji: dept.emoji,
            })));

          await interaction.reply({ content: `Choose a department to view the leaderboard for wave **${waveNumber}**.`, components: [new ActionRowBuilder().addComponents(selectMenu)], ephemeral: true });
          break;
        }
        case 'remove': {
          const targetUser = interaction.options.getUser('user', true);
          const shiftNumber = interaction.options.getInteger('shift');
          const targetId = targetUser.id;
          const targetData = await ensureUserData(data, targetId);
          const targetMember = interaction.guild ? await interaction.guild.members.fetch(targetId).catch(() => null) : null;

          if (targetId !== interaction.user.id && !hasStaffOverride(member)) {
            return interaction.reply({ content: 'Only staff may remove another user\'s shift.', ephemeral: true });
          }

          if (shiftNumber != null) {
            const history = targetData.history || [];
            if (!history.length) {
              return interaction.reply({ content: `${targetUser.username} has no completed shifts to remove.`, ephemeral: true });
            }
            if (shiftNumber < 1 || shiftNumber > history.length) {
              return interaction.reply({ content: `Shift number must be between 1 and ${history.length}.`, ephemeral: true });
            }

            const removedShift = history.splice(shiftNumber - 1, 1)[0];
            targetData.completedShifts = Math.max(0, (targetData.completedShifts || 1) - 1);
            targetData.totalShiftTime = Math.max(0, (targetData.totalShiftTime || 0) - removedShift.shiftDuration);
            targetData.totalBreakTime = Math.max(0, (targetData.totalBreakTime || 0) - (removedShift.breakDuration || 0));
            const shiftWave = String(removedShift.waveNumber || getWaveNumber(removedShift.startedAt));
            targetData.waveHours = targetData.waveHours || {};
            targetData.waveHours[shiftWave] = Math.max(0, (targetData.waveHours[shiftWave] || 0) - removedShift.shiftDuration);
            if (targetData.waveHours[shiftWave] === 0) {
              delete targetData.waveHours[shiftWave];
            }
            targetData.lastShiftMessage = null;
            await saveData(data);

            try {
              if (targetData.dashboardMessage) {
                const dchan = await client.channels.fetch(targetData.dashboardMessage.channelId).catch(() => null);
                if (dchan && dchan.messages) {
                  const dmsg = await dchan.messages.fetch(targetData.dashboardMessage.messageId).catch(() => null);
                  if (dmsg) {
                    const avail = getAvailableDepartments(targetMember || {});
                    const dash = buildDashboardEmbed(targetMember || { user: { username: targetUser.username } }, targetData, avail);
                    const startRow = new ActionRowBuilder().addComponents(
                      new ButtonBuilder()
                        .setCustomId('start_shift')
                        .setLabel('Start Shift')
                        .setStyle(ButtonStyle.Success)
                    );
                    await dmsg.edit({ embeds: [dash], components: [startRow] }).catch(() => null);
                  }
                }
              }
            } catch (e) {
              console.warn('Failed to update dashboard on history removal', e);
            }

            return interaction.reply({ content: `Removed shift #${shiftNumber} for <@${targetId}> and adjusted quota time.`, ephemeral: true });
          }

          if (!targetData.activeShift) {
            return interaction.reply({ content: `${targetUser.username} does not have an active shift to remove. Use /shift remove user:<user> shift:<number> to remove a completed shift.`, ephemeral: true });
          }

          const activeShift = targetData.activeShift;
          const msgRef = activeShift.message;
          targetData.activeShift = null;
          targetData.lastShiftMessage = null;
          await saveData(data);

          if (msgRef && msgRef.channelId) {
            const channel = await client.channels.fetch(msgRef.channelId).catch(() => null);
            if (channel && channel.messages) {
              const msg = await channel.messages.fetch(msgRef.messageId).catch(() => null);
              if (msg) {
                const removedEmbed = new EmbedBuilder()
                  .setTitle('Shift Removed')
                  .setDescription(`<@${targetId}>'s active shift was removed.`)
                  .setColor(0xED4245);
                await msg.edit({ embeds: [removedEmbed], components: [] }).catch(() => null);
              }
            }
          }

          try {
            if (targetData.dashboardMessage) {
              const dchan = await client.channels.fetch(targetData.dashboardMessage.channelId).catch(() => null);
              if (dchan && dchan.messages) {
                const dmsg = await dchan.messages.fetch(targetData.dashboardMessage.messageId).catch(() => null);
                if (dmsg) {
                  const avail = getAvailableDepartments(targetMember || {});
                  const dash = buildDashboardEmbed(targetMember || { user: { username: targetUser.username } }, targetData, avail);
                  const startRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                      .setCustomId('start_shift')
                      .setLabel('Start Shift')
                      .setStyle(ButtonStyle.Success)
                  );
                  await dmsg.edit({ embeds: [dash], components: [startRow] }).catch(() => null);
                }
              }
            }
          } catch (e) {
            console.warn('Failed to update dashboard on shift removal', e);
          }

          return interaction.reply({ content: `Removed active shift for <@${targetId}>.`, ephemeral: true });
        }
      }
    } else if (interaction.isButton()) {
      // support customIds with owner scoping like 'start_break:12345' or 'end_shift:12345'
      if (!interaction.customId.startsWith('start_shift') && !interaction.customId.startsWith('start_break') && !interaction.customId.startsWith('end_shift')) {
        return;
      }

      const member = await resolveMember(interaction);
      const data = await loadData();

      // handle start_shift (opens select for the clicking user)
      if (interaction.customId === 'start_shift') {
        const data = await loadData();
        const userData = await ensureUserData(data, interaction.user.id);
        console.debug('start_shift clicked', { userId: interaction.user.id, hasMessage: !!interaction.message, messageId: interaction.message?.id, channelId: interaction.channelId });

        const availableDepts = getAvailableDepartments(member);
        const selectMenu = new StringSelectMenuBuilder()
          .setCustomId('dept_select_start')
          .setMinValues(1)
          .setMaxValues(1)
          .setPlaceholder('Select shift type')
          .addOptions(getDepartmentOptions(availableDepts));

        await interaction.reply({ content: 'Select a department to start your shift.', components: [new ActionRowBuilder().addComponents(selectMenu)], ephemeral: true });
        return;
      }

      // parse owner-scoped id
      const [action, ownerId] = interaction.customId.split(':');
      const targetId = ownerId || interaction.user.id;
      const targetData = await ensureUserData(data, targetId);

      if (interaction.message && targetData.activeShift) {
        if (!targetData.activeShift.message) {
          const interactionChannel = await resolveInteractionMessageChannel(interaction);
          if (interactionChannel?.id && interaction.message?.id) {
            targetData.activeShift.message = {
              channelId: interactionChannel.id,
              messageId: interaction.message.id,
            };
            if (!targetData.dashboardMessage) {
              targetData.dashboardMessage = {
                channelId: interactionChannel.id,
                messageId: interaction.message.id,
              };
            }
            await saveData(data).catch(() => null);
            console.debug('Saved missing public message refs from button interaction', { targetId, channelId: interactionChannel.id, messageId: interaction.message.id });
          }
        }
      }

      // permission: only owner or staff override may modify
      const clickerIsOwner = interaction.user.id === targetId;
      const clickerMember = await resolveMember(interaction);
      const clickerIsStaff = hasStaffOverride(clickerMember);

      if (action === 'start_break') {
        if (!clickerIsOwner && !clickerIsStaff) {
          return interaction.reply({ content: 'Only the shift owner or staff may toggle break for this shift.', ephemeral: true });
        }

        if (!targetData.activeShift) {
          return interaction.reply({ content: 'No active shift to put on break for that user.', ephemeral: true });
        }

        const currentTime = Date.now();
          if (targetData.activeShift.onBreak) {
          const breakDuration = currentTime - targetData.activeShift.breakStartedAt;
          targetData.totalBreakTime += breakDuration;
          targetData.activeShift.onBreak = false;
          targetData.activeShift.breakStartedAt = null;
          await saveData(data);
          console.log(`Break ended for ${targetId} — updating public and dashboard messages`);

          // try direct in-place edit of the message that triggered this interaction
          console.debug('Attempting interaction.update for break end', { hasMessage: !!interaction.message, messageId: interaction.message?.id, channelId: interaction.channelId });
          try {
            if (interaction.message) {
              const embed = buildActiveShiftEmbed(targetId, targetData);
              const components = buildActiveShiftComponents(targetId, targetData);
              await editInteractionMessage(interaction, { embeds: [embed], components });
              await interaction.followUp({ content: 'Updated.', ephemeral: true }).catch(() => null);
              return;
            }
          } catch (e) {
            console.warn('Direct interaction.update failed for break end', e);
          }

          await updatePublicShiftMessageForUser(targetId, targetData).catch(() => null);

          // direct dashboard update as a fallback
          try {
            if (targetData.dashboardMessage) {
              const dchan = await client.channels.fetch(targetData.dashboardMessage.channelId).catch(() => null);
              if (dchan) {
                const dmsg = await dchan.messages.fetch(targetData.dashboardMessage.messageId).catch(() => null);
                if (dmsg) {
                  const member = await dchan.guild.members.fetch(targetId).catch(() => null);
                  const avail = getAvailableDepartments(member || {});
                  const dash = buildDashboardEmbed(member || { user: { username: 'User' } }, targetData, avail);
                  await dmsg.edit({ embeds: [dash], components: [] }).catch(() => null);
                }
              }
            }
          } catch (e) {
            console.warn('Dashboard direct update failed for break end', e);
          }

          return interaction.reply({ content: 'Updated.', ephemeral: true });
        }

        targetData.activeShift.onBreak = true;
        targetData.activeShift.breakStartedAt = currentTime;
        await saveData(data);
        console.log(`Break started for ${targetId} — updating public and dashboard messages`);

        console.debug('Attempting interaction.update for break start', { hasMessage: !!interaction.message, messageId: interaction.message?.id, channelId: interaction.channelId });
        try {
          if (interaction.message) {
            const embed = buildActiveShiftEmbed(targetId, targetData);
            const components = buildActiveShiftComponents(targetId, targetData);
            await editInteractionMessage(interaction, { embeds: [embed], components });
            await interaction.followUp({ content: 'Updated.', ephemeral: true }).catch(() => null);
            return;
          }
        } catch (e) {
          console.warn('Direct interaction.update failed for break start', e);
        }

        await updatePublicShiftMessageForUser(targetId, targetData).catch(() => null);

        // direct dashboard update as a fallback
        try {
          if (targetData.dashboardMessage) {
            const dchan = await client.channels.fetch(targetData.dashboardMessage.channelId).catch(() => null);
            if (dchan) {
              const dmsg = await dchan.messages.fetch(targetData.dashboardMessage.messageId).catch(() => null);
              if (dmsg) {
                const member = await dchan.guild.members.fetch(targetId).catch(() => null);
                const avail = getAvailableDepartments(member || {});
                const dash = buildDashboardEmbed(member || { user: { username: 'User' } }, targetData, avail);
                await dmsg.edit({ embeds: [dash], components: buildActiveShiftComponents(targetId, targetData) }).catch(() => null);
              }
            }
          }
        } catch (e) {
          console.warn('Dashboard direct update failed for break start', e);
        }

        return interaction.reply({ content: 'Updated.', ephemeral: true });
      }

      if (action === 'end_shift') {
        if (!clickerIsOwner && !clickerIsStaff) {
          return interaction.reply({ content: 'Only the shift owner or staff may end this shift.', ephemeral: true });
        }

        if (!targetData.activeShift) {
          return interaction.reply({ content: 'No active shift to end for that user.', ephemeral: true });
        }

        const currentTime = Date.now();
        if (targetData.activeShift.onBreak) {
          const breakDuration = currentTime - targetData.activeShift.breakStartedAt;
          targetData.totalBreakTime += breakDuration;
        }

        const shiftDuration = currentTime - targetData.activeShift.startedAt;
        const department = targetData.activeShift.department;
        const waveNumber = getWaveNumber(targetData.activeShift.startedAt);
        targetData.totalShiftTime += shiftDuration;
        targetData.completedShifts += 1;
        targetData.waveHours = targetData.waveHours || {};
        targetData.waveHours[String(waveNumber)] = (targetData.waveHours[String(waveNumber)] || 0) + shiftDuration;
        targetData.history.push({
          department,
          startedAt: targetData.activeShift.startedAt,
          endedAt: currentTime,
          shiftDuration,
          breakDuration: targetData.activeShift.onBreak ? currentTime - targetData.activeShift.breakStartedAt : 0,
          waveNumber,
        });
        // preserve message ref for editing after clearing activeShift
        const msgRef = targetData.activeShift.message;
        targetData.lastShiftMessage = msgRef;
        targetData.activeShift = null;
        await saveData(data);
        console.log(`Shift ended for ${targetId} — updating public and dashboard messages`);

        // try direct in-place edit of original message
        console.debug('Attempting interaction.update for shift end', { hasMessage: !!interaction.message, messageId: interaction.message?.id, channelId: interaction.channelId });
        try {
          if (interaction.message && interaction.guild) {
            // replace the message with the full dashboard and a Start Shift button
            const memberForDash = await interaction.guild.members.fetch(targetId).catch(() => null);
            const avail = getAvailableDepartments(memberForDash || {});
            const dashboardEmbed = buildDashboardEmbed(memberForDash || { user: { username: 'User' } }, targetData, avail);
            const startRow = new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId('start_shift').setLabel('Start Shift').setStyle(ButtonStyle.Success)
            );
            await editInteractionMessage(interaction, { embeds: [dashboardEmbed], components: [startRow] });
            // save dashboard reference to this message
            targetData.dashboardMessage = { channelId: interaction.channelId, messageId: interaction.message.id };
            await saveData(data).catch(() => null);
            // notify user and announce publicly
            try {
              await interaction.followUp({ content: 'Updated.', ephemeral: true }).catch(() => null);
            } catch (e) {}
            /* public announcement removed; embed conveys shift end */

            return;
          }
        } catch (e) {
          console.warn('Direct interaction.update failed for shift end', e);
        }

        await updatePublicShiftMessageForUser(targetId, targetData).catch(() => null);

        // announce ending publicly (fallback)
        // public announcement removed; rely on embed updates
        return interaction.reply({ content: 'Updated.', ephemeral: true });
      }
    } else if (interaction.isStringSelectMenu()) {
      if (interaction.customId === 'dept_select_start') {
        const selected = interaction.values[0];
        const department = DEPARTMENTS[selected];
        const data = await loadData();
        const userData = await ensureUserData(data, interaction.user.id);

        if (!department) {
          return interaction.reply({ content: 'Selected department is invalid.', ephemeral: true });
        }

        if (userData.activeShift) {
          return interaction.reply({ content: 'You already have an active shift.', ephemeral: true });
        }

        userData.activeShift = {
          department: selected,
          startedAt: Date.now(),
          onBreak: false,
          breakStartedAt: null,
        };
        await saveData(data);

        // confirm privately to the user (minimal)
        await interaction.reply({ content: 'Updated.', ephemeral: true });

        // update the existing dashboard message if available; otherwise use the current interaction message as the dashboard source
        let dashboardUpdated = false;
        let dashboardRef = userData.dashboardMessage;
        if (!dashboardRef && interaction.message?.id && interaction.channelId) {
          dashboardRef = { channelId: interaction.channelId, messageId: interaction.message.id };
          userData.dashboardMessage = dashboardRef;
        }

        try {
          if (dashboardRef) {
            const dchan = await client.channels.fetch(dashboardRef.channelId).catch(() => null);
            if (dchan && dchan.messages) {
              const dmsg = await dchan.messages.fetch(dashboardRef.messageId).catch(() => null);
              if (dmsg) {
                const member = await dchan.guild.members.fetch(interaction.user.id).catch(() => null);
                const avail = getAvailableDepartments(member || {});
                const dash = buildDashboardEmbed(member || { user: { username: 'User' } }, userData, avail);
                const shiftButtons = new ActionRowBuilder().addComponents(
                  new ButtonBuilder()
                    .setCustomId(`start_break:${interaction.user.id}`)
                    .setLabel('Start Break')
                    .setStyle(ButtonStyle.Secondary),
                  new ButtonBuilder()
                    .setCustomId(`end_shift:${interaction.user.id}`)
                    .setLabel('End Shift')
                    .setStyle(ButtonStyle.Danger)
                );
                await dmsg.edit({ embeds: [dash], components: [shiftButtons] }).catch(() => null);
                console.debug('Updated dashboard message after shift start', { userId: interaction.user.id, messageId: dashboardRef.messageId });
                dashboardUpdated = true;
                if (!userData.activeShift.message) {
                  userData.activeShift.message = { ...dashboardRef };
                }
                await saveData(data).catch(() => null);
              }
            }
          }
        } catch (e) {
          console.warn('Failed to update dashboard message after shift start', e);
        }

        if (dashboardUpdated) {
          return;
        }

        // create a public dashboard/active message that doubles as the updatable view
        try {
          const embed = buildActiveShiftEmbed(interaction.user.id, userData);
          const components = buildActiveShiftComponents(interaction.user.id, userData);
          const interactionChannel = await resolveInteractionMessageChannel(interaction);
          let targetChannel = null;
          if (interactionChannel && interactionChannel.permissionsFor && interactionChannel.permissionsFor(client.user)?.has('SendMessages')) {
            targetChannel = interactionChannel;
          } else {
            targetChannel = await findBestPublicChannel(interaction);
          }

          if (targetChannel && targetChannel.send) {
            console.debug('Posting public shift message', { userId: interaction.user.id, channelId: targetChannel.id, channelName: targetChannel.name, buttonCount: components[0]?.components?.length });
            const publicMsg = await targetChannel.send({ embeds: [embed], components });
            console.debug('Posted public shift message SUCCESS', { userId: interaction.user.id, channelId: targetChannel.id, channelName: targetChannel.name, messageId: publicMsg.id, buttonCount: publicMsg.components?.[0]?.components?.length });
            userData.activeShift.message = { channelId: targetChannel.id, messageId: publicMsg.id };
            await saveData(data);
            console.debug('Skipping updatePublicShiftMessageForUser call after initial post to preserve components');
            // DON'T call updatePublicShiftMessageForUser here - it would re-edit and potentially lose components
            // await updatePublicShiftMessageForUser(interaction.user.id, userData).catch((e) => console.warn('updatePublicShiftMessageForUser failed after post', e));
          } else {
            console.warn('No channel available to post public shift start message', { targetChannel: !!targetChannel, channelId: targetChannel?.id });
          }
        } catch (e) {
          console.warn('Could not post public shift start message:', e);
        }

        return;
      }

      if (interaction.customId.startsWith('leaderboard_select_')) {
        const waveKey = interaction.customId.replace('leaderboard_select_', '');
        const selected = interaction.values[0];
        const department = DEPARTMENTS[selected];
        const data = await loadData();
        const wave = Number(waveKey);

          const leaderboardRows = Object.entries(data.users)
          .map(([userId, userData]) => {
            // sum completed shifts in this wave for the department
            const pastMs = (userData.history || [])
              .filter(record => record.department === selected && String(record.waveNumber || getWaveNumber(record.startedAt)) === waveKey)
              .reduce((sum, record) => sum + record.shiftDuration, 0);

            // include active shift time if the user currently has an active shift in this department
            let activeMs = 0;
            if (userData.activeShift && userData.activeShift.department === selected) {
              const now = Date.now();
              const startedAt = userData.activeShift.startedAt;
              activeMs = now - startedAt;
              // if currently on break, subtract the active break duration since it shouldn't count
              if (userData.activeShift.onBreak && userData.activeShift.breakStartedAt) {
                activeMs -= (now - userData.activeShift.breakStartedAt);
              }
              // normalize to at least 0
              if (activeMs < 0) activeMs = 0;
            }

            const totalMs = pastMs + activeMs;

            return {
              member: `<@${userId}>`,
              total: formatDuration(totalMs),
              progress: `${formatDuration(totalMs)} / ${QUOTA_HOURS}h`,
              status: quotaStatusIcon(totalMs / 1000 / 3600),
            };
          })
          .sort((a, b) => {
            const aMs = Number(a.total.split('h')[0]) * 3600000 + Number(a.total.split(' ')[1].replace('m', '')) * 60000;
            const bMs = Number(b.total.split('h')[0]) * 3600000 + Number(b.total.split(' ')[1].replace('m', '')) * 60000;
            return bMs - aMs;
          });

        const leaderboardEmbed = buildLeaderboardEmbed(department, leaderboardRows, wave);
        return interaction.reply({ embeds: [leaderboardEmbed], ephemeral: false });
      }
    }
  } catch (error) {
    console.error('Interaction error:', error);
    if (interaction.replied || interaction.deferred) {
      await interaction.editReply({ content: 'An error occurred while processing this interaction.', ephemeral: true });
    } else {
      await interaction.reply({ content: 'An error occurred while processing this interaction.', ephemeral: true });
    }
  }
});

// ensure clean shutdown clears the updater
process.on('SIGINT', () => {
  stopPeriodicUpdater();
  process.exit(0);
});
process.on('SIGTERM', () => {
  stopPeriodicUpdater();
  process.exit(0);
});

client.login(token);
