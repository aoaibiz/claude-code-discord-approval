import {
    Client, GatewayIntentBits,
    ActionRowBuilder, ButtonBuilder, ButtonStyle,
    EmbedBuilder
} from 'discord.js';
import express from 'express';
import http from 'http';
import fs from 'fs';
import path from 'path';
import 'dotenv/config';

// --- Configuration ---
const APPROVAL_DIR = process.env.APPROVAL_DIR || '/tmp/claude_approvals';
const API_PORT = parseInt(process.env.APPROVAL_API_PORT || '8766', 10);
const API_BIND = process.env.APPROVAL_API_BIND || '127.0.0.1';
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const ALLOWED_USER_ID = process.env.DISCORD_ALLOWED_USER_ID;
const REMOTE_HOST = process.env.REMOTE_APPROVAL_HOST;
const REMOTE_PORT = parseInt(process.env.REMOTE_APPROVAL_PORT || '8765', 10);
const REMOTE_SECRET = process.env.REMOTE_APPROVAL_SECRET || '';
const LOG_FILE = process.env.APPROVAL_LOG_FILE || path.join(APPROVAL_DIR, '_approval_log.jsonl');

// --- Tool Name Mapping (human-readable labels) ---
const TOOL_LABELS = {
    'Bash': '🖥️ ターミナルコマンド',
    'Write': '📝 ファイル作成',
    'Edit': '✏️ ファイル編集',
    'Read': '📖 ファイル読取',
    'Glob': '🔍 ファイル検索',
    'Grep': '🔎 テキスト検索',
    'Agent': '🤖 エージェント起動',
    'WebFetch': '🌐 URL取得',
    'WebSearch': '🔍 Web検索',
    'NotebookEdit': '📓 ノートブック編集',
};

function getToolLabel(toolName) {
    if (TOOL_LABELS[toolName]) return TOOL_LABELS[toolName];
    // MCP tools: extract readable name
    if (toolName.startsWith('mcp__')) {
        const parts = toolName.split('__');
        return `🔌 ${parts[parts.length - 1]}`;
    }
    return `🔧 ${toolName}`;
}

// --- Sanitize Discord content ---
function sanitizeForDiscord(text) {
    if (!text) return '(詳細なし)';
    return text
        .replace(/@everyone/g, '@\u200Beveryone')
        .replace(/@here/g, '@\u200Bhere')
        .replace(/<@[!&]?\d+>/g, '[mention]')
        .substring(0, 500);
}

// --- Approval Logger ---
function logApproval(entry) {
    try {
        const dir = path.dirname(LOG_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const line = JSON.stringify({ ...entry, timestamp: new Date().toISOString() }) + '\n';
        fs.appendFileSync(LOG_FILE, line, { mode: 0o600 });
    } catch (e) {
        console.error('[Log] Failed to write:', e.message);
    }
}

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
        return interaction.editReply({ content: '⛔ 権限がありません — 許可されたユーザーではありません。' });
    }

    const parts = interaction.customId.split(':');
    const action = parts[0];
    const requestId = parts.slice(1).join(':');

    if (!requestId) {
        return interaction.editReply({ content: 'Invalid request ID.' });
    }

    let decision, label, color;
    if (action === 'approval_allow') {
        decision = 'allow';
        label = '✅ 許可（1回）';
        color = 0x57F287;
    } else if (action === 'approval_always') {
        decision = 'always';
        label = '🔓 常に許可';
        color = 0x5865F2;
    } else if (action === 'approval_deny') {
        decision = 'deny';
        label = '❌ 拒否';
        color = 0xED4245;
    } else {
        return interaction.editReply({ content: 'Unknown action.' });
    }

    const approvalData = JSON.stringify({
        decision,
        timestamp: Date.now(),
        userId: interaction.user.id
    });

    // Write to local approval directory with restrictive permissions
    if (!fs.existsSync(APPROVAL_DIR)) fs.mkdirSync(APPROVAL_DIR, { recursive: true, mode: 0o700 });
    const filepath = path.join(APPROVAL_DIR, `${requestId}.json`);
    fs.writeFileSync(filepath, approvalData, { mode: 0o600 });

    // Forward to remote machine (only if secret is configured)
    if (REMOTE_HOST) {
        if (!REMOTE_SECRET) {
            console.warn('[Approval] REMOTE_HOST set but REMOTE_APPROVAL_SECRET is empty — skipping remote forwarding for security.');
        } else {
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
    }

    // Log the decision
    logApproval({
        requestId,
        decision,
        user: interaction.user.tag,
    });

    console.log(`[Approval] ${label} | id=${requestId} | user=${interaction.user.tag}`);

    // Update original message: replace embed color and remove buttons
    try {
        const originalEmbed = interaction.message.embeds[0];
        if (originalEmbed) {
            const updatedEmbed = EmbedBuilder.from(originalEmbed)
                .setColor(color)
                .setFooter({ text: `${label} by ${interaction.user.tag}` });
            await interaction.message.edit({
                embeds: [updatedEmbed],
                components: []
            });
        } else {
            await interaction.message.edit({
                content: interaction.message.content + `\n\n**${label}**`,
                components: []
            });
        }
    } catch (e) { /* ignore edit failures */ }

    await interaction.editReply({ content: `${label} — 適用しました。` });
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

        const summary = sanitizeForDiscord(tool_input_summary);
        const sourceLabel = source || 'unknown';
        const toolLabel = getToolLabel(tool_name);

        // Build embed for better UI
        const embed = new EmbedBuilder()
            .setColor(0xFFA500)  // Orange = pending
            .setTitle('🔐 許可リクエスト')
            .addFields(
                { name: 'ツール', value: `${toolLabel}\n\`${tool_name}\``, inline: true },
                { name: '送信元', value: sourceLabel, inline: true },
                { name: '詳細', value: `\`\`\`\n${summary}\n\`\`\`` },
            )
            .setFooter({ text: `ID: ${request_id} · 120秒後に自動拒否` })
            .setTimestamp();

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`approval_allow:${request_id}`)
                .setLabel('1回許可')
                .setEmoji('✅')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId(`approval_always:${request_id}`)
                .setLabel('常に許可')
                .setEmoji('🔓')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId(`approval_deny:${request_id}`)
                .setLabel('拒否')
                .setEmoji('❌')
                .setStyle(ButtonStyle.Danger)
        );

        await channel.send({
            embeds: [embed],
            components: [row]
        });

        res.json({ status: 'ok' });
    } catch (err) {
        console.error('[API] Error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Error handler for Express
app.use((err, req, res, next) => {
    console.error('[API] Unhandled error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
});

app.listen(API_PORT, API_BIND, () => {
    console.log(`🔐 Approval API running on ${API_BIND}:${API_PORT}`);
});

// --- Start ---
client.once('ready', () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
    console.log(`📢 Approval channel: ${CHANNEL_ID}`);
});

client.on('error', (err) => {
    console.error('[Discord] Client error:', err.message);
});

client.login(process.env.DISCORD_BOT_TOKEN);
