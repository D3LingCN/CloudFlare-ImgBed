// R2保护扩展：A 方案白色可收缩用量侧栏，唯一维护入口见 docs/code-changes.md。
// /、/upload、/dashboard 使用登录会话读取 API；前端只展示，费用拦截全部由后端执行。
// 重建 frontend-dist 后需保留本文件和 index.html 的 script 引入，install.mjs 不会恢复侧栏。
(() => {
 let root,panel,trigger,content,loading=false,last=0,route="",authorized=false;
 const num=n=>Number(n).toLocaleString('zh-CN'), gb=n=>n<1e7?`${(n/1e6).toFixed(1)} MB`:`${(n/1e9).toFixed(2)} GB`;
 function close(){panel.hidden=true;trigger.setAttribute('aria-expanded','false');}
 function toggle(){panel.hidden=!panel.hidden;trigger.setAttribute('aria-expanded',String(!panel.hidden));if(!panel.hidden){refresh();panel.querySelector('button').focus();}}
 async function refresh(force=false){
  if(!root||loading||document.hidden||(!force&&Date.now()-last<300000))return;loading=true;
  try{
   const r=await fetch('/api/storage-summary',{credentials:'same-origin',cache:'no-store'});
   if(r.status===401){root.hidden=true;authorized=false;last=Date.now();return;}root.hidden=false;authorized=true;if(!r.ok)throw Error();
   const d=await r.json(),p=d.storage.used===null?null:d.storage.used/d.storage.total*100;
   const metric=(icon,label,used,total,format=num)=>`<div class="r2-metric"><div><span><i>${icon}</i>${label}</span><b>${(used/total*100).toFixed(1)}%</b></div><p>${format(used)} <em>/ ${format(total)}</em></p><progress aria-label="${label}" max="${total}" value="${Math.min(used,total)}"></progress></div>`;
   content.innerHTML=`<div class="r2-state ${d.blocked?'paused':''}"><span>● ${d.blocked?'服务暂不可用':'服务正常'}</span><small>${d.month} · 本月</small></div><div class="r2-storage"><div class="r2-ring" style="--used:${Math.min(p||0,100)}%"><b>${p===null?'—':p.toFixed(1)+'%'}</b></div><div><span>已用容量</span><strong>${d.storage.used===null?'待核对':gb(d.storage.used)}</strong><span>可上传 <b>${d.blocked?'暂不可用':gb(d.storage.remaining||0)}</b></span></div></div>`
    +(d.storage.used===null?'':metric('▱','存储容量',d.storage.used,d.storage.total,gb))+metric('↑','本月上传操作',d.local.a,d.freeTier.a)+metric('↓','本月读取操作',d.local.b,d.freeTier.b)
    +`<div class="r2-remaining">保护账本剩余操作<p>上传 <b>${d.blocked?'暂不可用':num(d.remaining?.a||0)}</b> · 读取 <b>${d.blocked?'暂不可用':num(d.remaining?.b||0)}</b></p></div><details><summary>统计说明</summary><p>保护上限为免费额度的 85%。容量按保守账本计算；本月操作为本地记录，可能不含接入前及其他程序用量。操作次数不等于图片张数，月份按 UTC 计算。${d.officialStale?'云端统计待核对。':''}</p></details><footer><span>◷ 更新 ${new Date(d.updatedAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}</span><button type="button" aria-label="刷新用量" title="刷新用量">↻</button></footer>`;
   content.querySelector('footer button').onclick=()=>refresh(true);last=Date.now();
  }catch{root.hidden=false;content.innerHTML='<div class="r2-empty">◷<p>暂时无法获取用量</p><small>请稍后再试</small><button type="button">重试</button></div>';content.querySelector('button').onclick=()=>refresh(true);last=Date.now();}finally{loading=false;}
 }
 const style=document.createElement('style');style.textContent=`
 #r2-usage-drawer{position:fixed;right:0;top:104px;bottom:32px;z-index:2050;pointer-events:none;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;color:#334155}
 #r2-usage-drawer [hidden]{display:none!important}#r2-usage-drawer button{font:inherit;cursor:pointer;color:inherit}#r2-usage-drawer button:focus-visible,#r2-usage-drawer summary:focus-visible{outline:3px solid #93b4ff;outline-offset:3px}
 .r2-trigger{pointer-events:auto;position:absolute;right:0;top:42%;display:flex;flex-direction:column;align-items:center;gap:8px;background:#fff;border:1px solid #dbe4ef;border-right:0;border-radius:16px 0 0 16px;padding:14px 11px;box-shadow:0 6px 24px #29446714;font-weight:600;color:#4674db!important}.r2-trigger:hover{background:#f1f6ff}.r2-trigger span{writing-mode:vertical-rl;letter-spacing:3px}.r2-trigger[aria-expanded=true]{right:340px}.r2-trigger[aria-expanded=true] b{transform:rotate(180deg)}
 .r2-panel{pointer-events:auto;box-sizing:border-box;width:340px;height:100%;max-height:800px;overflow:auto;background:#fff;border:1px solid #e2e8f0;border-right:0;border-radius:20px 0 0 20px;box-shadow:-12px 8px 40px #21365314;padding:24px;text-align:left}
 .r2-panel header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:22px}.r2-panel h2{font-size:18px;margin:0;font-weight:700;color:#172033}.r2-panel header button,.r2-panel footer button{border:0;background:transparent;border-radius:8px;padding:5px 10px;font-size:22px;color:#6f86ad!important}.r2-panel header button:hover,.r2-panel footer button:hover{background:#f0f5fc}
 .r2-state{display:flex;justify-content:space-between;align-items:center;font-size:12px;color:#16a075}.r2-state small{color:#94a3b8}.r2-state.paused{color:#bd802f}
 .r2-storage{display:flex;align-items:center;gap:20px;margin:26px 0 30px}.r2-storage>div:last-child{display:flex;flex-direction:column;gap:5px;font-size:12px;color:#7b8ba2}.r2-storage strong{font-size:23px;color:#203354;letter-spacing:-.6px}.r2-storage b{color:#385580}.r2-ring{width:84px;height:84px;border-radius:50%;background:conic-gradient(#5287f3 var(--used),#edf1f7 0);display:grid;place-items:center;position:relative;flex-shrink:0}.r2-ring:before{content:'';position:absolute;inset:8px;border-radius:50%;background:#fff}.r2-ring b{position:relative;font-size:17px;color:#334d76}
 .r2-metric{margin:23px 0}.r2-metric>div{display:flex;justify-content:space-between;gap:8px;font-size:13px}.r2-metric i{font-style:normal;display:inline-grid;place-items:center;width:22px;color:#5c83d4;margin-right:6px}.r2-metric b{font-size:12px;color:#7b8ba2;font-weight:500}.r2-metric p{margin:8px 0 8px 28px;font-size:13px;font-weight:600;color:#314669}.r2-metric em{font-style:normal;font-weight:400;color:#96a0b0}.r2-metric progress{display:block;appearance:none;width:100%;height:7px;border:0;border-radius:10px;overflow:hidden;background:#edf1f7;accent-color:#5287f3}.r2-metric progress::-webkit-progress-bar{background:#edf1f7;border-radius:10px}.r2-metric progress::-webkit-progress-value{background:#5287f3;border-radius:10px}
 .r2-remaining{border-radius:12px;background:#f7f9fc;padding:12px 14px;font-size:11px;color:#8290a4}.r2-remaining p{margin:5px 0 0;color:#536784}.r2-remaining b{font-weight:500}.r2-panel details{margin-top:18px;font-size:11px;color:#94a3b8}.r2-panel summary{cursor:pointer}.r2-panel details p{line-height:1.7}.r2-panel footer{border-top:1px solid #eef2f7;display:flex;justify-content:space-between;align-items:center;margin-top:20px;padding-top:12px;font-size:11px;color:#94a3b8}.r2-empty{text-align:center;padding:40px 0;color:#8290a4}.r2-empty button{display:block;margin:20px auto;background:#f0f5fc;border:0;border-radius:8px;padding:8px 18px}
 @media(max-width:480px){#r2-usage-drawer{top:78px;bottom:18px}.r2-panel{width:calc(100vw - 48px);padding:20px}.r2-trigger[aria-expanded=true]{right:calc(100vw - 48px)}}`;
 document.head.append(style);
 function mount(){
  if(!['/','/upload','/dashboard'].includes(location.pathname)){if(root)root.hidden=true;return;}
  if(!root){root=document.createElement('div');root.id='r2-usage-drawer';root.hidden=true;root.innerHTML='<button type="button" class="r2-trigger" aria-label="展开或收起用量" aria-expanded="false" aria-controls="r2-drawer-panel" title="展开或收起用量">▱<span>用量</span><b>‹</b></button><aside class="r2-panel" id="r2-drawer-panel" aria-label="存储与本月用量" hidden><header><h2>存储与用量</h2><button type="button" aria-label="收起用量">›</button></header><div class="r2-content">正在获取用量…</div></aside>';document.body.append(root);panel=root.querySelector('aside');trigger=root.querySelector('.r2-trigger');content=root.querySelector('.r2-content');trigger.onclick=toggle;panel.querySelector('header button').onclick=()=>{close();trigger.focus();};}
  root.hidden=!authorized;const changed=route!==location.pathname;route=location.pathname;if(changed||Date.now()-last>=300000)refresh(changed);
 }
 document.addEventListener('keydown',e=>{if(e.key==='Escape'&&panel&&!panel.hidden){close();trigger.focus();}});document.addEventListener('visibilitychange',()=>{if(!document.hidden)mount();});
 setInterval(mount,5000);setInterval(()=>{if(panel&&!panel.hidden)refresh();},300000);mount();
})();
