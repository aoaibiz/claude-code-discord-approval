import {
    Client, GatewayIntentBits,
    ActionRowBuilder, ButtonBuilder, ButtonStyle
} from 'discord.js';
import express from 'express';
import http from 'http';
import fs from 'fs';
import path from 'path';
import 'dotenv/config';

// --- Configuration ---
const APPROVAL_DIR = process.env.APPROVAL_DIR || '/tmp/claude_approvals';
const API_PORT = parseInt(process.env.APPROVAL_API_PORT || '8766', 10);
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const ALLOWED_USER_ID = process.env.DISCORD_ALLOWED_USER_ID;
const REMOTE_HOST = process.env.REMOTE_APPROVAL_HOST;
const REMOTE_PORT = parseInt(process.env.REMOTE_APPROVAL_PORT || '8765', 10);
const REMOTE_SECRET = process.env.REMOTE_APPROVAL_SECRET || '';

// --- Discord Client ---
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

// --- Button Interaction Handler ---
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;
    if (!interaction.customId.startsWith('approval_')) return;

    await interaction.deferReply({ ephemeral: true });

    if (interaction.user.id !== ALLOWED_USER_ID) {
        return interaction.editReply({ content: 'Permission denied.' });
    }

    const parts = interaction.customId.split(':');
    const action = parts[0];
    const requestId = parts.slice(1).join(':');

    if (!requestId) {
        return interaction.editReply({ content: 'Invalid request ID.' });
    }

    let decision, label;
    if (action === 'approval_allow') {
        decision = 'allow';
        label = '✅ Allowed (once)';
    } else if (action === 'approval_always') {
        decision = 'always';
        label = '🔓 Always allowed';
    } else if (action === 'approval_deny') {
        decision = 'deny';
        label = '❌ Denied';
    } else {
        return interaction.editReply({ content: 'Unknown action.' });
    }

    const approvalData = JSON.stringify({
        decision,
        timestamp: Date.now(),
        userId: interaction.user.id
    });

    // Write to local approval directory
    if (!fs.existsSync(APPROVAL_DIR)) fs.mkdirSync(APPROVAL_DIR, { recursive: true });
    fs.writeFileSync(path.join(APPROVAL_DIR, `${requestId}.json`), approvalData);

    // Forward to remote machine (if configured)
    if (REMOTE_HOST) {
        const postData = JSON.stringify({ request_id: requestId, decision });
        const url = `http://${REMOTE_HOST}:${REMOTE_PORT}/approve`;
        try {
            const req = http.request(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Approval-Secret': REMOTE_SECRET,
                    'Content-Length': Buffer.byteLength(postData)
                },
                timeout: 5000
            }, (res) => {
                console.log(`[Approval] Remote response: ${res.statusCode} for ${requestId}`);
            });
            req.on('error', (err) => console.log(`[Approval] Remote failed: ${err.message}`));
            req.write(postData);
            req.end();
        } catch (err) {
            console.log(`[Approval] Remote error: ${err.message}`);
        }
    }

    console.log(`[Approval] ${label} | id=${requestId} | user=${interaction.user.tag}`);

    // Update original message: remove buttons, show decision
    try {
        await interaction.message.edit({
            content: interaction.message.content + `\n\n**Decision: ${label}**`,
            components: []
        });
    } catch (e) { /* ignore */ }

    await interaction.editReply({ content: `${label} — applied.` });
});

// --- Approval API Server ---
const app = express();
app.use(express.json());

app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'claude-code-discord-approval' });
});

app.post('/send-approval-button', async (req, res) => {
    try {
        const { request_id, tool_name, tool_input_summary, source } = req.body;
        if (!request_id || !tool_name) {
            return res.status(400).json({ error: 'request_id and tool_name required' });
        }

        const channel = client.channels.cache.get(CHANNEL_ID);
        if (!channel) {
            return res.status(500).json({ error: 'Discord channel not found' });
        }

        const summary = (tool_input_summary || '(no details)').substring(0, 500);
        const sourceLabel = source || 'unknown';

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`approval_allow:${request_id}`)
                .setLabel('✅ Allow Once')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId(`approval_always:${request_id}`)
                .setLabel('🔓 Always Allow')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId(`approval_deny:${request_id}`)
                .setLabel('❌ Deny')
                .setStyle(ButtonStyle.Danger)
        );

        await channel.send({
            content: `🔐 **Claude Code Permission Request** (${sourceLabel})\n\n` +
                     `**Tool:** \`${tool_name}\`\n` +
                     `**Details:** ${summary}\n` +
                     `**ID:** \`${request_id}\`\n\n` +
                     `Tap a button within 120 seconds.`,
            components: [row]
        });

        res.json({ status: 'ok' });
    } catch (err) {
        console.error('[API] Error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.listen(API_PORT, '0.0.0.0', () => {
    console.log(`🔐 Approval API running on port ${API_PORT}`);
});

// --- Start ---
client.once('ready', () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
    console.log(`📢 Approval channel: ${CHANNEL_ID}`);
});

client.login(process.env.DISCORD_BOT_TOKEN);
