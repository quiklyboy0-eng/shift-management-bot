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

const QUOTA_HOURS = 6;
const WAVE_LENGTH_DAYS = 14;
const QUOTA_RESET_MS = WAVE_LENGTH_DAYS * 24 * 60 * 60 * 1000;

const INITIAL_DATA = {
  users: {},
  waves: {},
  currentWaveStart: Date.now(),
};

async function loadData() {
  await fs.ensureDir(dataDir);
  if (!(await fs.pathExists(dataFile))) {
    await fs.writeJson(dataFile, INITIAL_DATA, { spaces: 2 });
  }
  return fs.readJson(dataFile);
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
  const firstStart = INITIAL_DATA.currentWaveStart;
  const elapsed = now - firstStart;
  const waveIndex = Math.floor(elapsed / QUOTA_RESET_MS);
  return firstStart + waveIndex * QUOTA_RESET_MS;
}

function getWaveNumber(now = Date.now()) {
  const firstStart = INITIAL_DATA.currentWaveStart;
  const elapsed = now - firstStart;
  return Math.floor(elapsed / QUOTA_RESET_MS) + 1;
}

function quotaStatusIcon(hoursWorked) {
  return hoursWorked >= QUOTA_HOURS ? '🟢' : '🔴';
}

function isOnShift(userData) {
  return Boolean(userData.activeShift);
}

function getAvailableDepartments(member) {
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
**Duration:** ${formatDuration(Date.now() - item.startedAt)}`,
    inline: false,
  }));

  embed.addFields(fields);
  return embed;
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
});

client.on('interactionCreate', async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      const subcommand = interaction.options.getSubcommand();
      const member = interaction.member;
      const availableDepts = getAvailableDepartments(member);
      const data = await loadData();
      const userData = await ensureUserData(data, interaction.user.id);

      if (!availableDepts.length) {
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
                .setCustomId('start_break')
                .setLabel(userData.activeShift.onBreak ? 'Resume Shift' : 'Start Break')
                .setStyle(ButtonStyle.Secondary),
              new ButtonBuilder()
                .setCustomId('end_shift')
                .setLabel('End Shift')
                .setStyle(ButtonStyle.Danger)
            );
            components.push(startShiftRow);
          }

          await interaction.reply({ embeds: [dashboardEmbed], components, ephemeral: true });
          break;
        }
        case 'online': {
          const onlineUsers = Object.entries(data.users)
            .filter(([, userData]) => userData.activeShift)
            .map(([userId, userData]) => ({
              member: `<@${userId}>`,
              department: DEPARTMENTS[userData.activeShift.department],
              startedAt: userData.activeShift.startedAt,
            }));

          const onlineEmbed = buildOnlineEmbed(onlineUsers);
          await interaction.reply({ embeds: [onlineEmbed], ephemeral: true });
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
      }
    } else if (interaction.isButton()) {
      if (!interaction.customId.startsWith('start_shift') && !interaction.customId.startsWith('start_break') && !interaction.customId.startsWith('end_shift')) {
        return;
      }

      const data = await loadData();
      const userData = await ensureUserData(data, interaction.user.id);
      const member = interaction.member;
      const availableDepts = getAvailableDepartments(member);

      if (interaction.customId === 'start_shift') {
        const selectMenu = new StringSelectMenuBuilder()
          .setCustomId('dept_select_start')
          .setMinValues(1)
          .setMaxValues(1)
          .setPlaceholder('Select shift type')
          .addOptions(getDepartmentOptions(availableDepts));

        await interaction.reply({ content: 'Select a department to start your shift.', components: [new ActionRowBuilder().addComponents(selectMenu)], ephemeral: true });
        return;
      }

      if (interaction.customId === 'start_break') {
        if (!userData.activeShift) {
          return interaction.reply({ content: 'No active shift to put on break.', ephemeral: true });
        }

        const currentTime = Date.now();
        if (userData.activeShift.onBreak) {
          const breakDuration = currentTime - userData.activeShift.breakStartedAt;
          userData.totalBreakTime += breakDuration;
          userData.activeShift.onBreak = false;
          userData.activeShift.breakStartedAt = null;
          await saveData(data);

          return interaction.reply({ content: `Break ended. Total break time recorded: ${formatDuration(userData.totalBreakTime)}.`, ephemeral: true });
        }

        userData.activeShift.onBreak = true;
        userData.activeShift.breakStartedAt = currentTime;
        await saveData(data);

        return interaction.reply({ content: 'Break started. Shift timer is paused until you resume.', ephemeral: true });
      }

      if (interaction.customId === 'end_shift') {
        if (!userData.activeShift) {
          return interaction.reply({ content: 'No active shift to end.', ephemeral: true });
        }

        const currentTime = Date.now();
        if (userData.activeShift.onBreak) {
          const breakDuration = currentTime - userData.activeShift.breakStartedAt;
          userData.totalBreakTime += breakDuration;
        }

        const shiftDuration = currentTime - userData.activeShift.startedAt;
        const department = userData.activeShift.department;
        userData.totalShiftTime += shiftDuration;
        userData.completedShifts += 1;
        userData.waveHours = userData.waveHours || {};
        userData.waveHours[String(getWaveNumber())] = (userData.waveHours[String(getWaveNumber())] || 0) + shiftDuration;
        userData.history.push({
          department,
          startedAt: userData.activeShift.startedAt,
          endedAt: currentTime,
          shiftDuration,
          breakDuration: userData.activeShift.onBreak ? currentTime - userData.activeShift.breakStartedAt : 0,
        });
        userData.activeShift = null;
        await saveData(data);

        return interaction.reply({ content: `Shift ended. Total shift time added: ${formatDuration(shiftDuration)}.`, ephemeral: true });
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

        return interaction.reply({ content: `Shift started for ${department.emoji} ${department.label}.`, ephemeral: true });
      }

      if (interaction.customId.startsWith('leaderboard_select_')) {
        const waveKey = interaction.customId.replace('leaderboard_select_', '');
        const selected = interaction.values[0];
        const department = DEPARTMENTS[selected];
        const data = await loadData();
        const wave = Number(waveKey);

        const leaderboardRows = Object.entries(data.users)
          .filter(([, userData]) => userData.history?.some(record => record.department === selected && String(getWaveNumber(record.startedAt)) === waveKey))
          .map(([userId, userData]) => {
            const totalMs = userData.history
              .filter(record => record.department === selected && String(getWaveNumber(record.startedAt)) === waveKey)
              .reduce((sum, record) => sum + record.shiftDuration, 0);

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
        return interaction.reply({ embeds: [leaderboardEmbed], ephemeral: true });
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

client.login(token);
