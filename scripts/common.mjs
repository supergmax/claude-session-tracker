// Bibliothèque partagée des hooks du plugin session-tracker.
// Toutes les fonctions sont "best-effort" : un hook ne doit jamais faire échouer la session.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function readStdinJson() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function dataDir(projectRoot) {
  return path.join(projectRoot, '.claude', 'session-tracker');
}

export function logError(projectRoot, err) {
  try {
    const dir = dataDir(projectRoot || process.cwd());
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, 'error.log'),
      `[${new Date().toISOString()}] ${err && err.stack ? err.stack : String(err)}\n`
    );
  } catch {
    /* silence totale : un hook ne doit jamais casser la session */
  }
}

export function loadState(projectRoot) {
  try {
    const p = path.join(dataDir(projectRoot), 'state.json');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return { sessions: {} };
  }
}

export function saveState(projectRoot, state) {
  const dir = dataDir(projectRoot);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state, null, 2), 'utf8');
}

export function getSession(state, sessionId) {
  if (!state.sessions[sessionId]) {
    state.sessions[sessionId] = {
      startedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      endedAt: null,
      prompts: [],
      models: {},
      skills: {},
      mcp: {},
      agents: {},
      plugins: {},
    };
  }
  return state.sessions[sessionId];
}

// ---------------------------------------------------------------------------
// Analyse du transcript JSONL : tokens par modèle + outils réellement utilisés
// ---------------------------------------------------------------------------
export function parseTranscript(transcriptPath) {
  const result = {
    models: {},   // { model: { input, output, cacheWrite, cacheRead, calls } }
    skills: {},   // { skillName: count }
    mcp: {},      // { server: { tool: count } }
    agents: {},   // { subagentType: count }
    plugins: {},  // { pluginName: count } (déduit des skills "plugin:skill" et serveurs MCP "plugin_*")
    firstTs: null,
    lastTs: null,
  };
  let raw;
  try {
    raw = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return result;
  }

  // Dédoublonnage : en streaming un même message assistant peut apparaître sur
  // plusieurs lignes avec le même id — on garde la dernière version (usage final).
  const assistantById = new Map();
  let anonCounter = 0;

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.timestamp) {
      if (!result.firstTs || obj.timestamp < result.firstTs) result.firstTs = obj.timestamp;
      if (!result.lastTs || obj.timestamp > result.lastTs) result.lastTs = obj.timestamp;
    }
    if (obj.type === 'assistant' && obj.message) {
      const id = obj.message.id || `anon-${anonCounter++}`;
      assistantById.set(id, obj.message);
    }
  }

  for (const msg of assistantById.values()) {
    const usage = msg.usage;
    const model = msg.model || 'inconnu';
    if (usage) {
      const m = (result.models[model] ||= { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, calls: 0 });
      m.input += usage.input_tokens || 0;
      m.output += usage.output_tokens || 0;
      m.cacheWrite += usage.cache_creation_input_tokens || 0;
      m.cacheRead += usage.cache_read_input_tokens || 0;
      m.calls += 1;
    }
    const content = Array.isArray(msg.content) ? msg.content : [];
    for (const block of content) {
      if (block.type !== 'tool_use') continue;
      recordToolUse(result, block.name, block.input);
    }
  }
  return result;
}

function recordToolUse(result, name, input) {
  if (!name) return;
  if (name === 'Skill') {
    const skill = (input && input.skill) || '(inconnu)';
    result.skills[skill] = (result.skills[skill] || 0) + 1;
    const idx = skill.indexOf(':');
    if (idx > 0) {
      const plugin = skill.slice(0, idx);
      result.plugins[plugin] = (result.plugins[plugin] || 0) + 1;
    }
    return;
  }
  if (name === 'Task' || name === 'Agent') {
    const type = (input && (input.subagent_type || input.subagentType)) || 'general-purpose';
    result.agents[type] = (result.agents[type] || 0) + 1;
    return;
  }
  const mcpMatch = name.match(/^mcp__(.+?)__(.+)$/);
  if (mcpMatch) {
    const [, server, tool] = mcpMatch;
    (result.mcp[server] ||= {});
    result.mcp[server][tool] = (result.mcp[server][tool] || 0) + 1;
    const pluginMatch = server.match(/^plugin[_-](.+?)[_-]/);
    if (pluginMatch) {
      result.plugins[pluginMatch[1]] = (result.plugins[pluginMatch[1]] || 0) + 1;
    }
  }
}

// ---------------------------------------------------------------------------
// Inventaire de ce qui est ACTIF (configuré) — pour le diff "actif mais jamais utilisé"
// ---------------------------------------------------------------------------
export function scanActiveInventory(projectRoot) {
  const inv = { skills: new Set(), mcpServers: new Set(), plugins: new Set() };
  const home = os.homedir();

  // Skills : ~/.claude/skills/* et <projet>/.claude/skills/*
  for (const dir of [path.join(home, '.claude', 'skills'), path.join(projectRoot, '.claude', 'skills')]) {
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) inv.skills.add(e.name);
      }
    } catch { /* dossier absent */ }
  }

  // Plugins activés : enabledPlugins dans les settings (user, projet, local)
  const settingsFiles = [
    path.join(home, '.claude', 'settings.json'),
    path.join(projectRoot, '.claude', 'settings.json'),
    path.join(projectRoot, '.claude', 'settings.local.json'),
  ];
  for (const f of settingsFiles) {
    try {
      const s = JSON.parse(fs.readFileSync(f, 'utf8'));
      for (const [key, enabled] of Object.entries(s.enabledPlugins || {})) {
        if (enabled) inv.plugins.add(key.split('@')[0]);
      }
    } catch { /* fichier absent ou invalide */ }
  }

  // Serveurs MCP : ~/.claude.json (global + par projet) et <projet>/.mcp.json
  try {
    const cj = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
    for (const k of Object.keys(cj.mcpServers || {})) inv.mcpServers.add(k);
    const proj = (cj.projects || {})[projectRoot];
    if (proj) for (const k of Object.keys(proj.mcpServers || {})) inv.mcpServers.add(k);
  } catch { /* absent */ }
  try {
    const mj = JSON.parse(fs.readFileSync(path.join(projectRoot, '.mcp.json'), 'utf8'));
    for (const k of Object.keys(mj.mcpServers || {})) inv.mcpServers.add(k);
  } catch { /* absent */ }

  return inv;
}

// ---------------------------------------------------------------------------
// Helpers de mise en forme
// ---------------------------------------------------------------------------
export function fmtInt(n) {
  return (n || 0).toLocaleString('fr-FR');
}

export function fmtDuration(ms) {
  if (!ms || ms < 0) return '0 min';
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  if (h === 0) return `${min} min`;
  return `${h} h ${String(min).padStart(2, '0')} min`;
}

export function fmtDate(iso) {
  if (!iso) return '?';
  try {
    return new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

export function sessionDuration(sess) {
  const start = sess.firstTs || sess.startedAt;
  // On privilégie le dernier timestamp d'activité du transcript : la fermeture
  // tardive d'une session laissée ouverte ne doit pas compter comme temps passé.
  const end = sess.lastTs || sess.endedAt || sess.lastActivityAt;
  if (!start || !end) return 0;
  return Math.max(0, new Date(end).getTime() - new Date(start).getTime());
}

// ---------------------------------------------------------------------------
// Génération de token_conso.md
// ---------------------------------------------------------------------------
export function generateTokenConso(projectRoot, state) {
  const sessions = Object.entries(state.sessions || {});
  // Agrégats globaux
  const models = {};
  const usedSkills = {};
  const usedMcp = {};
  const usedAgents = {};
  const usedPlugins = {};
  let totalMs = 0;

  for (const [, sess] of sessions) {
    totalMs += sessionDuration(sess);
    for (const [model, u] of Object.entries(sess.models || {})) {
      const m = (models[model] ||= { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, calls: 0 });
      m.input += u.input; m.output += u.output; m.cacheWrite += u.cacheWrite; m.cacheRead += u.cacheRead; m.calls += u.calls;
    }
    for (const [k, v] of Object.entries(sess.skills || {})) usedSkills[k] = (usedSkills[k] || 0) + v;
    for (const [srv, tools] of Object.entries(sess.mcp || {})) {
      (usedMcp[srv] ||= {});
      for (const [t, v] of Object.entries(tools)) usedMcp[srv][t] = (usedMcp[srv][t] || 0) + v;
    }
    for (const [k, v] of Object.entries(sess.agents || {})) usedAgents[k] = (usedAgents[k] || 0) + v;
    for (const [k, v] of Object.entries(sess.plugins || {})) usedPlugins[k] = (usedPlugins[k] || 0) + v;
  }

  const inv = scanActiveInventory(projectRoot);

  const lines = [];
  lines.push('# 📊 Consommation du projet');
  lines.push('');
  lines.push(`> Généré automatiquement par le plugin \`session-tracker\` — dernière mise à jour : ${fmtDate(new Date().toISOString())}`);
  lines.push('');
  lines.push(`- **Temps total passé sur le projet** : ${fmtDuration(totalMs)}`);
  lines.push(`- **Sessions** : ${sessions.length}`);
  lines.push('');

  // --- Tokens par modèle ---
  lines.push('## Tokens par modèle');
  lines.push('');
  if (Object.keys(models).length === 0) {
    lines.push('_Aucune donnée pour le moment._');
  } else {
    lines.push('| Modèle | Entrée | Sortie | Cache écrit | Cache lu | Total facturable | Appels |');
    lines.push('|---|---:|---:|---:|---:|---:|---:|');
    let ti = 0, to = 0, tcw = 0, tcr = 0, tc = 0;
    for (const [model, m] of Object.entries(models).sort((a, b) => (b[1].input + b[1].output) - (a[1].input + a[1].output))) {
      const total = m.input + m.output + m.cacheWrite + m.cacheRead;
      lines.push(`| \`${model}\` | ${fmtInt(m.input)} | ${fmtInt(m.output)} | ${fmtInt(m.cacheWrite)} | ${fmtInt(m.cacheRead)} | ${fmtInt(total)} | ${fmtInt(m.calls)} |`);
      ti += m.input; to += m.output; tcw += m.cacheWrite; tcr += m.cacheRead; tc += m.calls;
    }
    lines.push(`| **Total** | **${fmtInt(ti)}** | **${fmtInt(to)}** | **${fmtInt(tcw)}** | **${fmtInt(tcr)}** | **${fmtInt(ti + to + tcw + tcr)}** | **${fmtInt(tc)}** |`);
  }
  lines.push('');

  // --- Sessions ---
  lines.push('## Sessions');
  lines.push('');
  lines.push('| Début | Durée | Prompts | Tokens entrée | Tokens sortie | Statut |');
  lines.push('|---|---|---:|---:|---:|---|');
  for (const [, sess] of sessions.sort((a, b) => String(a[1].startedAt).localeCompare(String(b[1].startedAt)))) {
    let si = 0, so = 0;
    for (const u of Object.values(sess.models || {})) { si += u.input + u.cacheWrite + u.cacheRead; so += u.output; }
    lines.push(`| ${fmtDate(sess.firstTs || sess.startedAt)} | ${fmtDuration(sessionDuration(sess))} | ${(sess.prompts || []).length} | ${fmtInt(si)} | ${fmtInt(so)} | ${sess.endedAt ? 'terminée' : 'en cours'} |`);
  }
  lines.push('');

  // --- Utilisation réelle ---
  lines.push('## Skills, MCP et plugins UTILISÉS');
  lines.push('');
  lines.push('### Skills utilisés');
  lines.push('');
  const skillEntries = Object.entries(usedSkills).sort((a, b) => b[1] - a[1]);
  if (skillEntries.length === 0) lines.push('_Aucun skill invoqué._');
  else for (const [k, v] of skillEntries) lines.push(`- \`${k}\` — ${v}×`);
  lines.push('');
  lines.push('### Outils MCP utilisés');
  lines.push('');
  const mcpEntries = Object.entries(usedMcp);
  if (mcpEntries.length === 0) lines.push('_Aucun outil MCP appelé._');
  else {
    for (const [srv, tools] of mcpEntries) {
      const total = Object.values(tools).reduce((a, b) => a + b, 0);
      lines.push(`- **${srv}** (${total} appel${total > 1 ? 's' : ''}) : ${Object.entries(tools).sort((a, b) => b[1] - a[1]).map(([t, v]) => `\`${t}\` ${v}×`).join(', ')}`);
    }
  }
  lines.push('');
  lines.push('### Sous-agents utilisés');
  lines.push('');
  const agentEntries = Object.entries(usedAgents).sort((a, b) => b[1] - a[1]);
  if (agentEntries.length === 0) lines.push('_Aucun sous-agent lancé._');
  else for (const [k, v] of agentEntries) lines.push(`- \`${k}\` — ${v}×`);
  lines.push('');
  lines.push('### Plugins utilisés (déduits des skills/MCP à préfixe plugin)');
  lines.push('');
  const pluginEntries = Object.entries(usedPlugins).sort((a, b) => b[1] - a[1]);
  if (pluginEntries.length === 0) lines.push('_Aucune utilisation de plugin détectée._');
  else for (const [k, v] of pluginEntries) lines.push(`- \`${k}\` — ${v}×`);
  lines.push('');

  // --- Gaspillage ---
  lines.push('## ⚠️ Actifs mais JAMAIS utilisés (gaspillage potentiel de tokens)');
  lines.push('');
  lines.push('> Chaque skill, serveur MCP ou plugin actif injecte sa description / ses définitions d\'outils');
  lines.push('> dans le contexte de CHAQUE session, même s\'il n\'est jamais appelé.');
  lines.push('');
  const usedSkillBases = new Set(Object.keys(usedSkills).map((s) => s.includes(':') ? s.split(':')[1] : s));
  const unusedSkills = [...inv.skills].filter((s) => !usedSkillBases.has(s)).sort();
  const unusedMcp = [...inv.mcpServers].filter((s) => !usedMcp[s]).sort();
  const usedPluginSet = new Set(Object.keys(usedPlugins).map((p) => p.toLowerCase()));
  const unusedPlugins = [...inv.plugins].filter((p) => !usedPluginSet.has(p.toLowerCase()) && p !== 'session-tracker').sort();

  lines.push(`- **Skills actifs jamais utilisés** (${unusedSkills.length}/${inv.skills.size} détectés) : ${unusedSkills.length ? unusedSkills.map((s) => `\`${s}\``).join(', ') : '_aucun_ ✅'}`);
  lines.push(`- **Serveurs MCP configurés jamais appelés** (${unusedMcp.length}/${inv.mcpServers.size} détectés) : ${unusedMcp.length ? unusedMcp.map((s) => `\`${s}\``).join(', ') : '_aucun_ ✅'}`);
  lines.push(`- **Plugins activés sans utilisation détectée** (${unusedPlugins.length}/${inv.plugins.size} détectés) : ${unusedPlugins.length ? unusedPlugins.map((s) => `\`${s}\``).join(', ') : '_aucun_ ✅'}`);
  lines.push('');
  lines.push('_Note : l\'utilisation des plugins est détectée via leurs skills (`plugin:skill`) et serveurs MCP (`mcp__plugin_*`). Un plugin qui n\'agit que par hooks peut apparaître à tort comme non utilisé._');
  lines.push('');

  fs.writeFileSync(path.join(projectRoot, 'token_conso.md'), lines.join('\n'), 'utf8');
}
