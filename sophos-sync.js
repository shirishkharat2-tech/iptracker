const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { isIPv4 } = require('node:net');

function mergeReservations(snapshot, existing, vlans, inSubnet) {
  if (!Array.isArray(snapshot.records) || !snapshot.serverCount || !snapshot.records.length)
    throw Error('Empty or invalid Sophos response; existing assignments retained.');
  const conflicts = [], seen = new Set(), accepted = [];
  for (const record of snapshot.records) {
    const matches = vlans.filter(v => isIPv4(record.ip) && inSubnet(record.ip, v.subnet, v.cidr));
    if (matches.length !== 1 || !/^([\da-f]{2}[:-]){5}[\da-f]{2}$/i.test(record.mac))
      throw Error('Invalid address, MAC or VLAN match; existing assignments retained.');
    if (seen.has(record.ip)) throw Error('Duplicate Sophos IP; existing assignments retained.');
    seen.add(record.ip);
    const manual = existing.find(e => e.ip === record.ip && e.source !== 'sophos');
    if (manual) { conflicts.push({ip:record.ip, reason:'Manual assignment preserved'}); continue; }
    const previous = existing.find(e => e.ip === record.ip && e.source === 'sophos');
    accepted.push({ ...previous, id:previous?.id || `sophos-${record.ip}`, vlanId:matches[0].id,
      ip:record.ip, mac:record.mac.toUpperCase(), host:record.host || '', status:'reserved',
      type:previous?.type || '', notes:previous?.notes || '', source:'sophos',
      dhcpServer:record.dhcpServer, sophosInterface:record.interface,
      sourceState:'current', syncedAt:snapshot.fetchedAt,
      createdAt:previous?.createdAt || snapshot.fetchedAt });
  }
  // Keep removed reservations for review instead of silently making IPs available.
  const missing = existing.filter(e => e.source === 'sophos' && !seen.has(e.ip))
    .map(e => ({...e, sourceState:'missing'}));
  return {entries:[...existing.filter(e => e.source !== 'sophos'), ...accepted, ...missing],
    imported:accepted.length, missing:missing.length, conflicts};
}

function installSophosSync(app, {vlans, inSubnet, db}) {
  const stateFile = path.join(__dirname, 'data/sophos-sync-state.json');
  const write = (file, value) => { fs.writeFileSync(file+'.tmp', JSON.stringify(value,null,2)); fs.renameSync(file+'.tmp',file); };
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(stateFile,'utf8')); } catch {}
  const state = {enabled:saved.enabled !== false, running:false, intervalMinutes:60,
    lastSuccess:saved.lastSuccess || null, imported:saved.imported || 0,
    conflicts:saved.conflicts || [], missing:saved.missing || 0, error:null, nextSync:null};
  let nextDue = Date.now();
  async function sync() {
    if (state.running) return;
    state.running = true; state.error = null;
    try {
      await new Promise((resolve,reject) => execFile('powershell.exe',
        ['-NoProfile','-NonInteractive','-File',path.join(__dirname,'scripts/preview-sophos.ps1')],
        {windowsHide:true,timeout:60000,maxBuffer:1024*1024,cwd:__dirname},
        error => error ? reject(Error('Sophos retrieval failed. Check connectivity, saved Windows credentials and certificate pin. Existing assignments retained.')) : resolve()));
      const snapshot = JSON.parse(fs.readFileSync(path.join(__dirname,'data/sophos-preview.json'),'utf8'));
      if (Date.now()-Date.parse(snapshot.fetchedAt)>120000 || !Number.isFinite(Date.parse(snapshot.fetchedAt))) throw Error('Preview is stale; import cancelled.');
      const existing = JSON.parse(fs.readFileSync(db,'utf8'));
      const result = mergeReservations(snapshot, existing, vlans, inSubnet);
      const backup = path.join(__dirname,'data/entries-before-sophos.json');
      if (!fs.existsSync(backup)) fs.copyFileSync(db,backup);
      write(db,result.entries);
      Object.assign(state,{lastSuccess:snapshot.fetchedAt,imported:result.imported,
        missing:result.missing,conflicts:result.conflicts,serverCount:snapshot.serverCount});
    } catch(error) { state.error = error.message; }
    finally {
      state.running = false; nextDue = Date.now()+3600000;
      state.nextSync = state.enabled ? new Date(nextDue).toISOString() : null;
      write(stateFile,state);
    }
  }
  app.get('/api/sophos/status', (_req,res) => res.json(state));
  app.post('/api/sophos/sync', (_req,res) => {
    if (state.running) return res.status(409).json({error:'Sophos sync already running.'});
    sync(); res.json({started:true});
  });
  app.put('/api/sophos/schedule', (req,res) => {
    if (typeof req.body.enabled !== 'boolean') return res.status(400).json({error:'enabled must be a boolean.'});
    state.enabled = req.body.enabled; nextDue = Date.now()+3600000;
    state.nextSync = state.enabled ? new Date(nextDue).toISOString() : null;
    write(stateFile,state); res.json(state);
  });
  const timer = setInterval(() => { if (state.enabled && !state.running && Date.now() >= nextDue) sync(); }, 5000);
  timer.unref();
}
module.exports = {installSophosSync,mergeReservations};
