/* ─────────────────────────────────────────────────────────────────
   IP Tracker — Frontend
   Two-view SPA: Dashboard (VLAN list) ↔ VLAN Detail
───────────────────────────────────────────────────────────────── */

// ── Global state ──────────────────────────────────────────────────
let vlans       = [];
let entries     = [];
let pingResults = {};
let settings    = {};

let activeVlan  = null;   // full VLAN object when in detail view
let ipFilter    = 'all';
let ipView      = 'table';
let editingId   = null;

// scan
let scanRunning = false;
let sseSource   = null;
let liveUsed = 0, liveTimeout = 0, liveSpare = 0;
let scanRows = [];
let scanFilter = 'all';
let scanSearch = '';

// ── Subnet helpers ────────────────────────────────────────────────
function ipToInt(ip) {
  const p = ip.split('.').map(Number);
  return p[0]*16777216 + p[1]*65536 + p[2]*256 + p[3];
}
function intToIp(n) {
  return [(n>>>24)&0xff,(n>>>16)&0xff,(n>>>8)&0xff,n&0xff].join('.');
}
function getSubnetInfo(subnet, cidr) {
  const mask  = cidr === 0 ? 0 : (0xffffffff << (32-cidr)) >>> 0;
  const base  = (ipToInt(subnet) & mask) >>> 0;
  const bcast = (base | (~mask>>>0)) >>> 0;
  return {
    network:   intToIp(base),
    broadcast: intToIp(bcast),
    gateway:   intToIp(base + 1),
    mask:      intToIp(mask),
    usable:    bcast - base - 1,
    base, bcast,
  };
}
function getAllIPs(subnet, cidr) {
  const { base, bcast } = getSubnetInfo(subnet, cidr);
  const ips = [];
  for (let i = base; i <= bcast; i++) ips.push(intToIp(i));
  return ips;
}
function classifyIP(ip, subnet, cidr) {
  const { network, broadcast, gateway } = getSubnetInfo(subnet, cidr);
  if (ip === network)   return 'network';
  if (ip === broadcast) return 'broadcast';
  if (ip === gateway)   return 'gateway';
  return null;
}

// ── API helpers ───────────────────────────────────────────────────
async function apiFetch(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// ── Load ──────────────────────────────────────────────────────────
async function loadAll() {
  [vlans, entries, pingResults, settings] = await Promise.all([
    apiFetch('/api/vlans'),
    apiFetch('/api/entries'),
    apiFetch('/api/ping-results'),
    apiFetch('/api/settings'),
  ]);
}

// ── Format helpers ────────────────────────────────────────────────
function fmtTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-GB', { hour12:false });
}
function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB') + ' ' + d.toLocaleTimeString('en-GB', { hour12:false });
}
function fmtNumber(n) { return (n || 0).toLocaleString(); }

// ═════════════════════════════════════════════════════════════════
// VIEW NAVIGATION
// ═════════════════════════════════════════════════════════════════
function showDashboard() {
  activeVlan  = null;
  ipFilter    = 'all';
  scanFilter  = 'all';
  scanSearch  = '';
  scanRows    = [];

  // Close SSE if open
  if (sseSource) { sseSource.close(); sseSource = null; }
  scanRunning = false;

  document.getElementById('viewDashboard').style.display = '';
  document.getElementById('viewDetail').style.display    = 'none';

  // Header: show logo, hide back/breadcrumb/assign
  document.getElementById('backBtn').style.display      = 'none';
  document.getElementById('breadcrumb').style.display   = 'none';
  document.getElementById('headerAddBtn').style.display = 'none';

  renderDashboard();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function showVlanDetail(vlanId) {
  activeVlan = vlans.find(v => v.id === vlanId);
  if (!activeVlan) return;

  ipFilter   = 'all';
  ipView     = 'table';
  document.getElementById('ipSearch').value = '';

  document.getElementById('viewDashboard').style.display = 'none';
  document.getElementById('viewDetail').style.display    = '';

  // Header: show back button + breadcrumb + assign
  document.getElementById('backBtn').style.display      = '';
  document.getElementById('breadcrumb').style.display   = '';
  document.getElementById('headerAddBtn').style.display = '';
  document.getElementById('bcVlan').textContent =
    `VLAN ${activeVlan.id} — ${activeVlan.name}`;

  renderVlanHero();
  renderScanMeta();
  renderDetail();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ═════════════════════════════════════════════════════════════════
// DASHBOARD RENDERING
// ═════════════════════════════════════════════════════════════════
function renderDashboard() {
  renderGlobalStats();
  renderVlanCards();
}

function renderGlobalStats() {
  const totalUsable = vlans.reduce((s, v) => s + v.usable, 0);
  const totalUsed   = entries.filter(e => e.status === 'used').length;
  const totalRes    = entries.filter(e => e.status === 'reserved').length;
  const totalSpare  = totalUsable - totalUsed - totalRes;
  const pct         = totalUsable ? Math.round(((totalUsed+totalRes)/totalUsable)*100) : 0;

  // Ping summary across all VLANs
  const allPR = Object.values(pingResults);
  const pingUsed    = allPR.filter(r => r.pingStatus === 'used').length;
  const pingTimeout = allPR.filter(r => r.pingStatus === 'timeout').length;
  const pingSpare   = allPR.filter(r => r.pingStatus === 'spare').length;

  document.getElementById('statsBar').innerHTML = `
    <div class="stat-card">
      <div class="stat-label">Total IP Space</div>
      <div class="stat-value c-blue">${fmtNumber(totalUsable)}</div>
      <div class="stat-sub">across ${vlans.length} VLANs</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">🔴 Ping: Used</div>
      <div class="stat-value" style="color:#f87171">${fmtNumber(pingUsed)}</div>
      <div class="stat-sub">replied to ping</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">🟡 Ping: Timeout</div>
      <div class="stat-value c-yellow">${fmtNumber(pingTimeout)}</div>
      <div class="stat-sub">ICMP blocked / no reply</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">🟢 Ping: Spare</div>
      <div class="stat-value c-green">${fmtNumber(pingSpare)}</div>
      <div class="stat-sub">host unreachable</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Manually Assigned</div>
      <div class="stat-value c-purple">${fmtNumber(totalUsed+totalRes)}</div>
      <div class="stat-sub">${pct}% of space assigned</div>
    </div>
  `;
}

function renderVlanCards() {
  const q = (document.getElementById('vlanSearch').value || '').toLowerCase();
  const list = vlans.filter(v =>
    v.name.toLowerCase().includes(q) ||
    String(v.id).includes(q) ||
    v.subnet.includes(q)
  );

  if (!list.length) {
    document.getElementById('vlanGrid').innerHTML = `
      <div class="empty" style="grid-column:1/-1">
        <p>No VLANs match "<strong>${q}</strong>"</p>
      </div>`;
    return;
  }

  document.getElementById('vlanGrid').innerHTML = list.map(v => {
    const pct     = v.usable ? Math.round(((v.used+v.reserved)/v.usable)*100) : 0;
    const fillCls = pct > 80 ? 'danger' : pct > 60 ? 'warn' : '';
    const info    = getSubnetInfo(v.subnet, v.cidr);

    // Ping mini-stats
    let pingSection = '';
    if (v.pingScanned > 0) {
      pingSection = `
        <div class="vc-ping">
          <div class="vc-ping-item"><div class="vc-ping-dot" style="background:#f87171"></div><span class="vc-ping-val">${v.pingUsed}</span><span>used</span></div>
          <div class="vc-ping-item"><div class="vc-ping-dot" style="background:#f59e0b"></div><span class="vc-ping-val">${v.pingTimeout}</span><span>timeout</span></div>
          <div class="vc-ping-item"><div class="vc-ping-dot" style="background:#22c55e"></div><span class="vc-ping-val">${v.pingSpare}</span><span>spare</span></div>
          <span class="vc-ping-note">${v.pingScanned}/${v.usable} scanned</span>
        </div>`;
    }

    return `
    <div class="vlan-card" style="--vc:${v.color}" data-vid="${v.id}">
      <div class="vc-stripe"></div>
      <div class="vc-body">
        <div class="vc-top">
          <div class="vc-name">${v.name}</div>
          <div class="vc-vlan-badge">VLAN ${v.id}</div>
        </div>
        <div class="vc-subnet">
          <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>
          ${v.subnet}/${v.cidr}
        </div>
        <div class="vc-stats">
          <div class="vc-stat"><div class="vc-stat-dot" style="background:var(--green)"></div>${v.used} used</div>
          <div class="vc-stat"><div class="vc-stat-dot" style="background:var(--yellow)"></div>${v.reserved} reserved</div>
          <div class="vc-stat"><div class="vc-stat-dot" style="background:var(--muted)"></div>${Math.max(0,v.spare)} spare</div>
        </div>
        <div class="vc-bar">
          <div class="vc-bar-labels">
            <span>${v.usable} usable IPs</span>
            <span>${pct}% assigned</span>
          </div>
          <div class="vc-bar-track">
            <div class="vc-bar-fill ${fillCls}" style="width:${pct}%"></div>
          </div>
        </div>
      </div>
      ${pingSection}
      <svg class="vc-arrow" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
        <polyline points="9 18 15 12 9 6"/>
      </svg>
    </div>`;
  }).join('');
}

// ═════════════════════════════════════════════════════════════════
// VLAN DETAIL — HERO BAR
// ═════════════════════════════════════════════════════════════════
function renderVlanHero() {
  const v    = activeVlan;
  const info = getSubnetInfo(v.subnet, v.cidr);
  const pr   = Object.values(pingResults).filter(r => r.vlanId === v.id);
  const pusd = pr.filter(r => r.pingStatus === 'used').length;
  const ptmo = pr.filter(r => r.pingStatus === 'timeout').length;
  const pspr = pr.filter(r => r.pingStatus === 'spare').length;

  document.getElementById('vlanHero').innerHTML = `
    <div class="vh-stripe" style="background:${v.color}"></div>
    <div class="vh-body">
      <div class="vh-left">
        <div class="vh-title">
          ${v.name}
          <span class="vh-vlan-pill" style="color:${v.color};border-color:${v.color}40;background:${v.color}12">VLAN ${v.id}</span>
        </div>
        <div class="vh-subnet">${v.subnet}/${v.cidr}</div>
        <div class="vh-desc">
          Network: ${info.network} &nbsp;·&nbsp;
          Gateway: ${info.gateway} &nbsp;·&nbsp;
          Broadcast: ${info.broadcast} &nbsp;·&nbsp;
          Mask: ${info.mask}
        </div>
      </div>
      <div class="vh-stats">
        <div class="vh-stat">
          <div class="vh-stat-val c-blue">${fmtNumber(v.usable)}</div>
          <div class="vh-stat-label">Usable IPs</div>
        </div>
        <div class="vh-stat">
          <div class="vh-stat-val c-green">${pusd}</div>
          <div class="vh-stat-label">🔴 Ping Used</div>
        </div>
        <div class="vh-stat">
          <div class="vh-stat-val c-yellow">${ptmo}</div>
          <div class="vh-stat-label">🟡 Timeout</div>
        </div>
        <div class="vh-stat">
          <div class="vh-stat-val" style="color:#22c55e">${pspr}</div>
          <div class="vh-stat-label">🟢 Spare</div>
        </div>
        <div class="vh-stat">
          <div class="vh-stat-val c-purple">${v.used + v.reserved}</div>
          <div class="vh-stat-label">Assigned</div>
        </div>
      </div>
    </div>`;
}

// ═════════════════════════════════════════════════════════════════
// VLAN DETAIL — IP TABLE / GRID
// ═════════════════════════════════════════════════════════════════
function renderDetail() {
  const v      = activeVlan;
  const info   = getSubnetInfo(v.subnet, v.cidr);
  const vE     = entries.filter(e => e.vlanId === v.id);
  const allIPs = getAllIPs(v.subnet, v.cidr);
  const eMap   = Object.fromEntries(vE.map(e => [e.ip, e]));

  // Build row data
  const rows = allIPs.map(ip => {
    const sys   = classifyIP(ip, v.subnet, v.cidr);
    const entry = eMap[ip];
    const pr    = pingResults[ip];
    // Effective display status (for filter tabs)
    let status;
    if (sys)             status = sys;
    else if (pr)         status = pr.pingStatus;   // ping-derived
    else if (entry)      status = entry.status;    // manually assigned
    else                 status = 'unscanned';
    return { ip, sys, entry, pr, status };
  });

  // Build filter tab counts (only usable IPs, not sys)
  const usable = rows.filter(r => !r.sys);
  const cUsed    = usable.filter(r => r.status === 'used').length;
  const cTimeout = usable.filter(r => r.status === 'timeout').length;
  const cSpare   = usable.filter(r => r.status === 'spare').length;
  const cRes     = usable.filter(r => r.status === 'reserved').length;
  const cAll     = usable.length;

  // Detail meta
  const scanned = usable.filter(r => r.pr).length;
  document.getElementById('detailTitle').textContent = `${v.subnet}/${v.cidr} — ${v.name} IP Addresses`;
  document.getElementById('detailMeta').textContent  =
    `${fmtNumber(v.usable)} usable · ${scanned} scanned · gateway ${info.gateway}`;

  // Subnet strip
  document.getElementById('subnetInfo').innerHTML = `
    <div class="si"><span>Network:</span><code>${info.network}</code></div>
    <div class="si"><span>Gateway:</span><code>${info.gateway}</code></div>
    <div class="si"><span>Broadcast:</span><code>${info.broadcast}</code></div>
    <div class="si"><span>Mask:</span><code>${info.mask}</code></div>
    <div class="si"><span>Usable:</span><code>${fmtNumber(v.usable)}</code></div>
    <div class="si"><span>🔴 Used:</span><code style="color:var(--red)">${cUsed}</code></div>
    <div class="si"><span>🟡 Timeout:</span><code style="color:var(--yellow)">${cTimeout}</code></div>
    <div class="si"><span>🟢 Spare:</span><code style="color:var(--green)">${cSpare}</code></div>
  `;

  // Filter tabs
  document.getElementById('filterTabs').innerHTML = `
    <button class="ftab ${ipFilter==='all'     ?'active':''}" data-f="all">All <span style="opacity:.55">${cAll}</span></button>
    <button class="ftab ${ipFilter==='used'    ?'active':''}" data-f="used">🔴 Used <span style="opacity:.55">${cUsed}</span></button>
    <button class="ftab ${ipFilter==='timeout' ?'active':''}" data-f="timeout">🟡 Timeout <span style="opacity:.55">${cTimeout}</span></button>
    <button class="ftab ${ipFilter==='spare'   ?'active':''}" data-f="spare">🟢 Spare <span style="opacity:.55">${cSpare}</span></button>
    <button class="ftab ${ipFilter==='reserved'?'active':''}" data-f="reserved">Reserved <span style="opacity:.55">${cRes}</span></button>
  `;

  if (ipView === 'grid') renderGrid(rows, info);
  else                   renderTable(rows, info);
}

function filterRows(rows) {
  const q = (document.getElementById('ipSearch').value || '').toLowerCase();
  let out = rows;

  // Status filter (skip sys addresses unless showing all)
  if (ipFilter !== 'all') {
    out = out.filter(r => !r.sys && r.status === ipFilter);
  }

  // Search
  if (q) {
    out = out.filter(r =>
      r.ip.includes(q) ||
      (r.entry?.host     || '').toLowerCase().includes(q) ||
      (r.pr?.hostname    || '').toLowerCase().includes(q) ||
      (r.entry?.mac      || '').toLowerCase().includes(q) ||
      (r.entry?.type     || '').toLowerCase().includes(q) ||
      (r.entry?.notes    || '').toLowerCase().includes(q)
    );
  }
  return out;
}

// ── Table ─────────────────────────────────────────────────────────
function renderTable(rows, info) {
  const filtered = filterRows(rows);

  if (!filtered.length) {
    document.getElementById('detailContent').innerHTML = emptyState(ipFilter === 'spare'
      ? 'No spare IPs confirmed. Scan this VLAN to check for destination unreachable replies. IPs that only time out remain Timeout.'
      : 'No IPs match the current filter.');
    return;
  }

  document.getElementById('detailContent').innerHTML = `
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>#</th>
          <th>IP Address</th>
          <th>Ping Status</th>
          <th>Ping Result</th>
          <th>Resp. Time</th>
          <th>Last Checked</th>
          <th>Hostname</th>
          <th>Assigned Status</th>
          <th>Device</th>
          <th>MAC</th>
          <th style="text-align:right">Actions</th>
        </tr></thead>
        <tbody>
          ${filtered.map(r => {
            const num = ipToInt(r.ip) - info.base + 1;
            const hostname = r.entry?.host || r.pr?.hostname || '';
            return `<tr>
              <td class="td-num">${num}</td>
              <td class="td-ip">${r.ip}</td>
              <td>${r.pr ? pingBadge(r.pr.pingStatus) : (r.sys ? sysBadge(r.sys) : '<span class="td-muted">—</span>')}</td>
              <td class="td-muted" style="font-size:.76rem">${r.pr ? r.pr.pingResult : (r.sys ? sysLabel(r.sys) : '—')}</td>
              <td>${r.pr?.responseTime ? `<span class="resp-time">${r.pr.responseTime}</span>` : '<span class="resp-dash">—</span>'}</td>
              <td class="td-muted" style="font-size:.73rem;white-space:nowrap">${r.pr ? fmtTime(r.pr.checkedAt) : '—'}</td>
              <td class="td-trunc" style="font-size:.82rem">${hostname || '<span class="td-muted">—</span>'}</td>
              <td>${r.entry ? assignedBadge(r.entry.status) : '<span class="td-muted">—</span>'}</td>
              <td class="td-muted">${r.entry?.type || '—'}</td>
              <td class="td-mono">${r.entry?.mac || (r.pr?.mac ? `<span style="color:var(--muted)">${r.pr.mac}</span>` : '—')}</td>
              <td>
                <div class="td-acts">
                  ${!r.sys ? `<button class="btn-icon btn-sm" title="Ping now" data-pingip="${r.ip}">
                    <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>
                  </button>` : ''}
                  ${r.entry ? `
                    <button class="btn-icon" title="Edit" data-edit="${r.entry.id}">
                      <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                    </button>
                    <button class="btn-icon danger" title="Delete" data-del="${r.entry.id}">
                      <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
                    </button>
                  ` : (!r.sys ? `<button class="btn-assign" data-assign="${r.ip}">Assign</button>` : '')}
                </div>
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;
}

// ── Grid ──────────────────────────────────────────────────────────
function renderGrid(rows, info) {
  const filtered = filterRows(rows);

  if (!filtered.length) {
    document.getElementById('detailContent').innerHTML = emptyState('No IPs match the current filter.');
    return;
  }

  const blocks = filtered.map(r => {
    const last = r.ip.split('.').pop();
    const cls  = r.sys || (r.pr ? r.pr.pingStatus : (r.entry ? r.entry.status : 'unscanned'));
    const host = r.entry?.host || r.pr?.hostname || '';
    const hostEl = host ? `<div class="ipb-host" title="${host}">${host}</div>` : '';
    const click  = r.entry ? `data-edit="${r.entry.id}"` :
                   r.sys   ? '' : `data-assign="${r.ip}"`;
    const tip = `${r.ip}${host ? ' — '+host : ''}${r.pr ? ' ['+r.pr.pingStatus+']' : ''}`;
    return `<div class="ipb ${cls}" ${click} title="${tip}">.${last}${hostEl}</div>`;
  }).join('');

  document.getElementById('detailContent').innerHTML = `<div class="ip-grid">${blocks}</div>`;
}

// ── Badge helpers ─────────────────────────────────────────────────
function pingBadge(status) {
  const map = {
    used:    `<span class="ping-badge pb-used">🔴 Used</span>`,
    timeout: `<span class="ping-badge pb-timeout">🟡 Timeout</span>`,
    spare:   `<span class="ping-badge pb-spare">🟢 Spare</span>`,
    error:   `<span class="ping-badge pb-error">⚠ Error</span>`,
  };
  return map[status] || `<span class="ping-badge pb-timeout">${status}</span>`;
}
function assignedBadge(status) {
  if (status === 'used')     return `<span class="badge b-used">Used</span>`;
  if (status === 'reserved') return `<span class="badge b-reserved">Reserved</span>`;
  return `<span class="badge b-spare">${status}</span>`;
}
function sysBadge(cls) {
  if (cls === 'network')   return `<span class="badge b-network">Network</span>`;
  if (cls === 'broadcast') return `<span class="badge b-broadcast">Broadcast</span>`;
  if (cls === 'gateway')   return `<span class="badge b-gateway">Gateway</span>`;
  return '';
}
function sysLabel(cls) {
  if (cls === 'network')   return 'Network address';
  if (cls === 'broadcast') return 'Broadcast address';
  if (cls === 'gateway')   return 'Default gateway';
  return '';
}
function emptyState(msg) {
  return `<div class="empty">
    <svg width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
      <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
    </svg>
    <p>${msg}</p>
  </div>`;
}

// ═════════════════════════════════════════════════════════════════
// SCAN
// ═════════════════════════════════════════════════════════════════
function renderScanMeta() {
  if (!activeVlan) return;
  const v  = activeVlan;
  const pr = Object.values(pingResults).filter(r => r.vlanId === v.id);
  if (!pr.length) {
    document.getElementById('scanMeta').textContent = 'No scan data yet — click Scan to begin.';
    return;
  }
  const used = pr.filter(r => r.pingStatus === 'used').length;
  const tmo  = pr.filter(r => r.pingStatus === 'timeout').length;
  const spr  = pr.filter(r => r.pingStatus === 'spare').length;
  const latest = pr.reduce((m, r) => Math.max(m, new Date(r.checkedAt).getTime()), 0);
  document.getElementById('scanMeta').textContent =
    `${pr.length} IPs scanned  ·  🔴 ${used} used  ·  🟡 ${tmo} timeout  ·  🟢 ${spr} spare  ·  ${fmtDateTime(new Date(latest).toISOString())}`;
}

async function startScan() {
  if (scanRunning || !activeVlan) return;
  const v = activeVlan;

  try {
    const res = await apiFetch('/api/scan', {
      method: 'POST',
      body: JSON.stringify({ vlanId: v.id }),
    });

    scanRunning = true;
    liveUsed = 0; liveTimeout = 0; liveSpare = 0;

    document.getElementById('scanBtn').disabled = true;
    document.getElementById('scanBtnText').textContent = 'Scanning…';
    document.getElementById('scanProgressWrap').style.display = '';
    document.getElementById('scanProgressFill').style.width = '0%';
    document.getElementById('scanProgressCount').textContent = `0 / ${res.total}`;
    document.getElementById('scanProgressLabel').textContent = 'Scanning…';
    document.getElementById('liveUsed').textContent    = '0';
    document.getElementById('liveTimeout').textContent = '0';
    document.getElementById('liveSpare').textContent   = '0';

    connectSSE(res.total);
  } catch (err) {
    toast(err.message, 'error');
  }
}

function connectSSE(total) {
  if (sseSource) { sseSource.close(); sseSource = null; }
  sseSource = new EventSource('/api/scan/stream');

  sseSource.addEventListener('scan-progress', e => {
    const d = JSON.parse(e.data);

    // Update cache (only for current VLAN)
    if (d.vlanId === activeVlan?.id) {
      pingResults[d.ip] = {
        ip:           d.ip,
        vlanId:       d.vlanId,
        pingStatus:   d.pingStatus,
        pingResult:   d.pingResult,
        responseTime: d.responseTime,
        hostname:     d.hostname || null,
        mac:          d.mac || null,
        checkedAt:    d.checkedAt,
      };
    }

    if (d.pingStatus === 'used')    liveUsed++;
    if (d.pingStatus === 'timeout') liveTimeout++;
    if (d.pingStatus === 'spare')   liveSpare++;

    document.getElementById('liveUsed').textContent    = liveUsed;
    document.getElementById('liveTimeout').textContent = liveTimeout;
    document.getElementById('liveSpare').textContent   = liveSpare;

    const pct = Math.round((d.done / d.total) * 100);
    document.getElementById('scanProgressFill').style.width = pct + '%';
    document.getElementById('scanProgressCount').textContent = `${d.done} / ${d.total}`;
    document.getElementById('scanProgressLabel').textContent = `Scanning ${d.ip}…`;

    // Refresh detail table every 30 IPs to show live results without hammering DOM
    if (d.done % 30 === 0) renderDetail();
  });

  sseSource.addEventListener('scan-done', async () => {
    scanRunning = false;
    if (sseSource) { sseSource.close(); sseSource = null; }

    document.getElementById('scanBtn').disabled = false;
    document.getElementById('scanBtnText').textContent = 'Scan / Ping All IPs';
    document.getElementById('scanProgressLabel').textContent = '✅ Scan complete';

    // Reload VLAN stats from server
    vlans = await apiFetch('/api/vlans');
    pingResults = await apiFetch('/api/ping-results');
    activeVlan  = vlans.find(v => v.id === activeVlan?.id) || activeVlan;

    renderVlanHero();
    renderScanMeta();
    renderDetail();

    toast(`Scan complete — 🔴 ${liveUsed} used · 🟡 ${liveTimeout} timeout · 🟢 ${liveSpare} spare`, 'success');
  });

  sseSource.addEventListener('error', () => {
    if (scanRunning) {
      scanRunning = false;
      document.getElementById('scanBtn').disabled = false;
      document.getElementById('scanBtnText').textContent = 'Scan / Ping All IPs';
      toast('Scan connection lost.', 'error');
    }
  });
}

// ── Single IP ping ────────────────────────────────────────────────
async function pingSingleIP(ip) {
  toast(`Pinging ${ip}…`, 'info');
  try {
    const result = await apiFetch('/api/ping', {
      method: 'POST',
      body: JSON.stringify({ ip }),
    });
    pingResults[ip] = result;
    vlans = await apiFetch('/api/vlans');
    activeVlan = vlans.find(v => v.id === activeVlan?.id) || activeVlan;
    renderVlanHero();
    renderScanMeta();
    renderDetail();
    toast(`${ip} → ${result.pingStatus.toUpperCase()}${result.responseTime ? ' ('+result.responseTime+')' : ''}`, 'success');
  } catch (err) {
    toast(`Ping failed: ${err.message}`, 'error');
  }
}

// ═════════════════════════════════════════════════════════════════
// ASSIGN IP MODAL
// ═════════════════════════════════════════════════════════════════
function populateVlanSelect(selectedId) {
  // In detail view, only show current VLAN; in dashboard show all
  const list = activeVlan ? [activeVlan] : vlans;
  document.getElementById('fVlan').innerHTML =
    list.map(v => `<option value="${v.id}" ${v.id === selectedId ? 'selected':''}>${v.name} — VLAN ${v.id} (${v.subnet}/${v.cidr})</option>`).join('');
}

function openAddModal(ip) {
  editingId = null;
  document.getElementById('modalTitle').textContent = 'Assign IP Address';
  populateVlanSelect(activeVlan?.id);
  document.getElementById('fIp').value     = ip || '';
  document.getElementById('fHost').value   = '';
  document.getElementById('fStatus').value = 'used';
  document.getElementById('fType').value   = '';
  document.getElementById('fMac').value    = '';
  document.getElementById('fNotes').value  = '';
  document.getElementById('formError').textContent = '';
  document.getElementById('modal').classList.add('open');
  setTimeout(() => document.getElementById('fIp').focus(), 80);
}

function openEditModal(id) {
  const e = entries.find(x => x.id === id);
  if (!e) return;
  editingId = id;
  document.getElementById('modalTitle').textContent = 'Edit Assignment';
  populateVlanSelect(e.vlanId);
  document.getElementById('fVlan').value   = e.vlanId;
  document.getElementById('fIp').value     = e.ip;
  document.getElementById('fHost').value   = e.host   || '';
  document.getElementById('fStatus').value = e.status;
  document.getElementById('fType').value   = e.type   || '';
  document.getElementById('fMac').value    = e.mac    || '';
  document.getElementById('fNotes').value  = e.notes  || '';
  document.getElementById('formError').textContent = '';
  document.getElementById('modal').classList.add('open');
}

function closeModal() {
  document.getElementById('modal').classList.remove('open');
  editingId = null;
}

async function saveEntry() {
  const errEl  = document.getElementById('formError');
  errEl.textContent = '';

  const vlanId = document.getElementById('fVlan').value;
  const ip     = document.getElementById('fIp').value.trim();
  const host   = document.getElementById('fHost').value.trim();
  const status = document.getElementById('fStatus').value;
  const type   = document.getElementById('fType').value;
  const mac    = document.getElementById('fMac').value.trim();
  const notes  = document.getElementById('fNotes').value.trim();

  if (!vlanId) { errEl.textContent = 'Please select a VLAN.'; return; }
  if (!ip)     { errEl.textContent = 'IP address is required.'; return; }
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(ip) || ip.split('.').some(n=>+n>255)) {
    errEl.textContent = 'Enter a valid IP address.'; return;
  }

  const btn = document.getElementById('modalSave');
  btn.disabled = true; btn.textContent = 'Saving…';

  try {
    if (editingId) {
      const updated = await apiFetch(`/api/entries/${editingId}`, {
        method: 'PUT',
        body: JSON.stringify({ vlanId:+vlanId, ip, host, status, type, mac, notes }),
      });
      entries[entries.findIndex(e => e.id === editingId)] = updated;
      toast('Entry updated.', 'success');
    } else {
      const created = await apiFetch('/api/entries', {
        method: 'POST',
        body: JSON.stringify({ vlanId:+vlanId, ip, host, status, type, mac, notes }),
      });
      entries.push(created);
      toast(`${ip} assigned.`, 'success');
    }
    vlans = await apiFetch('/api/vlans');
    activeVlan = vlans.find(v => v.id === activeVlan?.id) || activeVlan;
    closeModal();
    if (activeVlan) { renderVlanHero(); renderDetail(); }
    else            { renderDashboard(); }
  } catch (err) {
    errEl.textContent = err.message;
  } finally {
    btn.disabled = false; btn.textContent = 'Save Assignment';
  }
}

async function deleteEntry(id) {
  if (!confirm('Remove this IP assignment?')) return;
  try {
    await apiFetch(`/api/entries/${id}`, { method: 'DELETE' });
    entries = entries.filter(e => e.id !== id);
    vlans   = await apiFetch('/api/vlans');
    activeVlan = vlans.find(v => v.id === activeVlan?.id) || activeVlan;
    toast('Assignment removed.', 'info');
    if (activeVlan) { renderVlanHero(); renderDetail(); }
    else            { renderDashboard(); }
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ═════════════════════════════════════════════════════════════════
// SETTINGS MODAL
// ═════════════════════════════════════════════════════════════════
function openSettingsModal() {
  document.getElementById('sPingTimeout').value = settings.pingTimeout || 1500;
  document.getElementById('sConcurrency').value = settings.concurrency || 30;
  document.getElementById('sPingRetries').value = settings.pingRetries ?? 1;
  document.getElementById('settingsError').textContent = '';
  document.getElementById('settingsModal').classList.add('open');
}
function closeSettingsModal() {
  document.getElementById('settingsModal').classList.remove('open');
}
async function saveSettings() {
  const pingTimeout = +document.getElementById('sPingTimeout').value;
  const concurrency = +document.getElementById('sConcurrency').value;
  const pingRetries = +document.getElementById('sPingRetries').value;
  const errEl = document.getElementById('settingsError');

  if (pingTimeout < 500 || pingTimeout > 10000) { errEl.textContent = 'Timeout must be 500–10000 ms.'; return; }
  if (concurrency < 1  || concurrency > 100)    { errEl.textContent = 'Concurrency must be 1–100.'; return; }
  if (pingRetries < 0  || pingRetries > 5)       { errEl.textContent = 'Retries must be 0–5.'; return; }

  try {
    settings = await apiFetch('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ pingTimeout, concurrency, pingRetries }),
    });
    closeSettingsModal();
    toast('Settings saved.', 'success');
  } catch (err) {
    errEl.textContent = err.message;
  }
}

// ═════════════════════════════════════════════════════════════════
// EXPORT CSV
// ═════════════════════════════════════════════════════════════════
function exportCSV() {
  // Export current view: if in detail, only that VLAN; else all
  const targetVlans = activeVlan ? [activeVlan] : vlans;
  const rows = [['VLAN ID','VLAN Name','IP Address','Ping Status','Ping Result',
                 'Response Time','Last Checked','Hostname','Assigned Status',
                 'Device Type','MAC Address','Notes']];

  targetVlans.forEach(v => {
    const eMap = Object.fromEntries(entries.filter(e => e.vlanId === v.id).map(e => [e.ip, e]));
    getAllIPs(v.subnet, v.cidr).forEach(ip => {
      const sys   = classifyIP(ip, v.subnet, v.cidr);
      const entry = eMap[ip];
      const pr    = pingResults[ip];
      if (sys || entry || pr) {
        rows.push([
          v.id, v.name, ip,
          pr?.pingStatus    || sys || '',
          pr?.pingResult    || sys || '',
          pr?.responseTime  || '',
          pr?.checkedAt     ? fmtDateTime(pr.checkedAt) : '',
          entry?.host || pr?.hostname || '',
          sys || entry?.status || '',
          entry?.type  || '',
          entry?.mac || pr?.mac || '',
          entry?.notes || '',
        ]);
      }
    });
  });

  const csv  = rows.map(r => r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type:'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  const scope = activeVlan ? `VLAN${activeVlan.id}` : 'all';
  a.href = url; a.download = `ip-tracker-${scope}-${new Date().toISOString().slice(0,10)}.csv`;
  a.click(); URL.revokeObjectURL(url);
  toast(`CSV exported (${scope}).`, 'success');
}

// ═════════════════════════════════════════════════════════════════
// TOAST
// ═════════════════════════════════════════════════════════════════
function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span>${{success:'✓',error:'✕',info:'ℹ',warning:'⚠'}[type]||'ℹ'}</span><span>${msg}</span>`;
  document.getElementById('toastContainer').appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// ═════════════════════════════════════════════════════════════════
// EVENT DELEGATION
// ═════════════════════════════════════════════════════════════════
document.addEventListener('click', e => {

  // ── Navigation ────────────────────────────────────────────────
  // VLAN card → go to detail
  const card = e.target.closest('.vlan-card');
  if (card) { showVlanDetail(+card.dataset.vid); return; }

  // Back button
  if (e.target.id === 'backBtn' || e.target.closest('#backBtn')) { showDashboard(); return; }

  // ── Scan ──────────────────────────────────────────────────────
  if (e.target.id === 'scanBtn' || e.target.closest('#scanBtn')) { startScan(); return; }

  // Single IP ping
  const pingBtn = e.target.closest('[data-pingip]');
  if (pingBtn) { pingSingleIP(pingBtn.dataset.pingip); return; }

  // ── IP filter tabs ────────────────────────────────────────────
  const ft = e.target.closest('[data-f]');
  if (ft) { ipFilter = ft.dataset.f; renderDetail(); return; }

  // ── View toggle ───────────────────────────────────────────────
  if (e.target.id === 'viewTableBtn' || e.target.closest('#viewTableBtn')) {
    ipView = 'table';
    document.getElementById('viewTableBtn').classList.add('active');
    document.getElementById('viewGridBtn').classList.remove('active');
    renderDetail(); return;
  }
  if (e.target.id === 'viewGridBtn' || e.target.closest('#viewGridBtn')) {
    ipView = 'grid';
    document.getElementById('viewGridBtn').classList.add('active');
    document.getElementById('viewTableBtn').classList.remove('active');
    renderDetail(); return;
  }

  // ── Entry CRUD ────────────────────────────────────────────────
  const editBtn = e.target.closest('[data-edit]');
  if (editBtn) { openEditModal(editBtn.dataset.edit); return; }

  const delBtn = e.target.closest('[data-del]');
  if (delBtn) { deleteEntry(delBtn.dataset.del); return; }

  const assignBtn = e.target.closest('[data-assign]');
  if (assignBtn) { openAddModal(assignBtn.dataset.assign); return; }

  if (e.target.id === 'headerAddBtn' || e.target.closest('#headerAddBtn')) { openAddModal(); return; }
  if (e.target.id === 'detailAddBtn' || e.target.closest('#detailAddBtn')) { openAddModal(); return; }

  // ── Export ────────────────────────────────────────────────────
  if (e.target.id === 'exportBtn' || e.target.closest('#exportBtn')) { exportCSV(); return; }

  // ── Settings ──────────────────────────────────────────────────
  if (e.target.id === 'settingsBtn' || e.target.closest('#settingsBtn')) { openSettingsModal(); return; }
  if (e.target.id === 'settingsModalClose' || e.target.closest('#settingsModalClose')) { closeSettingsModal(); return; }
  if (e.target.id === 'settingsCancel') { closeSettingsModal(); return; }
  if (e.target.id === 'settingsSave')   { saveSettings(); return; }

  // ── Assign modal ──────────────────────────────────────────────
  if (e.target.id === 'modalClose' || e.target.closest('#modalClose')) { closeModal(); return; }
  if (e.target.id === 'modalCancel') { closeModal(); return; }
  if (e.target.id === 'modalSave')   { saveEntry(); return; }

  // Overlay click to close
  if (e.target.id === 'modal')         { closeModal(); return; }
  if (e.target.id === 'settingsModal') { closeSettingsModal(); return; }
});

// Overlay backdrop clicks
document.getElementById('modal').addEventListener('click',
  e => { if (e.target === document.getElementById('modal')) closeModal(); });
document.getElementById('settingsModal').addEventListener('click',
  e => { if (e.target === document.getElementById('settingsModal')) closeSettingsModal(); });

// Search inputs
document.getElementById('vlanSearch').addEventListener('input', renderVlanCards);
document.getElementById('ipSearch').addEventListener('input', renderDetail);

// ═════════════════════════════════════════════════════════════════
// BOOTSTRAP
// ═════════════════════════════════════════════════════════════════
(async () => {
  try {
    await loadAll();
    showDashboard();
  } catch (err) {
    document.getElementById('statsBar').innerHTML =
      `<div style="color:var(--red);padding:16px;font-size:.9rem;grid-column:1/-1">
        ⚠ Cannot connect to server: ${err.message}
       </div>`;
  }
})();
