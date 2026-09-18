(() => {
  const allowed = ['system', 'light', 'dark', 'ocean'];
  window.applyTheme = choice => {
    const selected = allowed.includes(choice) ? choice : 'system';
    const resolved = selected === 'system'
      ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : selected;
    document.documentElement.dataset.theme = resolved;
    document.documentElement.style.colorScheme = resolved === 'light' ? 'light' : 'dark';
    try { localStorage.setItem('ip-tracker-dashboard-theme-v2', selected); } catch {}
    return selected;
  };
  let initial = 'dark';
  try { initial = localStorage.getItem('ip-tracker-dashboard-theme-v2') || initial; } catch {}
  window.selectedTheme = applyTheme(initial);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (window.selectedTheme === 'system') applyTheme('system');
  });
})();
