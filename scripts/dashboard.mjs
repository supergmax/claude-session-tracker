// Génère token_dashboard.html à la racine du projet : un tableau de bord local,
// autonome (aucune ressource externe), écrit par les hooks — zéro token consommé.
// DÉSACTIVÉ par défaut : activez-le avec { "dashboard": true } dans
// .claude/session-tracker/config.json (projet) ou ~/.claude/session-tracker/config.json.
import fs from 'node:fs';
import path from 'node:path';
import {
  computeAggregates, computeUnused, scanActiveInventory,
  loadPricing, costOfUsage, fmtUsd, fmtInt, fmtDuration, fmtDate, sessionDuration,
} from './common.mjs';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function generateDashboard(projectRoot, state) {
  const agg = computeAggregates(state);
  const inv = scanActiveInventory(projectRoot);
  const unused = computeUnused(inv, agg);
  const pricing = loadPricing(projectRoot);
  const projectName = path.basename(projectRoot);

  const totalCost = Object.entries(agg.models).reduce((a, [m, u]) => a + costOfUsage(m, u, pricing), 0);
  let ti = 0, to = 0, tcw = 0, tcr = 0;
  for (const u of Object.values(agg.models)) { ti += u.input; to += u.output; tcw += u.cacheWrite; tcr += u.cacheRead; }
  const totalTokens = ti + to + tcw + tcr;

  const modelRows = Object.entries(agg.models)
    .sort((a, b) => costOfUsage(b[0], b[1], pricing) - costOfUsage(a[0], a[1], pricing))
    .map(([model, u]) => `<tr><td><code>${esc(model)}</code></td><td>${fmtInt(u.input)}</td><td>${fmtInt(u.output)}</td><td>${fmtInt(u.cacheWrite)}</td><td>${fmtInt(u.cacheRead)}</td><td>${fmtInt(u.input + u.output + u.cacheWrite + u.cacheRead)}</td><td class="cost">${fmtUsd(costOfUsage(model, u, pricing))}</td></tr>`)
    .join('\n');

  const sessionRows = agg.sessions.map(([, s]) => {
    let si = 0, so = 0, sc = 0;
    for (const [model, u] of Object.entries(s.models || {})) {
      si += u.input + u.cacheWrite + u.cacheRead; so += u.output; sc += costOfUsage(model, u, pricing);
    }
    return `<tr><td>${esc(fmtDate(s.firstTs || s.startedAt))}</td><td>${esc(fmtDuration(sessionDuration(s)))}</td><td>${(s.prompts || []).length}</td><td>${fmtInt(si)}</td><td>${fmtInt(so)}</td><td class="cost">${fmtUsd(sc)}</td><td>${s.endedAt ? 'terminée' : '<span class="live">en cours</span>'}</td></tr>`;
  }).join('\n');

  const usedList = (obj, fmt = (k, v) => `<li><code>${esc(k)}</code> <small>${v}×</small></li>`) =>
    Object.entries(obj).sort((a, b) => b[1] - a[1]).map(([k, v]) => fmt(k, v)).join('') || '<li class="none">aucun</li>';

  const mcpList = Object.entries(agg.usedMcp).map(([srv, tools]) => {
    const detail = Object.entries(tools).sort((a, b) => b[1] - a[1]).map(([t, v]) => `${esc(t)} ${v}×`).join(', ');
    return `<li><code>${esc(srv)}</code> <small>${esc(detail)}</small></li>`;
  }).join('') || '<li class="none">aucun</li>';

  const chips = (arr) => arr.length ? arr.map((s) => `<span class="chip">${esc(s)}</span>`).join(' ') : '<em>aucun ✅</em>';

  const html = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(projectName)} — consommation Claude</title>
<style>
  :root { --bg:#fafaf9; --card:#fff; --edge:#e5e3df; --ink:#1f2422; --soft:#6b7370; --accent:#0f766e; --warn:#b45309; --warn-bg:#fbf3e4; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#121614; --card:#1a201d; --edge:#2b332f; --ink:#e5eae7; --soft:#98a29d; --accent:#2dd4bf; --warn:#f0a93c; --warn-bg:#2a2013; }
  }
  * { box-sizing:border-box; }
  body { margin:0; padding:32px 16px 56px; background:var(--bg); color:var(--ink); font:15px/1.5 system-ui, sans-serif; }
  .wrap { max-width:880px; margin:0 auto; }
  h1 { font-size:22px; margin:0 0 2px; }
  .sub { color:var(--soft); font-size:13px; margin:0 0 22px; }
  h2 { font-size:15px; margin:28px 0 10px; }
  .kpis { display:grid; grid-template-columns:repeat(auto-fit, minmax(150px, 1fr)); gap:10px; }
  .kpi { background:var(--card); border:1px solid var(--edge); border-radius:10px; padding:12px 14px; }
  .kpi b { display:block; font-size:22px; font-variant-numeric:tabular-nums; }
  .kpi span { font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:var(--soft); }
  .kpi.cost b { color:var(--accent); }
  .card { background:var(--card); border:1px solid var(--edge); border-radius:10px; padding:4px 14px; overflow-x:auto; }
  table { border-collapse:collapse; width:100%; font-size:13.5px; font-variant-numeric:tabular-nums; }
  th, td { padding:8px 10px; text-align:right; white-space:nowrap; }
  th:first-child, td:first-child { text-align:left; }
  thead th { font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:var(--soft); border-bottom:1px solid var(--edge); }
  tbody td { border-bottom:1px solid var(--edge); }
  tbody tr:last-child td { border-bottom:none; }
  td.cost { color:var(--accent); font-weight:600; }
  code { font-family:ui-monospace, Consolas, monospace; font-size:.92em; }
  .cols { display:grid; grid-template-columns:repeat(auto-fit, minmax(240px, 1fr)); gap:10px; }
  .cols .card { padding:12px 16px; }
  .cols h3 { font-size:12px; text-transform:uppercase; letter-spacing:.06em; color:var(--soft); margin:0 0 8px; }
  ul { margin:0; padding-left:18px; }
  li { margin:3px 0; }
  li small { color:var(--soft); }
  li.none { color:var(--soft); list-style:none; margin-left:-18px; }
  .waste { background:var(--warn-bg); border:1px solid var(--edge); border-radius:10px; padding:14px 16px; }
  .waste h2 { margin:0 0 6px; color:var(--warn); font-size:14px; }
  .waste p { margin:0 0 10px; font-size:13px; color:var(--soft); }
  .waste .row { margin:6px 0; font-size:13.5px; }
  .chip { display:inline-block; font-family:ui-monospace, Consolas, monospace; font-size:12px; border:1px solid var(--edge); background:var(--card); color:var(--warn); border-radius:6px; padding:1px 7px; margin:1px 0; }
  .live { color:var(--accent); font-weight:600; }
  footer { margin-top:26px; font-size:12px; color:var(--soft); }
</style>
</head>
<body>
<div class="wrap">
  <h1>📊 ${esc(projectName)}</h1>
  <p class="sub">Consommation Claude Code — mis à jour ${esc(fmtDate(new Date().toISOString()))} · généré localement par <code>session-tracker</code> (zéro token)</p>

  <div class="kpis">
    <div class="kpi"><b>${esc(fmtDuration(agg.totalMs))}</b><span>temps passé</span></div>
    <div class="kpi"><b>${agg.sessions.length}</b><span>sessions</span></div>
    <div class="kpi"><b>${fmtInt(totalTokens)}</b><span>tokens facturables</span></div>
    <div class="kpi cost"><b>${esc(fmtUsd(totalCost))}</b><span>coût équivalent API</span></div>
  </div>

  <h2>Tokens et coût par modèle</h2>
  <div class="card">
    <table>
      <thead><tr><th>Modèle</th><th>Entrée</th><th>Sortie</th><th>Cache écrit</th><th>Cache lu</th><th>Total</th><th>Coût API</th></tr></thead>
      <tbody>${modelRows || '<tr><td colspan="7">Aucune donnée pour le moment.</td></tr>'}</tbody>
    </table>
  </div>

  <h2>Sessions</h2>
  <div class="card">
    <table>
      <thead><tr><th>Début</th><th>Durée</th><th>Prompts</th><th>Entrée</th><th>Sortie</th><th>Coût API</th><th>Statut</th></tr></thead>
      <tbody>${sessionRows || '<tr><td colspan="7">Aucune session.</td></tr>'}</tbody>
    </table>
  </div>

  <h2>Utilisé pendant le projet</h2>
  <div class="cols">
    <div class="card"><h3>Skills</h3><ul>${usedList(agg.usedSkills)}</ul></div>
    <div class="card"><h3>Serveurs MCP</h3><ul>${mcpList}</ul></div>
    <div class="card"><h3>Sous-agents</h3><ul>${usedList(agg.usedAgents)}</ul></div>
    <div class="card"><h3>Plugins</h3><ul>${usedList(agg.usedPlugins)}</ul></div>
  </div>

  <h2>Gaspillage potentiel</h2>
  <div class="waste">
    <h2>⚠️ Actifs mais jamais utilisés</h2>
    <p>Chaque élément actif injecte ses définitions dans le contexte de chaque session, même sans être appelé.</p>
    <div class="row"><b>${unused.skills.length}/${inv.skills.size}</b> skills dormants : ${chips(unused.skills)}</div>
    <div class="row"><b>${unused.mcp.length}/${inv.mcpServers.size}</b> serveurs MCP jamais appelés : ${chips(unused.mcp)}</div>
    <div class="row"><b>${unused.plugins.length}/${inv.plugins.size}</b> plugins sans utilisation détectée : ${chips(unused.plugins)}</div>
  </div>

  <footer>
    Prix : ${esc(String(pricing.cacheWriteMultiplier ?? 1.25))}× entrée pour l'écriture cache, ${esc(String(pricing.cacheReadMultiplier ?? 0.1))}× pour la lecture — modifiables dans <code>~/.claude/session-tracker/pricing.json</code>.
    Dashboard opt-in : <code>{"dashboard": true}</code> dans <code>.claude/session-tracker/config.json</code> (retirez-le pour ne plus le générer).
    Détail complet : <code>token_conso.md</code> · journal : <code>story_log.md</code>.
  </footer>
</div>
</body>
</html>`;

  fs.writeFileSync(path.join(projectRoot, 'token_dashboard.html'), html, 'utf8');
}
