// Hook UserPromptSubmit : journalise chaque message utilisateur dans story_log.md
// et le mémorise dans l'état pour la fonction de reprise.
import fs from 'node:fs';
import path from 'node:path';
import { readStdinJson, loadState, saveState, getSession, logError, fmtDate } from './common.mjs';

const payload = readStdinJson();
if (!payload) process.exit(0);
const projectRoot = payload.cwd || process.cwd();

try {
  const prompt = (payload.prompt ?? payload.prompt_text ?? '').toString();
  if (!prompt.trim()) process.exit(0);

  const state = loadState(projectRoot);
  const sess = getSession(state, payload.session_id || 'session-inconnue');
  const now = new Date();
  sess.lastActivityAt = now.toISOString();
  sess.prompts.push({ ts: now.toISOString(), text: prompt.slice(0, 2000) });

  const storyPath = path.join(projectRoot, 'story_log.md');
  let chunk = '';
  if (!fs.existsSync(storyPath)) {
    chunk += '# 📖 Journal des messages utilisateur\n\n> Généré automatiquement par le plugin `session-tracker`. Chaque message envoyé par l\'utilisateur est consigné ici.\n';
  }
  if (!sess.storyHeaderWritten) {
    chunk += `\n## Session du ${fmtDate(sess.startedAt)} — \`${(payload.session_id || '').slice(0, 8)}\`\n\n`;
    sess.storyHeaderWritten = true;
  }
  const time = now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  if (prompt.includes('\n')) {
    chunk += `- **${time}** —\n${prompt.split('\n').map((l) => `  > ${l}`).join('\n')}\n`;
  } else {
    chunk += `- **${time}** — ${prompt}\n`;
  }
  fs.appendFileSync(storyPath, chunk, 'utf8');

  saveState(projectRoot, state);
} catch (err) {
  logError(projectRoot, err);
}
process.exit(0);
