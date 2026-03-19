export function getDashboardHtml(port: number): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Archiver Dashboard</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #0f172a;
      --surface: #1e293b;
      --surface2: #263347;
      --border: #334155;
      --text: #e2e8f0;
      --muted: #64748b;
      --accent: #3b82f6;
      --green: #22c55e;
      --yellow: #eab308;
      --red: #ef4444;
      --purple: #a855f7;
    }
    html, body { height: 100%; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
      font-size: 13px;
      background: var(--bg);
      color: var(--text);
      display: flex;
      flex-direction: column;
    }

    /* ---- Top bar ---- */
    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 20px;
      height: 52px;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
    }
    .topbar-brand { font-size: 14px; font-weight: 700; color: var(--text); }
    .topbar-brand span { color: var(--accent); }
    .topbar-right { display: flex; align-items: center; gap: 12px; }
    .status-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green); }
    .status-label { font-size: 12px; color: var(--muted); }
    .btn-run {
      background: var(--accent);
      color: #fff;
      border: none;
      border-radius: 6px;
      padding: 7px 14px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: opacity 0.15s;
    }
    .btn-run:hover { opacity: 0.85; }
    .btn-run:disabled { opacity: 0.5; cursor: not-allowed; }

    /* ---- Layout ---- */
    .layout {
      display: flex;
      flex: 1;
      overflow: hidden;
    }

    /* ---- Sidebar ---- */
    .sidebar {
      width: 180px;
      flex-shrink: 0;
      background: var(--surface);
      border-right: 1px solid var(--border);
      padding: 16px 0;
      overflow-y: auto;
    }
    .nav-group-label {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--muted);
      padding: 0 16px 6px;
    }
    .nav-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 16px;
      cursor: pointer;
      color: var(--muted);
      font-size: 13px;
      border-left: 3px solid transparent;
      transition: background 0.12s;
    }
    .nav-item:hover { background: var(--surface2); color: var(--text); }
    .nav-item.active { color: var(--text); border-left-color: var(--accent); background: var(--surface2); }
    .nav-badge {
      background: var(--surface2);
      color: var(--muted);
      font-size: 10px;
      font-weight: 700;
      border-radius: 10px;
      padding: 1px 6px;
    }
    .nav-item.active .nav-badge { background: var(--accent); color: #fff; }

    /* ---- Main ---- */
    .main {
      flex: 1;
      overflow-y: auto;
      padding: 24px;
    }

    /* ---- Section panels ---- */
    .panel { display: none; }
    .panel.active { display: block; }
    .panel-title {
      font-size: 18px;
      font-weight: 700;
      color: var(--text);
      margin-bottom: 20px;
    }

    /* ---- Stat cards ---- */
    .stat-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
      gap: 12px;
      margin-bottom: 24px;
    }
    .stat-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 16px;
    }
    .stat-val { font-size: 32px; font-weight: 800; line-height: 1; color: var(--text); }
    .stat-val.accent { color: var(--accent); }
    .stat-val.green  { color: var(--green); }
    .stat-val.yellow { color: var(--yellow); }
    .stat-val.red    { color: var(--red); }
    .stat-label { font-size: 11px; color: var(--muted); margin-top: 5px; text-transform: uppercase; letter-spacing: 0.04em; font-weight: 500; }

    /* ---- Tables ---- */
    .table-wrap { overflow-x: auto; border-radius: 8px; border: 1px solid var(--border); }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    thead th {
      background: var(--surface);
      color: var(--muted);
      font-weight: 600;
      text-align: left;
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
      white-space: nowrap;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    tbody td {
      padding: 9px 12px;
      border-bottom: 1px solid var(--border);
      color: var(--text);
      vertical-align: top;
    }
    tbody tr:last-child td { border-bottom: none; }
    tbody tr:hover td { background: var(--surface2); }

    /* ---- Activity feed ---- */
    .feed { display: flex; flex-direction: column; gap: 2px; }
    .feed-item {
      display: flex;
      align-items: flex-start;
      gap: 12px;
      padding: 10px 14px;
      background: var(--surface);
      border-radius: 6px;
      border: 1px solid var(--border);
    }
    .feed-dot {
      width: 8px; height: 8px;
      border-radius: 50%;
      margin-top: 4px;
      flex-shrink: 0;
    }
    .feed-dot.processed { background: var(--green); }
    .feed-dot.duplicate { background: var(--yellow); }
    .feed-dot.manual_review_routed { background: var(--red); }
    .feed-dot.context_updated { background: var(--accent); }
    .feed-dot.project_resolved { background: var(--purple); }
    .feed-dot.default { background: var(--muted); }
    .feed-body { flex: 1; }
    .feed-title { font-size: 12px; font-weight: 600; color: var(--text); }
    .feed-meta { font-size: 11px; color: var(--muted); margin-top: 2px; }

    /* ---- Badges ---- */
    .badge {
      display: inline-block;
      padding: 2px 7px;
      border-radius: 4px;
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      white-space: nowrap;
    }
    .badge-image   { background: #14532d55; color: #86efac; }
    .badge-video   { background: #1e3a5f55; color: #93c5fd; }
    .badge-pdf     { background: #3b0764aa; color: #d8b4fe; }
    .badge-unknown { background: #1e293b; color: var(--muted); }
    .badge-ai      { background: #1e3a5f55; color: #60a5fa; }
    .badge-fallback{ background: #78350f55; color: #fcd34d; }
    .badge-exact   { background: #7f1d1d55; color: #fca5a5; }
    .badge-perceptual { background: #78350f55; color: #fcd34d; }
    .badge-success { background: #14532d55; color: #86efac; }
    .badge-failed  { background: #7f1d1d55; color: #fca5a5; }

    /* ---- Confidence bar ---- */
    .conf { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
    .conf-pct { font-size: 11px; font-weight: 600; min-width: 28px; }
    .conf-bg { width: 40px; height: 3px; background: var(--border); border-radius: 2px; }
    .conf-fill { height: 3px; border-radius: 2px; background: var(--accent); }

    /* ---- Path ---- */
    .path { font-family: monospace; font-size: 11px; color: var(--muted); word-break: break-all; }

    /* ---- Empty ---- */
    .empty { color: var(--muted); font-style: italic; padding: 32px 0; text-align: center; }

    /* ---- Loading ---- */
    .loading { color: var(--muted); padding: 32px 0; text-align: center; }

    /* ---- Toast ---- */
    #toast {
      position: fixed; bottom: 24px; right: 24px;
      background: var(--surface); border: 1px solid var(--border);
      color: var(--text); padding: 12px 18px;
      border-radius: 8px; font-size: 13px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.4);
      opacity: 0; transition: opacity 0.2s;
      pointer-events: none; z-index: 100;
    }
    #toast.show { opacity: 1; }

    /* ---- Refresh button ---- */
    .refresh-bar { display: flex; justify-content: flex-end; margin-bottom: 14px; }
    .btn-refresh {
      background: transparent; border: 1px solid var(--border);
      color: var(--muted); border-radius: 6px;
      padding: 5px 12px; font-size: 12px; cursor: pointer;
    }
    .btn-refresh:hover { border-color: var(--accent); color: var(--accent); }
  </style>
</head>
<body>

<div class="topbar">
  <div class="topbar-brand">iMessage <span>Archiver</span></div>
  <div class="topbar-right">
    <div class="status-dot" id="statusDot"></div>
    <span class="status-label" id="statusLabel">Connecting...</span>
    <button class="btn-run" id="btnRun" onclick="runReport()">Run Report Now</button>
  </div>
</div>

<div class="layout">
  <nav class="sidebar">
    <div class="nav-group-label" style="margin-bottom:4px">Monitoring</div>
    <div class="nav-item active" data-panel="overview" onclick="switchPanel('overview')">
      Overview
    </div>
    <div class="nav-item" data-panel="activity" onclick="switchPanel('activity')">
      Activity <span class="nav-badge" id="badge-activity">—</span>
    </div>
    <div class="nav-item" data-panel="files" onclick="switchPanel('files')">
      Files <span class="nav-badge" id="badge-files">—</span>
    </div>
    <div class="nav-item" data-panel="messages" onclick="switchPanel('messages')">
      Messages <span class="nav-badge" id="badge-messages">—</span>
    </div>
    <div class="nav-item" data-panel="duplicates" onclick="switchPanel('duplicates')">
      Duplicates <span class="nav-badge" id="badge-duplicates">—</span>
    </div>
    <div class="nav-item" data-panel="manual-review" onclick="switchPanel('manual-review')">
      Manual Review <span class="nav-badge" id="badge-manual">—</span>
    </div>
    <div class="nav-item" data-panel="reports" onclick="switchPanel('reports')">
      Reports <span class="nav-badge" id="badge-reports">—</span>
    </div>
  </nav>

  <main class="main">

    <!-- Overview -->
    <div class="panel active" id="panel-overview">
      <div class="panel-title">Overview</div>
      <div class="stat-grid" id="overview-stats">
        <div class="loading">Loading...</div>
      </div>
      <div id="overview-projects"></div>
    </div>

    <!-- Activity -->
    <div class="panel" id="panel-activity">
      <div class="panel-title">Activity Feed</div>
      <div class="refresh-bar">
        <button class="btn-refresh" onclick="loadSection('activity')">Refresh</button>
      </div>
      <div class="feed" id="activity-feed"><div class="loading">Loading...</div></div>
    </div>

    <!-- Files -->
    <div class="panel" id="panel-files">
      <div class="panel-title">Processed Files</div>
      <div class="refresh-bar">
        <button class="btn-refresh" onclick="loadSection('files')">Refresh</button>
      </div>
      <div class="table-wrap"><table id="files-table">
        <thead><tr>
          <th>Date</th><th>Sender</th><th>Project</th>
          <th>Filename</th><th>Category</th><th>Folder / Phase</th>
          <th>Confidence</th><th>Source</th>
        </tr></thead>
        <tbody id="files-body"><tr><td colspan="8" class="loading">Loading...</td></tr></tbody>
      </table></div>
    </div>

    <!-- Messages -->
    <div class="panel" id="panel-messages">
      <div class="panel-title">Text Messages</div>
      <div class="refresh-bar">
        <button class="btn-refresh" onclick="loadSection('messages')">Refresh</button>
      </div>
      <div class="table-wrap"><table id="messages-table">
        <thead><tr>
          <th>Date</th><th>Sender</th><th>Direction</th>
          <th>Project</th><th>Source</th><th>Text</th>
        </tr></thead>
        <tbody id="messages-body"><tr><td colspan="6" class="loading">Loading...</td></tr></tbody>
      </table></div>
    </div>

    <!-- Duplicates -->
    <div class="panel" id="panel-duplicates">
      <div class="panel-title">Duplicates</div>
      <div class="refresh-bar">
        <button class="btn-refresh" onclick="loadSection('duplicates')">Refresh</button>
      </div>
      <div class="table-wrap"><table id="duplicates-table">
        <thead><tr>
          <th>Date</th><th>Sender</th><th>Project</th>
          <th>Filename</th><th>Type</th><th>Matched File</th><th>Stored At</th>
        </tr></thead>
        <tbody id="duplicates-body"><tr><td colspan="7" class="loading">Loading...</td></tr></tbody>
      </table></div>
    </div>

    <!-- Manual Review -->
    <div class="panel" id="panel-manual-review">
      <div class="panel-title">Manual Review Queue</div>
      <div class="refresh-bar">
        <button class="btn-refresh" onclick="loadSection('manual-review')">Refresh</button>
      </div>
      <div class="table-wrap"><table id="manual-table">
        <thead><tr>
           <th>Saved Filename</th><th>Category</th><th>Confidence</th><th>Stored At</th>
        </tr></thead>
        <tbody id="manual-body"><tr><td colspan="7" class="loading">Loading...</td></tr></tbody>
      </table></div>
    </div>

    <!-- Reports -->
    <div class="panel" id="panel-reports">
      <div class="panel-title">Reports</div>
      <div class="refresh-bar">
        <button class="btn-refresh" onclick="loadSection('reports')">Refresh</button>
      </div>
      <div class="table-wrap"><table id="reports-table">
        <thead><tr>
          <th>Sent At</th><th>Period Start</th><th>Recipient</th>
          <th>Total</th><th>Unique</th><th>Dupes</th><th>Manual</th><th>Status</th>
        </tr></thead>
        <tbody id="reports-body"><tr><td colspan="8" class="loading">Loading...</td></tr></tbody>
      </table></div>
    </div>

  </main>
</div>

<div id="toast"></div>

<script>
  const API = 'http://localhost:${port}/api/dashboard';

  // ---- Navigation ----
  function switchPanel(name) {
    document.querySelectorAll('.nav-item').forEach(el => {
      el.classList.toggle('active', el.dataset.panel === name);
    });
    document.querySelectorAll('.panel').forEach(el => {
      el.classList.toggle('active', el.id === 'panel-' + name);
    });
    loadSection(name);
  }

  // ---- Toast ----
  function toast(msg, duration = 3000) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), duration);
  }

  // ---- Helpers ----
  function esc(s) {
    if (!s && s !== 0) return '<span style="color:var(--muted)">—</span>';
    return String(s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function fmtDate(iso) {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleString('en-US',{
        month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'
      });
    } catch { return iso; }
  }
  function conf(n) {
    const pct = Math.round((n || 0) * 100);
    const w = Math.max(1, Math.round(pct * 40 / 100));
    return \`<span class="conf"><span class="conf-pct">\${pct}%</span><span class="conf-bg"><span class="conf-fill" style="width:\${w}px"></span></span></span>\`;
  }
  function badge(cls, text) {
    return \`<span class="badge badge-\${cls}">\${esc(text)}</span>\`;
  }

  // ---- Load overview ----
  async function loadOverview() {
    try {
      const r = await fetch(API + '/overview');
      const d = await r.json();
      document.getElementById('badge-activity').textContent = d.recentActivityCount ?? 0;
      document.getElementById('badge-files').textContent = d.totalFiles ?? 0;
      document.getElementById('badge-duplicates').textContent = d.totalDuplicates ?? 0;
      document.getElementById('badge-manual').textContent = d.totalManualReview ?? 0;
      document.getElementById('badge-reports').textContent = d.totalReports ?? 0;
      document.getElementById('badge-messages').textContent = d.totalMessages ?? 0;

      const stats = document.getElementById('overview-stats');
      stats.innerHTML = \`
        <div class="stat-card"><div class="stat-val accent">\${d.totalFiles ?? 0}</div><div class="stat-label">Total Files</div></div>
        <div class="stat-card"><div class="stat-val green">\${d.uniqueFiles ?? 0}</div><div class="stat-label">Unique Files</div></div>
        <div class="stat-card"><div class="stat-val">\${d.affectedProjects ?? 0}</div><div class="stat-label">Projects</div></div>
        <div class="stat-card"><div class="stat-val yellow">\${d.totalDuplicates ?? 0}</div><div class="stat-label">Duplicates</div></div>
        <div class="stat-card"><div class="stat-val red">\${d.totalManualReview ?? 0}</div><div class="stat-label">Manual Review</div></div>
        <div class="stat-card"><div class="stat-val">\${d.totalMessages ?? 0}</div><div class="stat-label">Messages</div></div>
        <div class="stat-card"><div class="stat-val">\${d.totalReports ?? 0}</div><div class="stat-label">Reports Sent</div></div>
      \`;

      if (d.byProject && d.byProject.length > 0) {
        const rows = d.byProject.map(p => \`
          <tr>
            <td><strong>\${esc(p.projectName)}</strong></td>
            <td style="text-align:center">\${p.total}</td>
            <td style="text-align:center">\${p.total - p.duplicates}</td>
            <td style="text-align:center">\${p.duplicates > 0 ? \`<span style="color:var(--yellow)">\${p.duplicates}</span>\` : 0}</td>
            <td style="text-align:center">\${p.manualReview > 0 ? \`<span style="color:var(--red)">\${p.manualReview}</span>\` : 0}</td>
          </tr>\`).join('');
        document.getElementById('overview-projects').innerHTML = \`
          <div style="font-size:13px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px">By Project</div>
          <div class="table-wrap"><table>
            <thead><tr><th>Project</th><th style="text-align:center">Total</th><th style="text-align:center">Unique</th><th style="text-align:center">Dupes</th><th style="text-align:center">Manual</th></tr></thead>
            <tbody>\${rows}</tbody>
          </table></div>\`;
      } else {
        document.getElementById('overview-projects').innerHTML = '';
      }

      document.getElementById('statusDot').style.background = 'var(--green)';
      document.getElementById('statusLabel').textContent = 'Running';
    } catch {
      document.getElementById('statusDot').style.background = 'var(--red)';
      document.getElementById('statusLabel').textContent = 'Offline';
    }
  }

  // ---- Load activity ----
  async function loadActivity() {
    const el = document.getElementById('activity-feed');
    el.innerHTML = '<div class="loading">Loading...</div>';
    try {
      const r = await fetch(API + '/activity');
      const items = await r.json();
      if (!items.length) { el.innerHTML = '<div class="empty">No activity yet.</div>'; return; }
      el.innerHTML = items.map(ev => {
        const dotClass = ev.kind === 'attachment_processed' ? 'processed'
          : ev.kind === 'duplicate_detected' ? 'duplicate'
          : ev.kind.replace(/_/g, '_');
        const title = ev.fileName ?? ev.detail ?? ev.kind;
        const meta = [
          ev.projectName ? \`<strong>\${esc(ev.projectName)}</strong>\` : null,
          ev.senderId ? \`from \${esc(ev.senderId)}\` : null,
          fmtDate(ev.ts),
        ].filter(Boolean).join(' &bull; ');
        return \`<div class="feed-item">
          <div class="feed-dot \${esc(dotClass)}"></div>
          <div class="feed-body">
            <div class="feed-title">\${esc(title)}</div>
            <div class="feed-meta">\${meta}</div>
          </div>
        </div>\`;
      }).join('');
    } catch { el.innerHTML = '<div class="empty">Failed to load.</div>'; }
  }

  // ---- Load files ----
  async function loadFiles() {
    const tbody = document.getElementById('files-body');
    tbody.innerHTML = '<tr><td colspan="8" class="loading">Loading...</td></tr>';
    try {
      const r = await fetch(API + '/files');
      const items = await r.json();
      if (!items.length) { tbody.innerHTML = '<tr><td colspan="8" class="empty">No files yet.</td></tr>'; return; }
      tbody.innerHTML = items.map(f => \`<tr>
        <td style="white-space:nowrap">\${fmtDate(f.processedAtIso)}</td>
        <td>\${esc(f.senderId)}</td>
        <td><strong>\${esc(f.projectName)}</strong></td>
        <td>\${esc(f.fileName)}</td>
        <td>\${badge(f.category, f.category)}</td>
        <td>\${esc(f.rootFolder)}\${f.phase ? ' / ' + esc(f.phase) : ''}</td>
        <td>\${conf(f.confidence)}</td>
        <td>\${badge(f.classificationSource, f.classificationSource)}</td>
      </tr>\`).join('');
    } catch { tbody.innerHTML = '<tr><td colspan="8" class="empty">Failed to load.</td></tr>'; }
  }

  // ---- Load messages ----
  async function loadMessages() {
    const tbody = document.getElementById('messages-body');
    tbody.innerHTML = '<tr><td colspan="6" class="loading">Loading...</td></tr>';
    try {
      const r = await fetch(API + '/messages');
      const items = await r.json();
      if (!items.length) { tbody.innerHTML = '<tr><td colspan="6" class="empty">No messages yet.</td></tr>'; return; }
      tbody.innerHTML = items.map(m => \`<tr>
        <td style="white-space:nowrap">\${fmtDate(m.ts)}</td>
        <td>\${esc(m.senderId)}</td>
        <td>\${m.isFromMe ? badge('ai','outbound') : badge('fallback','inbound')}</td>
        <td>\${m.projectName ? esc(m.projectName) : '<span style="color:var(--muted)">—</span>'}</td>
        <td>\${m.projectSource ? esc(m.projectSource) : '<span style="color:var(--muted)">—</span>'}</td>
        <td style="max-width:320px">\${esc(m.text)}</td>
      </tr>\`).join('');
    } catch { tbody.innerHTML = '<tr><td colspan="6" class="empty">Failed to load.</td></tr>'; }
  }

  // ---- Load duplicates ----
  async function loadDuplicates() {
    const tbody = document.getElementById('duplicates-body');
    tbody.innerHTML = '<tr><td colspan="7" class="loading">Loading...</td></tr>';
    try {
      const r = await fetch(API + '/duplicates');
      const items = await r.json();
      if (!items.length) { tbody.innerHTML = '<tr><td colspan="7" class="empty">No duplicates detected.</td></tr>'; return; }
      tbody.innerHTML = items.map(f => \`<tr>
        <td style="white-space:nowrap">\${fmtDate(f.processedAtIso)}</td>
        <td>\${esc(f.senderId)}</td>
        <td><strong>\${esc(f.projectName)}</strong></td>
        <td>\${esc(f.fileName)}</td>
        <td>\${badge(f.duplicateType ?? 'exact', f.duplicateType ?? '—')}</td>
        <td class="path">\${esc(f.duplicateMatchedPath)}</td>
        <td class="path">\${esc(f.relativePath)}</td>
      </tr>\`).join('');
    } catch { tbody.innerHTML = '<tr><td colspan="7" class="empty">Failed to load.</td></tr>'; }
  }

  // ---- Load manual review ----
  async function loadManualReview() {
    const tbody = document.getElementById('manual-body');
    tbody.innerHTML = '<tr><td colspan="7" class="loading">Loading...</td></tr>';
    try {
      const r = await fetch(API + '/manual-review');
      const items = await r.json();
      if (!items.length) { tbody.innerHTML = '<tr><td colspan="7" class="empty">No items in manual review.</td></tr>'; return; }
      tbody.innerHTML = items.map(f => \`<tr>
        <td style="white-space:nowrap">\${fmtDate(f.processedAtIso)}</td>
        <td>\${esc(f.senderId)}</td>
        <td>\${esc(f.fileName)}</td>
        <td>\${badge(f.category, f.category)}</td>
        <td>\${conf(f.confidence)}</td>
        <td class="path">\${esc(f.relativePath)}</td>
      </tr>\`).join('');
    } catch { tbody.innerHTML = '<tr><td colspan="7" class="empty">Failed to load.</td></tr>'; }
  }

  // ---- Load reports ----
  async function loadReports() {
    const tbody = document.getElementById('reports-body');
    tbody.innerHTML = '<tr><td colspan="8" class="loading">Loading...</td></tr>';
    try {
      const r = await fetch(API + '/reports');
      const items = await r.json();
      if (!items.length) { tbody.innerHTML = '<tr><td colspan="8" class="empty">No reports sent yet.</td></tr>'; return; }
      tbody.innerHTML = items.map(rpt => \`<tr>
        <td style="white-space:nowrap">\${fmtDate(rpt.ts)}</td>
        <td style="white-space:nowrap">\${fmtDate(rpt.periodStartIso)}</td>
        <td>\${esc(rpt.recipientEmail)}</td>
        <td style="text-align:center">\${rpt.totalFiles}</td>
        <td style="text-align:center">\${rpt.uniqueFiles}</td>
        <td style="text-align:center">\${rpt.duplicates}</td>
        <td style="text-align:center">\${rpt.manualReview}</td>
        <td>\${badge(rpt.success ? 'success' : 'failed', rpt.success ? 'sent' : 'failed')}</td>
      </tr>\`).join('');
    } catch { tbody.innerHTML = '<tr><td colspan="8" class="empty">Failed to load.</td></tr>'; }
  }

  // ---- Load by panel name ----
  function loadSection(name) {
    if (name === 'overview') loadOverview();
    else if (name === 'activity') loadActivity();
    else if (name === 'files') loadFiles();
    else if (name === 'messages') loadMessages();
    else if (name === 'duplicates') loadDuplicates();
    else if (name === 'manual-review') loadManualReview();
    else if (name === 'reports') loadReports();
  }

  // ---- Run report now ----
  async function runReport() {
    const btn = document.getElementById('btnRun');
    btn.disabled = true;
    btn.textContent = 'Running...';
    try {
      const r = await fetch(API + '/reports/run', { method: 'POST' });
      const d = await r.json();
      if (d.ok) {
        toast('Report sent successfully.');
        loadOverview();
        loadSection('reports');
      } else {
        toast('Report failed: ' + (d.error ?? 'unknown error'));
      }
    } catch (err) {
      toast('Request failed: ' + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Run Report Now';
    }
  }

  // ---- Auto-refresh every 30s ----
  setInterval(loadOverview, 30000);

  // ---- Initial load ----
  loadOverview();
  loadActivity();
</script>
</body>
</html>`;
}
