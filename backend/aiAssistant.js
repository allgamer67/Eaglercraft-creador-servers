const fetch = global.fetch;
const { Server } = require('./models');
const { createAndStartServerContainer } = require('./dockerControl');

async function callOpenAIForConfig(prompt) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY not set');

  const system = `You are an assistant that outputs a JSON configuration for an Eaglercraft server. Respond with valid JSON only. The JSON schema:
{
  "name": string,
  "ip": string (optional),
  "gamemodes": [string],
  "spawns": [{ "name": string, "coords": string }],
  "commands": [string],
  "logoUrl": string (optional)
}

Use reasonable defaults when not specified.`;

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`
    },
    body: JSON.stringify({
      model: 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt }
      ],
      max_tokens: 600,
      temperature: 0.8
    })
  });
  const json = await res.json();
  const text = json?.choices?.[0]?.message?.content || json?.choices?.[0]?.text;
  // Try to extract JSON from the text
  const firstBracket = text.indexOf('{');
  const lastBracket = text.lastIndexOf('}');
  const jsonText = firstBracket >= 0 && lastBracket > firstBracket ? text.slice(firstBracket, lastBracket + 1) : text;
  try {
    return JSON.parse(jsonText);
  } catch (e) {
    throw new Error('OpenAI returned invalid JSON: ' + e.message + '\n' + text);
  }
}

function simpleFallbackGenerator(prompt) {
  const p = prompt.toLowerCase();
  const gamemodes = [];
  if (p.includes('survival')) gamemodes.push('survival');
  if (p.includes('creative')) gamemodes.push('creative');
  if (p.includes('hardcore') || p.includes('hardcored')) gamemodes.push('hardcore');
  if (p.includes('lifesteal')) gamemodes.push('lifesteal');
  if (gamemodes.length === 0) gamemodes.push('survival');

  const spawns = [];
  if (p.includes('island')) spawns.push({ name: 'Starter Island', coords: '0,64,0' });
  if (p.includes('spawn')) spawns.push({ name: 'Main Spawn', coords: '100,64,100' });
  if (spawns.length === 0) spawns.push({ name: 'Main Spawn', coords: '0,64,0' });

  const commands = ['say Welcome to your AI-created server!'];

  return {
    name: (prompt.split('\n')[0] || 'AI Server').slice(0, 48),
    gamemodes,
    spawns,
    commands,
    ip: '',
    logoUrl: ''
  };
}

async function generateServerConfig(prompt) {
  if (process.env.OPENAI_API_KEY) {
    try { return await callOpenAIForConfig(prompt); } catch (e) { console.error('OpenAI error, falling back:', e); }
  }
  return simpleFallbackGenerator(prompt);
}

async function createServerFromAI({ prompt, ownerId, start = false, tokenUser = null }) {
  const cfg = await generateServerConfig(prompt);
  const server = new Server({
    ownerId,
    name: cfg.name || 'AI Server',
    ip: cfg.ip || '',
    port: 25565,
    logoPath: cfg.logoUrl || '',
    gamemodes: cfg.gamemodes || [],
    spawns: cfg.spawns || [],
    commands: (cfg.commands || []).slice(0, 25)
  });
  await server.save();

  if (start) {
    const result = await createAndStartServerContainer({ serverId: server._id });
    server.status = 'running';
    server.containerId = result.containerId;
    server.containerName = result.containerName;
    server.hostPort = result.hostPort;
    server.expiresAt = new Date(Date.now() + (parseInt(process.env.SERVER_MAX_LIFETIME_DAYS || '30', 10) * 24 * 60 * 60 * 1000));
    await server.save();
  }

  return server;
}

module.exports = { generateServerConfig, createServerFromAI };