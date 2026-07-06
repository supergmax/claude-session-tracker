// Hook Stop + SessionEnd : analyse le transcript de la session, met à jour l'état
// (tokens par modèle, skills/MCP/agents/plugins utilisés, durée) et régénère token_conso.md.
import { readStdinJson, loadState, saveState, getSession, parseTranscript, generateTokenConso, logError } from './common.mjs';

const payload = readStdinJson();
if (!payload) process.exit(0);
const projectRoot = payload.cwd || process.cwd();

try {
  const state = loadState(projectRoot);
  const sess = getSession(state, payload.session_id || 'session-inconnue');

  if (payload.transcript_path) {
    const t = parseTranscript(payload.transcript_path);
    // On écrase les agrégats de la session avec le recalcul complet du transcript :
    // idempotent, pas de double comptage entre deux déclenchements du hook Stop.
    sess.models = t.models;
    sess.skills = t.skills;
    sess.mcp = t.mcp;
    sess.agents = t.agents;
    sess.plugins = t.plugins;
    if (t.firstTs) sess.firstTs = t.firstTs;
    if (t.lastTs) sess.lastTs = t.lastTs;
  }
  sess.lastActivityAt = new Date().toISOString();
  if (payload.hook_event_name === 'SessionEnd' || process.argv.includes('--final')) {
    sess.endedAt = new Date().toISOString();
  }

  saveState(projectRoot, state);
  generateTokenConso(projectRoot, state);
} catch (err) {
  logError(projectRoot, err);
}
process.exit(0);
