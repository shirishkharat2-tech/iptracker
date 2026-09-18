(() => {
  const button = document.getElementById('sophosSync');
  const auto = document.getElementById('sophosAuto');
  const status = document.getElementById('sophosStatus');
  let polling = false, lastSuccess = null, pending = false;
  async function refresh() {
    if (polling) return;
    polling = true;
    try {
      const state = await apiFetch('/api/sophos/status');
      button.disabled = state.running || pending;
      button.textContent = state.running ? 'Syncing…' : 'Sync Now';
      auto.checked = state.enabled;
      status.textContent = state.error ? `Sync failed: ${state.error}` : state.running
        ? 'Reading DHCP reservations from Sophos…'
        : state.lastSuccess ? `${state.imported} reservations · ${state.serverCount || 11} DHCP configurations · Last synced ${new Date(state.lastSuccess).toLocaleString()}${state.nextSync ? ` · Next ${new Date(state.nextSync).toLocaleTimeString()}` : ' · Automatic sync paused'}`
        : 'Ready for the first sync.';
      const conflicts = state.conflicts || [];
      document.getElementById('sophosIssues').hidden = !conflicts.length && !state.missing;
      document.getElementById('sophosIssueText').textContent =
        `${state.missing || 0} previously imported reservations are now missing from Sophos and have been retained for review. `+
        conflicts.map(c => `${c.ip}: ${c.reason}`).join('; ');
      if (state.lastSuccess && state.lastSuccess !== lastSuccess) {
        await loadAll();
        if (activeVlan) {
          activeVlan = vlans.find(v => v.id === activeVlan.id);
          renderVlanHero(); renderScanMeta(); renderDetail();
        } else renderDashboard();
        lastSuccess = state.lastSuccess;
      }
    } catch { status.textContent = 'Unable to reach the Sophos connector. Retrying…'; button.disabled = true; }
    finally { polling = false; }
  }
  button.disabled = true;
  button.addEventListener('click', async () => {
    pending = true; button.disabled = true;
    try { await apiFetch('/api/sophos/sync', {method:'POST',body:'{}'}); }
    catch(error) { toast(error.message,'error'); }
    finally { pending = false; refresh(); }
  });
  auto.addEventListener('change', async () => {
    auto.disabled = true;
    try { await apiFetch('/api/sophos/schedule',{method:'PUT',body:JSON.stringify({enabled:auto.checked})}); }
    catch(error) { toast(error.message,'error'); }
    finally { auto.disabled = false; refresh(); }
  });
  refresh(); setInterval(refresh,3000);
})();
