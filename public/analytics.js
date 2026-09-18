(() => {
  let time = {now:Date.now(),source:'browser-fallback',timezone:'Asia/Kolkata'}, base=performance.now();
  function tick() {
    const now = new Date(time.now + performance.now()-base);
    const hour = Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Kolkata',hour:'2-digit',hourCycle:'h23'}).format(now));
    document.getElementById('aitGreeting').textContent = `Good ${hour>=5 && hour<12?'Morning':hour>=12 && hour<17?'Afternoon':'Evening'}, AIT`;
    document.getElementById('aitClock').textContent = new Intl.DateTimeFormat('en-IN',{timeZone:'Asia/Kolkata',weekday:'short',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(now);
    document.getElementById('timeSource').textContent = time.source==='ntp'?'NTP synchronized · India Standard Time':time.source==='server-fallback'?'Server time · NTP unavailable · IST':'Browser time · Server unavailable · IST';
  }
  async function refreshTime() {
    try { const result=await apiFetch('/api/time');if(!Number.isFinite(result.now))throw Error();time=result;base=performance.now(); }
    catch {time={now:Date.now(),source:'browser-fallback'};base=performance.now();}
    tick();
  }
  window.renderAllocationChart=()=>{
    const target=document.getElementById('allocationChart');
    target.replaceChildren(...vlans.map(v=>{
      const button=document.createElement('button');button.className='allocation-row';
      const count=v.used+v.reserved, percent=v.usable?Math.min(100,count/v.usable*100):0;
      button.setAttribute('aria-label',`${v.name}, VLAN ${v.id}, ${count} of ${v.usable} assigned. Open VLAN`);
      const name=document.createElement('span');name.textContent=v.name;
      const track=document.createElement('span');track.className='allocation-track';
      const fill=document.createElement('i');fill.style.width=percent+'%';track.append(fill);
      const total=document.createElement('span');total.className='allocation-count';total.textContent=`${count} / ${v.usable}`;
      button.append(name,track,total);button.addEventListener('click',()=>showVlanDetail(v.id));return button;
    }));
  };
  renderAllocationChart();refreshTime();setInterval(tick,1000);setInterval(refreshTime,60000);
})();
