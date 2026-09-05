#!/usr/bin/env node
// ============================================================================
//  A complete, working bot in one file — the reference for the Applications
//  API. It shows every moving part exactly once:
//
//    * authenticating with `Authorization: Bot <token>` (the same REST API the
//      app uses; there is no bot-only surface),
//    * registering slash commands for a guild,
//    * connecting the gateway to receive interactions,
//    * answering with a rich embed and buttons,
//    * updating the message a button sits on, and replying ephemerally.
//
//  Usage:
//    1. Settings → Developer → create an application, copy the token.
//    2. Invite the bot to a server (Send Messages + Embed Links is enough).
//    3. BOT_TOKEN=... node scripts/example-bot.mjs
//
//  Then type /roll or /ping in that server.
// ============================================================================

import { io } from 'socket.io-client';

const BASE = process.env.API_BASE || 'http://localhost:3001';
const TOKEN = process.env.BOT_TOKEN;

if (!TOKEN) {
  console.error('Set BOT_TOKEN (Settings → Developer → your application).');
  process.exit(1);
}

/** Every REST call a bot makes carries the same header. */
async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bot ${TOKEN}` },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(parsed)}`);
  return parsed;
}

// The application id is the part of the token before the dot; the gateway
// tells us the bot's user id when we identify.
const APPLICATION_ID = TOKEN.split('.')[0];

const COMMANDS = [
  { name: 'ping', description: 'Check that the bot is alive' },
  {
    name: 'roll',
    description: 'Roll a die',
    options: [{ name: 'sides', description: 'How many sides (default 6)', type: 'integer', required: false }]
  }
];

/** Register the commands in every guild the bot is in. */
async function registerCommands() {
  const guilds = await api('GET', `/api/applications/${APPLICATION_ID}/guilds`).catch(() => []);
  // /guilds is owner-only, so a bot that cannot read it registers globally.
  if (!Array.isArray(guilds) || guilds.length === 0) {
    console.log('Registering commands globally.');
    return;
  }
  for (const guild of guilds) {
    await api('PUT', `/api/applications/${APPLICATION_ID}/commands`, { server_id: guild.id, commands: COMMANDS })
      .then(() => console.log(`Registered ${COMMANDS.length} commands in ${guild.name}`))
      .catch((err) => console.warn(`Could not register in ${guild.name}: ${err.message}`));
  }
}

/** Answer an interaction. `type` is 'message' | 'update' | 'ack'. */
const respond = (interaction, payload) =>
  api('POST', `/api/interactions/${interaction.id}/callback`, { token: interaction.token, ...payload });

async function onInteraction(interaction) {
  try {
    if (interaction.type === 'command' && interaction.command_name === 'ping') {
      await respond(interaction, {
        type: 'message',
        embeds: [{ title: 'Pong', description: 'The bot is listening.', color: '#57f287' }],
        components: [{ components: [
          { type: 'button', style: 'primary', label: 'Press me', custom_id: 'demo:press' },
          { type: 'button', style: 'secondary', label: 'Secret', custom_id: 'demo:secret' }
        ] }]
      });
      return;
    }

    if (interaction.type === 'command' && interaction.command_name === 'roll') {
      const sides = Math.min(1000, Math.max(2, Number(interaction.data.options?.sides) || 6));
      const rolled = 1 + Math.floor(Math.random() * sides);
      await respond(interaction, {
        type: 'message',
        embeds: [{
          title: `🎲 ${rolled}`,
          description: `d${sides}`,
          color: rolled === sides ? '#faa61a' : '#5865f2',
          footer: { text: 'Example bot' }
        }]
      });
      return;
    }

    if (interaction.custom_id === 'demo:press') {
      // Editing the message the button sits on: the classic "disable after
      // use" pattern.
      await respond(interaction, {
        type: 'update',
        content: 'Pressed — thanks!',
        components: [{ components: [
          { type: 'button', style: 'success', label: 'Pressed', custom_id: 'demo:press', disabled: true }
        ] }]
      });
      return;
    }

    if (interaction.custom_id === 'demo:secret') {
      // Ephemeral: a real message row, delivered to one person only.
      await respond(interaction, { type: 'message', ephemeral: true, content: 'Only you can see this. 🤫' });
      return;
    }

    await respond(interaction, { type: 'ack' });
  } catch (err) {
    console.error('Failed to answer interaction:', err.message);
  }
}

const socket = io(BASE, { transports: ['websocket'] });

socket.on('connect', () => socket.emit('identify', { botToken: TOKEN }));

socket.on('identified', async ({ userId, applicationId }) => {
  console.log(`Connected as bot user ${userId} (application ${applicationId}).`);
  await registerCommands();
  console.log('Waiting for interactions — try /ping in a server the bot is in.');
});

socket.on('identify_error', (err) => {
  console.error('The gateway refused the token:', err);
  process.exit(1);
});

socket.on('interaction_created', onInteraction);

process.on('SIGINT', () => { socket.close(); process.exit(0); });
