// Hook SessionStart : enregistre le début de session et, si le projet a déjà un
// historique, injecte un contexte de reprise (dernières demandes, temps passé, conso).
import { readStdinJson, loadState, saveState, getSession, sessionDuration, fmtDuration, fmtDate, fmtInt, logError } from './common.mjs';

const payload = readStdinJson();
if (!payload) process.exit(0);
const projectRoot = payload.cwd || process.cwd();

try {
  const state = loadState(projectRoot);
  const previous = Object.entries(state.sessions || {})
    .filter(([id]) => id !== payload.session_id)
    .sort((a, b) => String(a[1].startedAt).localeCompare(String(b[1].startedAt)));

  // Enregistre la nouvelle session
  const sess = getSession(state, payload.session_id || 'session-inconnue');
  sess.source = payload.source || 'startup';
  saveState(projectRoot, state);

  // Injection du contexte de reprise uniquement au démarrage/reprise
  // (pas après /clear ni après un compactage, pour ne pas polluer le contexte).
  const shouldInject = ['startup', 'resume'].includes(payload.source) && previous.length > 0;
  if (shouldInject) {
    let totalMs = 0;
    let totalIn = 0;
    let totalOut = 0;
    for (const [, s] of previous) {
      totalMs += sessionDuration(s);
      for (const u of Object.values(s.models || {})) {
        totalIn += u.input + u.cacheWrite + u.cacheRead;
        totalOut += u.output;
      }
    }
    const last = previous[previous.length - 1][1];
    const lastPrompts = (last.prompts || []).slice(-5);

    const lines = [];
    lines.push('[session-tracker] REPRISE DE PROJET — contexte des sessions précédentes :');
    lines.push(`- Sessions précédentes : ${previous.length} | Temps total : ${fmtDuration(totalMs)} | Tokens : ${fmtInt(totalIn)} entrée / ${fmtInt(totalOut)} sortie`);
    lines.push(`- Dernière session : ${fmtDate(last.startedAt)} (durée ${fmtDuration(sessionDuration(last))})`);
    if (lastPrompts.length) {
      lines.push('- Dernières demandes de l\'utilisateur (les plus récentes en dernier) :');
      for (const p of lastPrompts) {
        lines.push(`  ${fmtDate(p.ts)} : ${p.text.replace(/\s+/g, ' ').slice(0, 300)}`);
      }
    }
    lines.push('- Historique complet : story_log.md | Consommation : token_conso.md (à la racine du projet).');
    lines.push('Utilise ce contexte pour reprendre le travail là où il s\'était arrêté, sans redemander ce qui a déjà été décidé.');

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: lines.join('\n'),
      },
    }));
  }
} catch (err) {
  logError(projectRoot, err);
}
process.exit(0);
