(() => {
  let route = '', card, timer, loading = false;
  const number = n => Number(n).toLocaleString('zh-CN');
  const gb = n => `${(n / 1e9).toFixed(2)} GB`;
  const escape = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  async function refresh() {
    if (!card || loading || document.hidden) return;
    loading = true;
    try {
      const response = await fetch('/api/storage-summary',{credentials:'same-origin',cache:'no-store'});
      if (response.status === 401) { card.hidden=true; return; }
      card.hidden=false;
      if (!response.ok) throw new Error();
      const data = await response.json();
      const row = (label,used,total,format=number) => `<div class="storage-summary-row"><span>${label}</span><strong>${format(used)} / ${format(total)} · ${(used/total*100).toFixed(1)}%</strong><progress max="${total}" value="${Math.min(used,total)}"></progress></div>`;
      card.innerHTML = `<header><strong>存储与本月用量</strong><button type="button">刷新</button></header><p>${data.blocked?'服务暂不可用':'服务正常'} · 可上传容量 ${data.blocked?'暂不可用':data.storage.remaining===null?'待核对':gb(data.storage.remaining)}</p>`
        + (data.storage.used===null?'':row('容量（保护账本）',data.storage.used,data.storage.total,gb))
        + `<p>保护账本剩余：上传类 ${data.blocked?'暂不可用':number(data.remaining?.a??0)} 次 · 读取类 ${data.blocked?'暂不可用':number(data.remaining?.b??0)} 次</p>`
        + row('本月上传类操作（本地记录）',data.local.a,data.freeTier.a)
        + row('本月读取类操作（本地记录）',data.local.b,data.freeTier.b)
        + `<small>保护上限：8.5 GB / 上传类 85 万次 / 读取类 850 万次。操作次数不等于图片张数。<br>统计月份 ${escape(data.month)}（UTC） · 更新 ${escape(new Date(data.updatedAt).toLocaleString())}<br>本地记录可能不含接入前及其他程序用量；剩余容量按保守保护账本计算。${data.officialStale?' 云端统计待核对。':''}</small>`;
      card.querySelector('button').addEventListener('click',refresh);
    } catch { card.hidden=false; card.innerHTML='<strong>存储与本月用量</strong><p>暂时无法获取用量，请稍后再试。</p>'; }
    finally { loading=false; }
  }
  const style = document.createElement('style');
  style.textContent = '.storage-summary{box-sizing:border-box;max-width:960px;margin:18px auto;padding:18px 22px;border:1px solid #cbd5e155;border-radius:14px;background:var(--el-bg-color,#fff);color:var(--el-text-color-primary,#334155);font:14px/1.6 sans-serif}.storage-summary header{display:flex;justify-content:space-between;align-items:center}.storage-summary button{background:transparent;color:inherit;border:1px solid #94a3b866;border-radius:7px;padding:4px 12px;cursor:pointer}.storage-summary-row{display:grid;grid-template-columns:1fr auto;gap:4px 12px;margin:10px 0}.storage-summary progress{grid-column:1/-1;width:100%;height:7px;accent-color:#6c8cf5}.storage-summary small{display:block;opacity:.75;margin-top:12px}.dark .storage-summary{background:#20232b;color:#e2e8f0}@media(max-width:600px){.storage-summary{margin:12px}.storage-summary-row{grid-template-columns:1fr}.storage-summary-row strong{font-size:13px}}';
  document.head.append(style);
  function mount() {
    const path = location.pathname;
    if (!['/','/upload','/dashboard'].includes(path)) { card?.remove(); card=null; route=path; return; }
    if (route===path && card?.isConnected) return;
    const app = document.querySelector('#app');
    if (!app || app.hasAttribute('inert') || !app.children.length) return;
    card?.remove(); route=path;
    card=document.createElement('section'); card.className='storage-summary'; card.hidden=true; card.setAttribute('aria-label','存储与本月用量');
    const main = app.querySelector('main');
    (main || app).prepend(card); refresh();
    clearInterval(timer); timer=setInterval(refresh,300000);
  }
  new MutationObserver(mount).observe(document.querySelector('#app')||document.body,{childList:true,attributes:true,attributeFilter:['inert']});
  setInterval(mount,1500);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
  mount();
})();
