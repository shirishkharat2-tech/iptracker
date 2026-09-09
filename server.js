const express  = require('express');
const cors     = require('cors');
const fs       = require('fs');
const path     = require('path');
const ping     = require('ping');
const dns      = require('dns').promises;
const { isIPv4 } = require('net');
const { exec } = require('child_process');

const app  = express();
const PORT = Number(process.env.PORT || 9000);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535.');
}
const DB        = path.join(__dirname, 'data', 'entries.json');
const PING_DB   = path.join(__dirname, 'data', 'ping-results.json');
const SETTINGS  = path.join(__dirname, 'data', 'settings.json');

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── File helpers ───────────────────────────────────────────────────
function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// ── Default settings ───────────────────────────────────────────────
const DEFAULT_SETTINGS = {
  pingTimeout:   1500,   // ms per ping probe
  concurrency:   30,     // parallel pings at once
  pingRetries:   1,      // retries before giving up
};

function getSettings() {
  return { ...DEFAULT_SETTINGS, ...readJSON(SETTINGS, {}) };
}

// ── Subnet utilities ───────────────────────────────────────────────
function ipToInt(ip) {
  const p = ip.split('.').map(Number);
  return (p[0] * 16777216 + p[1] * 65536 + p[2] * 256 + p[3]);
}
function intToIp(n) {
  return [
    (n >>> 24) & 0xff,
    (n >>> 16) & 0xff,
    (n >>>  8) & 0xff,
     n         & 0xff,
  ].join('.');
}
function subnetMask(cidr) {
  return cidr === 0 ? 0 : (0xffffffff << (32 - cidr)) >>> 0;
}
function isInSubnet(ip, subnet, cidr) {
  const mask = subnetMask(cidr);
  return (ipToInt(ip) & mask) === (ipToInt(subnet) & mask);
}
function getUsableIPs(subnet, cidr) {
  const mask   = subnetMask(cidr);
  const base   = ipToInt(subnet) & mask;
  const bcast  = base + (~mask >>> 0);
  const ips    = [];
  // skip network (base), gateway (base+1) and broadcast (bcast)
  for (let i = base + 2; i < bcast; i++) ips.push(intToIp(i));
  return ips;
}

// ── VLAN definitions ───────────────────────────────────────────────
const VLANS = [
  { id: 1,   name: 'Default',    subnet: '192.168.1.0',   cidr: 23, color: '#64748b' },
  { id: 10,  name: 'XBRL',       subnet: '192.168.10.0',  cidr: 23, color: '#4f8ef7' },
  { id: 20,  name: 'Mobile',     subnet: '192.168.20.0',  cidr: 24, color: '#7c5cfc' },
  { id: 30,  name: 'HRAdmin',    subnet: '192.168.30.0',  cidr: 23, color: '#ec4899' },
  { id: 40,  name: 'Technology', subnet: '192.168.40.0',  cidr: 23, color: '#06b6d4' },
  { id: 50,  name: 'Server',     subnet: '192.168.50.0',  cidr: 23, color: '#22c55e' },
  { id: 60,  name: 'IOT',        subnet: '192.168.60.0',  cidr: 24, color: '#f59e0b' },
  { id: 70,  name: 'Finance',    subnet: '192.168.70.0',  cidr: 24, color: '#ef4444' },
  { id: 99,  name: 'IT',         subnet: '192.168.99.0',  cidr: 24, color: '#10b981' },
  { id: 110, name: 'Emergency',  subnet: '192.168.110.0', cidr: 24, color: '#f97316' },
  { id: 120, name: 'IDP',        subnet: '192.168.120.0', cidr: 24, color: '#a855f7' },
];

// ── Network topology helpers ───────────────────────────────────────
// Detect local machine's own IPs and subnets so we know which VLANs
// are directly reachable at L2 (ARP works) vs routed (ARP won't work).
const os = require('os');

function getLocalSubnets() {
  const subnets = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        subnets.push({ address: iface.address, netmask: iface.netmask, cidr: iface.cidr });
      }
    }
  }
  return subnets;
}

function isDirectlyConnected(targetIp) {
  const localSubnets = getLocalSubnets();
  for (const s of localSubnets) {
    // Convert netmask to integer and test
    const maskInt  = s.netmask.split('.').reduce((acc, o) => (acc << 8) | +o, 0) >>> 0;
    const netInt   = s.address.split('.').reduce((acc, o) => (acc << 8) | +o, 0) >>> 0 & maskInt;
    const targetInt = targetIp.split('.').reduce((acc, o) => (acc << 8) | +o, 0) >>> 0;
    if ((targetInt & maskInt) >>> 0 === netInt >>> 0) return true;
  }
  return false;
}

// ── Hostname resolution ────────────────────────────────────────────
// Try multiple methods in order: reverse DNS → NetBIOS (nbtstat)
function resolveHostname(ip) {
  return new Promise(resolve => {
    // Method 1: Reverse DNS PTR lookup
    dns.reverse(ip)
      .then(hosts => {
        if (hosts && hosts.length > 0) {
          // Strip trailing dot and domain, keep short name
          const name = hosts[0].replace(/\.$/, '');
          return resolve(name);
        }
        resolve(null);
      })
      .catch(() => {
        // Method 2: NetBIOS name lookup via nbtstat -A
        exec(`nbtstat -A ${ip}`, { timeout: 3000 }, (err, stdout) => {
          if (err || !stdout) return resolve(null);
          // Parse nbtstat output for the <00> UNIQUE entry (workstation name)
          // Line looks like:  HOSTNAME         <00>  UNIQUE  Registered
          const match = stdout.match(/^\s*(\S+)\s+<00>\s+UNIQUE/im);
          if (match) return resolve(match[1].trim());
          resolve(null);
        });
      });
  });
}

// ── ARP helper (read-only, no flushing) ───────────────────────────
// Used only to detect a device that blocks ICMP but has an ARP entry.
// NEVER flush ARP before pinging — flushing causes Windows to wait for
// an ARP reply that never arrives, turning "Destination host unreachable"
// into "Request timed out" (confirmed by testing).
function checkArp(ip) {
  return new Promise(resolve => {
    exec(`arp -a ${ip}`, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      for (const line of stdout.split('\n')) {
        if (line.includes(ip) && /([0-9a-f]{2}[:-]){5}[0-9a-f]{2}/i.test(line)) {
          const mac = line.match(/([0-9a-f]{2}[:-]){5}[0-9a-f]{2}/i);
          if (mac) return resolve(mac[0]);
        }
      }
      resolve(null);
    });
  });
}

// ── Ping engine ────────────────────────────────────────────────────
//
//  Runs ping.exe directly via exec() — same as typing ping in a terminal.
//  Parses the exact reply line and maps it to a status:
//
//    "Reply from x.x.x.x: bytes=..."   → USED    (red)
//    "...unreachable..."                → SPARE   (green)
//    "Request timed out."               → TIMEOUT
//
//  The pingResult stored is the exact line from ping output.

function pingRaw(ip, timeoutMs, retries = 0) {
  const w = Math.max(500, timeoutMs);   // -w is milliseconds on Windows
  const count = 1 + Math.min(5, Math.max(0, Math.trunc(Number(retries) || 0)));
  return new Promise(resolve => {
    exec(
      `ping -n ${count} -w ${w} ${ip}`,
      { timeout: count * (w + 1000) + 4000 },
      (_err, stdout) => resolve(stdout || '')
    );
  });
}

function parseOutput(raw) {
  // Split into non-empty trimmed lines
  const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  // The first line containing ping data (skip "Pinging x.x.x.x …" header)
  const dataLine = lines.find(l =>
    /reply from|timed out|unreachable/i.test(l)
  ) || '';

  const fullLower = raw.toLowerCase();

  // ── USED: real ICMP echo reply ────────────────────────────────
  const replyLine = lines.find(l => /reply from .+bytes=/i.test(l));
  if (replyLine) {
    const timeMatch = replyLine.match(/time([=<])(\d+)\s*ms/i);
    const responseTime = timeMatch
      ? `${timeMatch[1] === '<' ? '< ' : ''}${timeMatch[2]} ms` : null;
    return { pingStatus: 'used', pingResult: replyLine, responseTime };
  }

  // ── SPARE: any "unreachable" message ─────────────────────────
  if (fullLower.includes('unreachable')) {
    const unreachLine = lines.find(l => /unreachable/i.test(l)) || dataLine;
    return { pingStatus: 'spare', pingResult: unreachLine, responseTime: null };
  }

  // ── TIMEOUT: everything else ──────────────────────────────────
  return {
    pingStatus:  'timeout',
    pingResult:  dataLine || 'Request timed out',
    responseTime: null,
  };
}

async function pingOne(ip, settings) {
  try {
    // Routed ICMP errors can arrive later than replies from the local subnet.
    const routed = !isDirectlyConnected(ip);
    const raw    = await pingRaw(ip,
      routed ? Math.max(3000, settings.pingTimeout) : settings.pingTimeout,
      routed ? Math.max(2, settings.pingRetries) : settings.pingRetries);
    const parsed = parseOutput(raw);

    let hostname = null;
    if (parsed.pingStatus === 'used') {
      try {
        hostname = await Promise.race([
          resolveHostname(ip),
          new Promise(r => setTimeout(() => r(null), 2000)),
        ]);
      } catch { /* ignore */ }
    }

    return { ...parsed, hostname };
  } catch (err) {
    return { pingStatus: 'timeout', pingResult: `Error: ${err.message}`, responseTime: null, hostname: null };
  }
}

// concurrency-limited runner
async function runWithConcurrency(tasks, limit, onResult) {
  let index = 0;
  let active = 0;
  let resolve;
  const done = new Promise(r => { resolve = r; });

  function next() {
    while (active < limit && index < tasks.length) {
      const task = tasks[index++];
      active++;
      task().then(result => {
        onResult(result);
        active--;
        if (active === 0 && index >= tasks.length) resolve();
        else next();
      });
    }
    if (index >= tasks.length && active === 0) resolve();
  }

  next();
  return done;
}

// ── Scan state (in-memory, one scan at a time) ─────────────────────
let scanState = {
  running:   false,
  vlanId:    null,
  total:     0,
  done:      0,
  startedAt: null,
};
// SSE clients waiting for progress
const sseClients = new Set();

function sseEmit(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.write(msg); } catch { sseClients.delete(client); }
  }
}

// ── API: Settings ─────────────────────────────────────────────────
app.get('/api/settings', (req, res) => {
  res.json(getSettings());
});
app.put('/api/settings', (req, res) => {
  const current = getSettings();
  const updated = {
    pingTimeout:  +req.body.pingTimeout  || current.pingTimeout,
    concurrency:  +req.body.concurrency  || current.concurrency,
    pingRetries: req.body.pingRetries !== undefined
      ? Math.min(5, Math.max(0, Math.trunc(Number(req.body.pingRetries) || 0)))
      : current.pingRetries,
  };
  writeJSON(SETTINGS, updated);
  res.json(updated);
});

// ── API: VLANs ─────────────────────────────────────────────────────
app.get('/api/vlans', (req, res) => {
  const entries    = readJSON(DB, []);
  const pingResult = readJSON(PING_DB, {});

  const result = VLANS.map(v => {
    const mask   = subnetMask(v.cidr);
    const base   = ipToInt(v.subnet) & mask;
    const bcast  = base + (~mask >>> 0);
    const usable = bcast - base - 1;

    const vEntries = entries.filter(e => e.vlanId === v.id);
    const used     = vEntries.filter(e => e.status === 'used').length;
    const reserved = vEntries.filter(e => e.status === 'reserved').length;

    // Ping stats for this VLAN
    const usableIPs = getUsableIPs(v.subnet, v.cidr);
    let pingUsed = 0, pingTimeout = 0, pingSpare = 0, pingScanned = 0;
    for (const ip of usableIPs) {
      const r = pingResult[ip];
      if (r) {
        pingScanned++;
        if (r.pingStatus === 'used')    pingUsed++;
        if (r.pingStatus === 'timeout') pingTimeout++;
        if (r.pingStatus === 'spare')   pingSpare++;
      }
    }

    return {
      ...v, usable, used, reserved,
      spare: Math.max(0, usable - used - reserved),
      pingUsed, pingTimeout, pingSpare, pingScanned,
      lastScanned: pingScanned > 0
        ? Math.max(...usableIPs.filter(ip => pingResult[ip]).map(ip => new Date(pingResult[ip].checkedAt).getTime()))
        : null,
    };
  });
  res.json(result);
});

// ── API: Entries CRUD ──────────────────────────────────────────────
app.get('/api/entries', (req, res) => {
  let data = readJSON(DB, []);
  if (req.query.vlanId) data = data.filter(e => e.vlanId === +req.query.vlanId);
  res.json(data);
});

app.post('/api/entries', (req, res) => {
  const { vlanId, ip, host, status, type, mac, notes } = req.body;
  if (!vlanId || !ip) return res.status(400).json({ error: 'vlanId and ip are required.' });

  const vlan = VLANS.find(v => v.id === +vlanId);
  if (!vlan) return res.status(400).json({ error: 'Unknown VLAN.' });
  if (!isInSubnet(ip, vlan.subnet, vlan.cidr))
    return res.status(400).json({ error: `${ip} is not within ${vlan.subnet}/${vlan.cidr}.` });

  const data = readJSON(DB, []);
  if (data.find(e => e.ip === ip && e.vlanId === +vlanId))
    return res.status(409).json({ error: `${ip} is already assigned.` });

  const entry = {
    id: uid(), vlanId: +vlanId, ip,
    host: host || '', status: status || 'used',
    type: type || '', mac: mac || '', notes: notes || '',
    createdAt: new Date().toISOString(),
  };
  data.push(entry);
  writeJSON(DB, data);
  res.status(201).json(entry);
});

app.put('/api/entries/:id', (req, res) => {
  const data = readJSON(DB, []);
  const idx  = data.findIndex(e => e.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Entry not found.' });

  const { vlanId, ip, host, status, type, mac, notes } = req.body;
  const vlan = VLANS.find(v => v.id === +(vlanId || data[idx].vlanId));

  if (ip && vlan && !isInSubnet(ip, vlan.subnet, vlan.cidr))
    return res.status(400).json({ error: `${ip} is not within ${vlan.subnet}/${vlan.cidr}.` });
  if (ip && data.find(e => e.ip === ip && e.vlanId === +(vlanId || data[idx].vlanId) && e.id !== req.params.id))
    return res.status(409).json({ error: `${ip} is already assigned.` });

  data[idx] = {
    ...data[idx],
    ...(vlanId !== undefined && { vlanId: +vlanId }),
    ...(ip     !== undefined && { ip }),
    ...(host   !== undefined && { host }),
    ...(status !== undefined && { status }),
    ...(type   !== undefined && { type }),
    ...(mac    !== undefined && { mac }),
    ...(notes  !== undefined && { notes }),
    updatedAt: new Date().toISOString(),
  };
  writeJSON(DB, data);
  res.json(data[idx]);
});

app.delete('/api/entries/:id', (req, res) => {
  const data     = readJSON(DB, []);
  const filtered = data.filter(e => e.id !== req.params.id);
  if (filtered.length === data.length) return res.status(404).json({ error: 'Entry not found.' });
  writeJSON(DB, filtered);
  res.json({ success: true });
});

// ── API: Ping results ──────────────────────────────────────────────
// GET all results (optionally ?vlanId=X)
app.get('/api/ping-results', (req, res) => {
  const results = readJSON(PING_DB, {});
  if (!req.query.vlanId) return res.json(results);

  const vlan = VLANS.find(v => v.id === +req.query.vlanId);
  if (!vlan) return res.status(400).json({ error: 'Unknown VLAN.' });

  const usableIPs = getUsableIPs(vlan.subnet, vlan.cidr);
  const filtered  = {};
  for (const ip of usableIPs) {
    if (results[ip]) filtered[ip] = results[ip];
  }
  res.json(filtered);
});

// GET scan state
app.get('/api/scan/status', (req, res) => {
  res.json(scanState);
});

// POST ping a single IP immediately
app.post('/api/ping', async (req, res) => {
  const { ip } = req.body;
  if (typeof ip !== 'string' || !isIPv4(ip))
    return res.status(400).json({ error: 'A valid IPv4 address is required.' });

  const settings = getSettings();
  const result   = await pingOne(ip, settings);
  const vlan = VLANS.find(v => isInSubnet(ip, v.subnet, v.cidr));
  const record   = { ip, ...(vlan && { vlanId: vlan.id }), ...result, checkedAt: new Date().toISOString() };

  const results = readJSON(PING_DB, {});
  results[ip]   = record;
  writeJSON(PING_DB, results);

  res.json(record);
});

// POST start full VLAN scan (or all VLANs if no vlanId)
app.post('/api/scan', async (req, res) => {
  if (scanState.running) {
    return res.status(409).json({ error: 'A scan is already in progress.' });
  }

  const vlanId   = req.body.vlanId ? +req.body.vlanId : null;
  const settings = getSettings();

  // Build IP list
  let targetVlans = vlanId ? VLANS.filter(v => v.id === vlanId) : VLANS;
  if (!targetVlans.length) return res.status(400).json({ error: 'Unknown VLAN.' });

  const ipList = []; // [{ ip, vlanId }]
  for (const v of targetVlans) {
    for (const ip of getUsableIPs(v.subnet, v.cidr)) {
      ipList.push({ ip, vlanId: v.id });
    }
  }

  scanState = {
    running:    true,
    vlanId:     vlanId,
    total:      ipList.length,
    done:       0,
    startedAt:  new Date().toISOString(),
    results:    { used: 0, timeout: 0, spare: 0, error: 0 },
  };

  res.json({ started: true, total: ipList.length });

  // Run scan async (after response is sent)
  const results = readJSON(PING_DB, {});

  sseEmit('scan-start', { total: ipList.length, vlanId });

  const tasks = ipList.map(({ ip, vlanId: vid }) => async () => {
    const r = await pingOne(ip, settings);
    const record = { ip, vlanId: vid, ...r, checkedAt: new Date().toISOString() };
    results[ip] = record;
    scanState.done++;
    scanState.results[r.pingStatus] = (scanState.results[r.pingStatus] || 0) + 1;

    sseEmit('scan-progress', {
      ip,
      vlanId:      vid,
      pingStatus:  r.pingStatus,
      pingResult:  r.pingResult,
      responseTime:r.responseTime,
      hostname:    r.hostname || null,
      mac:         r.mac || null,
      checkedAt:   record.checkedAt,
      done:        scanState.done,
      total:       scanState.total,
    });

    return record;
  });

  // Avoid flooding the gateway with probes: ICMP error replies may be throttled.
  const hasRoutedTargets = targetVlans.some(v => !isDirectlyConnected(v.subnet));
  const concurrency = Math.max(1, Math.min(
    Number(settings.concurrency) || DEFAULT_SETTINGS.concurrency,
    hasRoutedTargets ? 3 : 100
  ));
  await runWithConcurrency(tasks, concurrency, () => {});

  // Persist all results
  writeJSON(PING_DB, results);

  scanState.running   = false;
  scanState.finishedAt = new Date().toISOString();

  sseEmit('scan-done', {
    total:   scanState.total,
    results: scanState.results,
    vlanId,
    finishedAt: scanState.finishedAt,
  });
});

// ── SSE: live scan progress stream ─────────────────────────────────
app.get('/api/scan/stream', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Send current state immediately so client knows what's happening
  res.write(`event: connected\ndata: ${JSON.stringify(scanState)}\n\n`);

  sseClients.add(res);

  req.on('close', () => {
    sseClients.delete(res);
  });
});

// ── Catch-all → SPA ───────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n  ✅  IP Tracker running at http://localhost:${PORT}\n`);
});
