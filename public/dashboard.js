const themeChoice = document.getElementById('themeChoice');
document.getElementById('vlanGrid').addEventListener('keydown', e => {
  const card = e.target.closest('[data-vid]');
  if (card && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); card.click(); }
});

const allScanButton = document.getElementById('scanAllVlans');
let dashboardScanWasRunning = false;
let dashboardScanPending = false;
let dashboardScanPolling = false;

async function updateDashboardScan() {
  if (dashboardScanPolling) return;
  dashboardScanPolling = true;
  try {
    const state = await apiFetch('/api/scan/status');
    const percent = state.total ? Math.round(state.done / state.total * 100) : 0;
    allScanButton.disabled = state.running || dashboardScanPending;
    allScanButton.textContent = state.running ? 'Scan in progress…' : 'Scan All VLAN IPs';
    const scope = state.vlanId ? `VLAN ${state.vlanId}` : 'All VLANs';
    document.getElementById('allScanStatus').textContent = state.running
      ? `${scope} · ${state.done.toLocaleString()} / ${state.total.toLocaleString()} IPs checked (${percent}%)`
      : state.finishedAt ? `${scope} · Completed ${new Date(state.finishedAt).toLocaleString()} · ${state.done.toLocaleString()} IPs checked`
      : 'Ready to scan all VLANs. Network, gateway and broadcast addresses are excluded.';
    document.getElementById('allScanFill').style.width = `${percent}%`;
    document.getElementById('allScanTrack').setAttribute('aria-valuenow', percent);
    const counts = state.results;
    document.getElementById('allScanResults').textContent = counts
      ? `Used: ${counts.used || 0} · Spare: ${counts.spare || 0} · Timeout: ${counts.timeout || 0}` : '';
    if (dashboardScanWasRunning && !state.running) {
      await loadAll();
      if (!activeVlan) renderDashboard();
    }
    dashboardScanWasRunning = state.running;
  } catch {
    allScanButton.disabled = true;
    document.getElementById('allScanStatus').textContent = 'Unable to reach the server. Reconnecting…';
  } finally { dashboardScanPolling = false; }
}

allScanButton.disabled = true;
allScanButton.addEventListener('click', async () => {
  dashboardScanPending = true;
  allScanButton.disabled = true;
  try {
    await apiFetch('/api/scan', { method: 'POST', body: JSON.stringify({}) });
    dashboardScanWasRunning = true;
    toast('Scan started for all VLANs', 'success');
  } catch (error) { toast(error.message, 'error'); }
  finally { dashboardScanPending = false; await updateDashboardScan(); }
});
updateDashboardScan();
setInterval(updateDashboardScan, 2000);
themeChoice.value = window.selectedTheme;
themeChoice.addEventListener('change', () => { window.selectedTheme = applyTheme(themeChoice.value); });
for (const id of ['vlanScope', 'vlanSort']) document.getElementById(id).addEventListener('change', renderVlanCards);
document.getElementById('refreshData').addEventListener('click', async e => {
  const button = e.currentTarget;
  button.disabled = true;
  try {
    await loadAll();
    if (activeVlan) {
      activeVlan = vlans.find(v => v.id === activeVlan.id);
      renderVlanHero(); renderScanMeta(); renderDetail();
    } else renderDashboard();
    toast('Network data refreshed', 'success');
  } catch { toast('Could not refresh network data. Please try again.', 'error'); }
  finally { button.disabled = false; }
});
