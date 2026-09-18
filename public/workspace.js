(() => {
  const sidebar = document.querySelector('.workspace-sidebar');
  window.updateWorkspace = () => {
    const target = document.getElementById('workspaceVlans');
    target.replaceChildren(...vlans.map(v => {
      const button = document.createElement('button');
      button.dataset.workspaceVlan = v.id;
      button.className = activeVlan?.id === v.id ? 'selected' : '';
      button.setAttribute('aria-label', `Go to VLAN ${v.id}, ${v.name}`);
      const dot = document.createElement('span'); dot.className = 'network-dot'; dot.style.background = v.color;
      const name = document.createElement('span'); name.textContent = v.name;
      const number = document.createElement('small'); number.textContent = String(v.id).padStart(2,'0');
      button.append(dot,name,number);
      return button;
    }));
  };
  sidebar.addEventListener('click', event => {
    const network = event.target.closest('[data-workspace-vlan]');
    const navigation = event.target.closest('[data-workspace]');
    if (!network && !navigation) return;
    sidebar.querySelectorAll('button').forEach(b => b.classList.remove('selected'));
    if (network) { showVlanDetail(Number(network.dataset.workspaceVlan)); updateWorkspace(); return; }
    showDashboard(); navigation.classList.add('selected');
    const destinations = {overview:'.overview-heading',vlans:'.section-header',sophos:'[aria-label="Sophos reservations"]',scans:'[aria-label="Scan all VLAN IPs"]'};
    document.querySelector(destinations[navigation.dataset.workspace]).scrollIntoView({block:'start'});
  });
  updateWorkspace();
})();
