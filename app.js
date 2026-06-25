/* =========================================================================
   Reflexos Diários — notas em rede (PWA) com login + sincronização (Supabase)
   Armazenamento local: IndexedDB (offline-first). Nuvem: Supabase Postgres.
   ========================================================================= */

const DB_NAME='reflexos-db', DB_VER=1;
let db, notes=[], settings={}, currentId=null, currentView='daily';
let viewMode='edit';
let calMonth=new Date().getFullYear()*12+new Date().getMonth();
let saveTimer=null, graphAnim=null;

/* ---------- IndexedDB ---------- */
function openDB(){return new Promise((res,rej)=>{
  const r=indexedDB.open(DB_NAME,DB_VER);
  r.onupgradeneeded=e=>{const d=e.target.result;
    if(!d.objectStoreNames.contains('notes'))d.createObjectStore('notes',{keyPath:'id'});
    if(!d.objectStoreNames.contains('settings'))d.createObjectStore('settings',{keyPath:'k'});
  };
  r.onsuccess=e=>{db=e.target.result;res()};
  r.onerror=e=>rej(e);
});}
function tx(store,mode){return db.transaction(store,mode).objectStore(store);}
function dbAll(store){return new Promise(res=>{const out=[];const c=tx(store,'readonly').openCursor();
  c.onsuccess=e=>{const cur=e.target.result;if(cur){out.push(cur.value);cur.continue()}else res(out)};});}
function dbPut(store,val){return new Promise(res=>{tx(store,'readwrite').put(val).onsuccess=()=>res();});}
function dbDel(store,key){return new Promise(res=>{tx(store,'readwrite').delete(key).onsuccess=()=>res();});}
async function setSetting(k,v){settings[k]=v;await dbPut('settings',{k,v});}

/* ---------- Utils ---------- */
const uid=()=>Date.now().toString(36)+Math.random().toString(36).slice(2,7);
const esc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const now=()=>Date.now();
function fmtDate(ts){const d=new Date(ts);return d.toLocaleDateString('pt-BR',{day:'2-digit',month:'short'});}
function relTime(ts){const s=(now()-ts)/1000;
  if(s<60)return'agora';if(s<3600)return Math.floor(s/60)+'min';
  if(s<86400)return Math.floor(s/3600)+'h';if(s<604800)return Math.floor(s/86400)+'d';
  return fmtDate(ts);}
function toast(msg){const t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');
  clearTimeout(t._t);t._t=setTimeout(()=>t.classList.remove('show'),1900);}
function slug(s){return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'')
  .replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'')||'nota';}
const dayKey=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;

/* ---------- Note model ---------- */
function noteByTitle(t){const k=t.trim().toLowerCase();return notes.find(n=>n.title.trim().toLowerCase()===k);}
function noteById(id){return notes.find(n=>n.id===id);}
async function saveNote(n){n.updated=now();await dbPut('notes',n);queuePush(n);}

async function createNote(title,opts={}){
  const n={id:uid(),title:title||'Nota sem título',content:opts.content||'',
    folder:opts.folder||'',isDaily:!!opts.isDaily,dayKey:opts.dayKey||null,
    created:now(),updated:now()};
  notes.push(n);await dbPut('notes',n);queuePush(n);return n;
}
async function getOrCreateByTitle(title){
  let n=noteByTitle(title);
  if(!n){n=await createNote(title);toast('Nota "'+title+'" criada');}
  return n;
}
async function getTodayDaily(dateObj){
  const d=dateObj||new Date();const key=dayKey(d);
  let n=notes.find(x=>x.isDaily&&x.dayKey===key);
  if(!n){const title=d.toLocaleDateString('pt-BR',{day:'2-digit',month:'long',year:'numeric'});
    n=await createNote(title,{isDaily:true,dayKey:key,folder:'Diário',content:''});}
  return n;
}

function extractLinks(text){const out=[];const re=/\[\[([^\]]+)\]\]/g;let m;
  while((m=re.exec(text)))out.push(m[1].split('|')[0].trim());return out;}
function extractTags(text){const out=new Set();
  const re=/(^|[\s(])#([a-zA-Z0-9_À-ſ\/-]+)/g;let m;
  while((m=re.exec(text)))out.add(m[2]);return [...out];}
function backlinksFor(note){
  const k=note.title.trim().toLowerCase();
  return notes.filter(n=>n.id!==note.id && extractLinks(n.content).some(l=>l.toLowerCase()===k));
}

/* ---------- Markdown renderer (mini) ---------- */
function renderMarkdown(src){
  const codeBlocks=[];
  src=src.replace(/```([\s\S]*?)```/g,(_,c)=>{codeBlocks.push(c.replace(/^\n/,''));return`  CB${codeBlocks.length-1}  `;});
  const lines=src.split('\n');let html='',i=0;
  const inline=t=>{
    t=esc(t);
    t=t.replace(/`([^`]+)`/g,(_,c)=>`<code>${c}</code>`);
    t=t.replace(/\[\[([^\]]+)\]\]/g,(_,raw)=>{
      const parts=raw.split('|');const tgt=parts[0].trim();const label=(parts[1]||parts[0]).trim();
      const exists=!!noteByTitle(tgt);
      return`<span class="wikilink${exists?'':' missing'}" data-link="${esc(tgt)}">${esc(label)}</span>`;});
    t=t.replace(/(^|[\s(])#([a-zA-Z0-9_À-ſ\/-]+)/g,(m,p,tag)=>`${p}<span class="tagchip" data-tag="${esc(tag)}">#${esc(tag)}</span>`);
    t=t.replace(/\[([^\]]+)\]\(([^)]+)\)/g,(_,txt,url)=>`<a href="${esc(url)}" target="_blank" rel="noopener">${txt}</a>`);
    t=t.replace(/(\*\*|__)(.+?)\1/g,'<strong>$2</strong>');
    t=t.replace(/(\*|_)(.+?)\1/g,'<em>$2</em>');
    t=t.replace(/~~(.+?)~~/g,'<del>$1</del>');
    return t;
  };
  while(i<lines.length){
    let ln=lines[i];
    if(/^CB\d+$/.test(ln.trim())){const idx=+ln.trim().match(/\d+/)[0];
      html+=`<pre><code>${esc(codeBlocks[idx])}</code></pre>`;i++;continue;}
    if(/^\s*$/.test(ln)){i++;continue;}
    let h=ln.match(/^(#{1,6})\s+(.*)$/);
    if(h){const lv=h[1].length;html+=`<h${lv}>${inline(h[2])}</h${lv}>`;i++;continue;}
    if(/^\s*>/.test(ln)){let buf=[];while(i<lines.length&&/^\s*>/.test(lines[i])){buf.push(lines[i].replace(/^\s*>\s?/,''));i++;}
      html+=`<blockquote>${inline(buf.join(' '))}</blockquote>`;continue;}
    if(/^\s*(-{3,}|\*{3,})\s*$/.test(ln)){html+='<hr>';i++;continue;}
    if(/\|/.test(ln)&&i+1<lines.length&&/^\s*\|?[-:\s|]+\|[-:\s|]+$/.test(lines[i+1])){
      const cut=row=>row.split('|').map(s=>s.trim()).filter((s,idx,a)=>!(idx===0&&s==='')&&!(idx===a.length-1&&s===''));
      const head=cut(ln);i+=2;let rows=[];
      while(i<lines.length&&/\|/.test(lines[i])&&lines[i].trim()){rows.push(cut(lines[i]));i++;}
      html+='<table><thead><tr>'+head.map(c=>`<th>${inline(c)}</th>`).join('')+'</tr></thead><tbody>'+
        rows.map(r=>'<tr>'+r.map(c=>`<td>${inline(c)}</td>`).join('')+'</tr>').join('')+'</tbody></table>';
      continue;}
    if(/^\s*([-*+]|\d+\.)\s+/.test(ln)){
      const ordered=/^\s*\d+\.\s+/.test(ln);let buf=[];
      while(i<lines.length&&/^\s*([-*+]|\d+\.)\s+/.test(lines[i])){
        let item=lines[i].replace(/^\s*([-*+]|\d+\.)\s+/,'');
        const cb=item.match(/^\[([ xX])\]\s+(.*)$/);
        if(cb)item=`<input type="checkbox" disabled ${/[xX]/.test(cb[1])?'checked':''}>${inline(cb[2])}`;
        else item=inline(item);
        buf.push(`<li>${item}</li>`);i++;}
      html+=ordered?`<ol>${buf.join('')}</ol>`:`<ul>${buf.join('')}</ul>`;continue;}
    let buf=[ln];i++;
    while(i<lines.length&&!/^\s*$/.test(lines[i])&&!/^(#{1,6}\s|\s*>|\s*([-*+]|\d+\.)\s|```)/.test(lines[i])
      &&!/^CB\d+$/.test(lines[i].trim())){buf.push(lines[i]);i++;}
    html+=`<p>${inline(buf.join('\n')).replace(/\n/g,'<br>')}</p>`;
  }
  return html;
}

/* ---------- Sidebar list ---------- */
function setActiveNav(v){document.querySelectorAll('.nav button').forEach(b=>b.classList.toggle('active',b.dataset.view===v));}
function renderNoteList(){
  const wrap=document.getElementById('noteList');
  const label=document.getElementById('listLabel');
  let items=[...notes];
  if(currentView==='daily'){label.textContent='Páginas de diário';
    items=items.filter(n=>n.isDaily).sort((a,b)=>b.dayKey<a.dayKey?-1:1);}
  else{label.textContent='Notas recentes';items=items.sort((a,b)=>b.updated-a.updated);}
  if(!items.length){wrap.innerHTML='<div style="padding:14px;color:var(--text-3);font-size:12.5px">Nenhuma nota ainda.</div>';return;}

  if(currentView==='all' && settings.groupByFolder){
    const groups={};items.forEach(n=>{(groups[n.folder||'Sem pasta']=groups[n.folder||'Sem pasta']||[]).push(n);});
    const collapsed=settings.collapsedFolders||{};
    wrap.innerHTML=Object.keys(groups).sort().map(f=>{
      const isC=collapsed[f];
      return`<div class="folder-row ${isC?'collapsed':''}" data-folder="${esc(f)}">
        <span class="caret">▾</span> 📁 ${esc(f)} <span style="color:var(--text-3);font-weight:500">${groups[f].length}</span></div>
        <div class="folder-notes" style="${isC?'display:none':''}">${groups[f].map(noteItemHTML).join('')}</div>`;
    }).join('');
  }else{
    wrap.innerHTML=items.map(noteItemHTML).join('');
  }
  wrap.querySelectorAll('.note-item').forEach(el=>el.onclick=()=>openNote(el.dataset.id));
  wrap.querySelectorAll('.folder-row').forEach(el=>el.onclick=()=>{
    const f=el.dataset.folder;settings.collapsedFolders=settings.collapsedFolders||{};
    settings.collapsedFolders[f]=!settings.collapsedFolders[f];setSetting('collapsedFolders',settings.collapsedFolders);renderNoteList();});
}
function noteItemHTML(n){
  const tags=extractTags(n.content);
  return`<div class="note-item ${n.id===currentId&&(currentView==='daily'||currentView==='all')?'active':''}" data-id="${n.id}">
    <div class="ti">${n.isDaily?'📅 ':''}${esc(n.title)}</div>
    <div class="me">${relTime(n.updated)}${tags.length?' · #'+esc(tags[0]):''}</div></div>`;
}

/* ---------- Open / render note ---------- */
function openNote(id){
  const n=noteById(id);if(!n)return;
  currentId=id;
  if(currentView!=='daily'){currentView='all';setActiveNav('all');}
  renderEditor(n);renderNoteList();closeMobileSidebar();
  document.querySelectorAll('.topbar .tb-btn').forEach(b=>b.style.display='');
}
function renderEditor(n){
  document.getElementById('crumb').textContent=(n.folder?n.folder+' / ':'')+n.title;
  const c=document.getElementById('content');
  const folders=[...new Set(notes.map(x=>x.folder).filter(Boolean))];
  c.innerHTML=`<div class="editor-page">
    <input id="titleInput" value="${esc(n.title)}" placeholder="Título da nota…" ${n.isDaily?'readonly':''}>
    <div class="meta-bar">
      <span>Editado ${relTime(n.updated)}</span><span>·</span>
      <label>📁 <select id="folderSel">
        <option value="">Sem pasta</option>
        ${folders.map(f=>`<option value="${esc(f)}" ${f===n.folder?'selected':''}>${esc(f)}</option>`).join('')}
        <option value="__new">+ Nova pasta…</option>
      </select></label>
    </div>
    <div class="split ${viewMode==='preview'?'preview-mode':viewMode==='split'?'split-mode':''}" id="split">
      <textarea id="editor" placeholder="Escreva livremente…  Use [[Nome da Nota]] para conectar ideias e #tags para organizar.">${esc(n.content)}</textarea>
      <div id="preview" class="md"></div>
    </div>
    <div class="backlinks" id="backlinks"></div>
  </div>`;
  const ed=document.getElementById('editor');
  const ti=document.getElementById('titleInput');
  updatePreview();renderBacklinks(n);
  ed.addEventListener('input',()=>{n.content=ed.value;scheduleSave(n);updatePreview();});
  ed.addEventListener('keydown',e=>{if(e.key==='Tab'){e.preventDefault();
    const s=ed.selectionStart,en=ed.selectionEnd;ed.value=ed.value.slice(0,s)+'  '+ed.value.slice(en);
    ed.selectionStart=ed.selectionEnd=s+2;n.content=ed.value;scheduleSave(n);updatePreview();}});
  ti.addEventListener('input',()=>{n.title=ti.value||'Nota sem título';
    scheduleSave(n);document.getElementById('crumb').textContent=(n.folder?n.folder+' / ':'')+n.title;});
  ti.addEventListener('blur',()=>{renderNoteList();renderBacklinks(n);});
  document.getElementById('folderSel').addEventListener('change',async e=>{
    if(e.target.value==='__new'){const name=await promptModal('Nova pasta','Nome da pasta:','');
      if(name){n.folder=name;await saveNote(n);renderEditor(n);renderNoteList();}else e.target.value=n.folder;}
    else{n.folder=e.target.value;await saveNote(n);renderNoteList();
      document.getElementById('crumb').textContent=(n.folder?n.folder+' / ':'')+n.title;}});
}
function updatePreview(){
  const ed=document.getElementById('editor');if(!ed)return;
  const pv=document.getElementById('preview');
  pv.innerHTML=renderMarkdown(ed.value)||'<p style="color:var(--text-3)">Nada para visualizar ainda…</p>';
  pv.querySelectorAll('.wikilink').forEach(el=>el.onclick=async()=>{const t=await getOrCreateByTitle(el.dataset.link);openNote(t.id);});
  pv.querySelectorAll('.tagchip').forEach(el=>el.onclick=()=>showView('tags',el.dataset.tag));
}
function scheduleSave(n){clearTimeout(saveTimer);saveTimer=setTimeout(async()=>{await saveNote(n);
  if(currentView==='daily')renderNoteList();},450);}

function renderBacklinks(n){
  const wrap=document.getElementById('backlinks');if(!wrap)return;
  const bl=backlinksFor(n);
  if(!bl.length){wrap.innerHTML='<h4>🔗 Menções (backlinks)</h4><div style="color:var(--text-3);font-size:13px">Nenhuma outra nota menciona esta ainda. Use <code>[['+esc(n.title)+']]</code> em outra nota para conectar.</div>';return;}
  wrap.innerHTML='<h4>🔗 Menções · '+bl.length+'</h4>'+bl.map(b=>{
    const k=n.title.trim().toLowerCase();
    const idx=b.content.toLowerCase().indexOf('[['+k);
    let ctx=b.content;
    if(idx>=0){const s=Math.max(0,idx-40);ctx=(s>0?'…':'')+b.content.slice(s,idx+k.length+60);}
    ctx=esc(ctx.slice(0,180)).replace(/\[\[([^\]]+)\]\]/g,'<mark>$1</mark>');
    return`<div class="bl-card" data-id="${b.id}"><div class="bt">${esc(b.title)}</div><div class="bc">${ctx}</div></div>`;
  }).join('');
  wrap.querySelectorAll('.bl-card').forEach(el=>el.onclick=()=>openNote(el.dataset.id));
}

/* ---------- Views ---------- */
function showView(view,arg){
  currentView=view;setActiveNav(view);
  document.querySelectorAll('.topbar .tb-btn').forEach(b=>b.style.display=(view==='daily'||view==='all')?'':'none');
  if(view==='daily'){renderDaily();}
  else if(view==='all'){renderAll();}
  else if(view==='tags'){renderTags(arg);}
  else if(view==='graph'){renderGraph();}
  renderNoteList();closeMobileSidebar();
}

async function renderDaily(){
  document.getElementById('crumb').textContent='Diário';
  const cur=noteById(currentId);
  const today=(cur&&cur.isDaily)?cur:await getTodayDaily();
  currentId=today.id;
  renderEditor(today);
  const page=document.querySelector('.editor-page');
  const cal=document.createElement('div');cal.id='calMount';
  page.insertBefore(cal,page.firstChild);
  mountCalendar(cal);
  renderNoteList();
}
function mountCalendar(mount){
  const y=Math.floor(calMonth/12),mo=calMonth%12;
  const first=new Date(y,mo,1);const start=first.getDay();
  const days=new Date(y,mo+1,0).getDate();
  const todayK=dayKey(new Date());
  const dailySet=new Set(notes.filter(n=>n.isDaily).map(n=>n.dayKey));
  const curN=noteById(currentId);const selK=curN&&curN.isDaily?curN.dayKey:null;
  const monName=first.toLocaleDateString('pt-BR',{month:'long',year:'numeric'});
  let cells='';for(let i=0;i<start;i++)cells+='<div class="cal-day empty"></div>';
  for(let d=1;d<=days;d++){const k=`${y}-${String(mo+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    cells+=`<div class="cal-day ${k===todayK?'today':''} ${dailySet.has(k)?'has':''} ${k===selK?'sel':''}" data-k="${k}">${d}</div>`;}
  mount.innerHTML=`<div class="cal"><div class="cal-head">
    <button id="calPrev">‹</button><span class="m">${monName}</span><button id="calNext">›</button></div>
    <div class="cal-grid">${['D','S','T','Q','Q','S','S'].map(x=>`<span class="dow">${x}</span>`).join('')}${cells}</div></div>`;
  mount.querySelector('#calPrev').onclick=()=>{calMonth--;mountCalendar(mount);};
  mount.querySelector('#calNext').onclick=()=>{calMonth++;mountCalendar(mount);};
  mount.querySelectorAll('.cal-day[data-k]').forEach(el=>el.onclick=async()=>{
    const[Y,M,D]=el.dataset.k.split('-').map(Number);
    const n=await getTodayDaily(new Date(Y,M-1,D));currentId=n.id;showView('daily');});
}

function renderAll(){
  document.getElementById('crumb').textContent='Todas as notas';
  const list=[...notes].sort((a,b)=>b.updated-a.updated);
  const c=document.getElementById('content');
  if(!list.length){c.innerHTML=emptyState('📝','Nenhuma nota ainda','Clique em ＋ para criar sua primeira nota.');return;}
  c.innerHTML=`<div class="page"><h1>Todas as notas</h1>
    <div class="lead">${list.length} nota${list.length>1?'s':''} · clique para abrir
      &nbsp;·&nbsp;<label style="cursor:pointer"><input type="checkbox" id="grpFld" ${settings.groupByFolder?'checked':''}> agrupar por pasta na lateral</label></div>
    <div class="grid">${list.map(cardHTML).join('')}</div></div>`;
  c.querySelectorAll('.card').forEach(el=>el.onclick=()=>openNote(el.dataset.id));
  c.querySelector('#grpFld').onchange=e=>{setSetting('groupByFolder',e.target.checked);renderNoteList();};
}
function cardHTML(n){
  const tags=extractTags(n.content);
  const plain=n.content.replace(/[#*`>\[\]]/g,'').slice(0,140);
  return`<div class="card" data-id="${n.id}">
    <div class="ct">${n.isDaily?'📅 ':''}${esc(n.title)}</div>
    <div class="cx">${esc(plain)||'<span style="color:var(--text-3)">vazio</span>'}</div>
    <div class="cm"><span>${relTime(n.updated)}</span>${n.folder?'<span>📁 '+esc(n.folder)+'</span>':''}${tags.length?'<span style="color:var(--tag)">#'+esc(tags[0])+(tags.length>1?'+'+(tags.length-1):'')+'</span>':''}</div>
  </div>`;
}

function renderTags(focus){
  document.getElementById('crumb').textContent='Tags';
  const map={};notes.forEach(n=>extractTags(n.content).forEach(t=>{(map[t]=map[t]||[]).push(n);}));
  const tags=Object.keys(map).sort((a,b)=>map[b].length-map[a].length);
  const c=document.getElementById('content');
  if(!tags.length){c.innerHTML=emptyState('🏷️','Nenhuma tag ainda','Escreva #suatag dentro de qualquer nota para categorizá-la.');return;}
  const sel=(focus&&map[focus])?focus:tags[0];
  c.innerHTML=`<div class="page"><h1>Tags</h1><div class="lead">${tags.length} tags no seu jardim de ideias</div>
    <div class="tagcloud" style="margin-bottom:26px">${tags.map(t=>`<span class="tc" data-tag="${esc(t)}" style="${t===sel?'outline:2px solid var(--tag);outline-offset:1px':''}">#${esc(t)} <span class="n">${map[t].length}</span></span>`).join('')}</div>
    <h1 style="font-size:18px">#${esc(sel)}</h1><div class="lead">${(map[sel]||[]).length} nota(s)</div>
    <div class="grid">${(map[sel]||[]).map(cardHTML).join('')}</div></div>`;
  c.querySelectorAll('.tc').forEach(el=>el.onclick=()=>renderTags(el.dataset.tag));
  c.querySelectorAll('.card').forEach(el=>el.onclick=()=>openNote(el.dataset.id));
}

function emptyState(ico,t,s){return`<div class="empty"><div class="ico">${ico}</div><div style="font-weight:600;color:var(--text-2)">${t}</div><div style="margin-top:6px">${s}</div></div>`;}

/* ---------- Graph ---------- */
function renderGraph(){
  document.getElementById('crumb').textContent='Grafo de conexões';
  const c=document.getElementById('content');
  if(notes.length<1){c.innerHTML=emptyState('🕸️','Grafo vazio','Crie notas e conecte-as com [[links]] para ver a rede.');return;}
  c.innerHTML=`<div class="page" style="max-width:1100px"><h1>Grafo de conexões</h1>
    <div class="lead">Cada ponto é uma nota; as linhas são links [[ ]]. Arraste para explorar, clique num nó para abrir.</div>
    <div id="graphWrap"><canvas id="graph"></canvas><div class="graph-hint">arraste o fundo para mover · role para zoom · clique num nó para abrir</div></div></div>`;
  setupGraph();
}
function setupGraph(){
  const canvas=document.getElementById('graph');const ctx=canvas.getContext('2d');
  const wrap=document.getElementById('graphWrap');
  const dpr=window.devicePixelRatio||1;
  function size(){const r=wrap.getBoundingClientRect();canvas.width=r.width*dpr;canvas.height=r.height*dpr;
    canvas.style.width=r.width+'px';canvas.style.height=r.height+'px';ctx.setTransform(dpr,0,0,dpr,0,0);}
  size();
  const W=()=>canvas.width/dpr,H=()=>canvas.height/dpr;
  const nodes=notes.map((n,i)=>({id:n.id,t:n.title,daily:n.isDaily,
    x:W()/2+Math.cos(i)*120+Math.random()*40,y:H()/2+Math.sin(i)*120+Math.random()*40,vx:0,vy:0,deg:0}));
  const nmap={};nodes.forEach(n=>nmap[n.id]=n);
  const titleMap={};notes.forEach(n=>titleMap[n.title.trim().toLowerCase()]=n.id);
  const edges=[];notes.forEach(n=>{extractLinks(n.content).forEach(l=>{const tid=titleMap[l.toLowerCase()];
    if(tid&&tid!==n.id){edges.push([n.id,tid]);if(nmap[n.id])nmap[n.id].deg++;if(nmap[tid])nmap[tid].deg++;}});});
  let ox=0,oy=0,scale=1,dragNode=null,panning=false,lastX,lastY,moved=false;
  const css=getComputedStyle(document.body);
  function tick(){
    for(let i=0;i<nodes.length;i++){const a=nodes[i];
      for(let j=i+1;j<nodes.length;j++){const b=nodes[j];
        let dx=a.x-b.x,dy=a.y-b.y,d=Math.hypot(dx,dy)||1;
        const rep=2200/(d*d);a.vx+=dx/d*rep;a.vy+=dy/d*rep;b.vx-=dx/d*rep;b.vy-=dy/d*rep;}
      a.vx+=(W()/2-a.x)*0.0012;a.vy+=(H()/2-a.y)*0.0012;}
    edges.forEach(([s,t])=>{const a=nmap[s],b=nmap[t];if(!a||!b)return;
      let dx=b.x-a.x,dy=b.y-a.y,d=Math.hypot(dx,dy)||1;const f=(d-90)*0.012;
      a.vx+=dx/d*f;a.vy+=dy/d*f;b.vx-=dx/d*f;b.vy-=dy/d*f;});
    nodes.forEach(n=>{if(n===dragNode)return;n.vx*=.85;n.vy*=.85;n.x+=n.vx;n.y+=n.vy;});
    draw();graphAnim=requestAnimationFrame(tick);
  }
  function draw(){
    ctx.clearRect(0,0,W(),H());ctx.save();ctx.translate(ox,oy);ctx.scale(scale,scale);
    ctx.strokeStyle=css.getPropertyValue('--border')||'#ccc';ctx.lineWidth=1;
    edges.forEach(([s,t])=>{const a=nmap[s],b=nmap[t];if(!a||!b)return;
      ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();});
    nodes.forEach(n=>{const r=5+Math.min(n.deg*1.6,11);
      ctx.beginPath();ctx.arc(n.x,n.y,r,0,7);
      ctx.fillStyle=(n.daily?css.getPropertyValue('--tag'):css.getPropertyValue('--accent'))||'#7c5cff';ctx.fill();
      ctx.fillStyle=css.getPropertyValue('--text-2')||'#888';ctx.font='11px sans-serif';
      ctx.textAlign='center';ctx.fillText(n.t.length>22?n.t.slice(0,21)+'…':n.t,n.x,n.y+r+12);});
    ctx.restore();
  }
  function at(ev){const r=canvas.getBoundingClientRect();
    const x=(ev.clientX-r.left-ox)/scale,y=(ev.clientY-r.top-oy)/scale;
    return nodes.find(n=>Math.hypot(n.x-x,n.y-y)<(5+Math.min(n.deg*1.6,11)+4));}
  canvas.onmousedown=ev=>{moved=false;lastX=ev.clientX;lastY=ev.clientY;
    const n=at(ev);if(n){dragNode=n;}else panning=true;canvas.style.cursor='grabbing';};
  window.addEventListener('mousemove',onMove);
  function onMove(ev){
    if(dragNode){const r=canvas.getBoundingClientRect();dragNode.x=(ev.clientX-r.left-ox)/scale;dragNode.y=(ev.clientY-r.top-oy)/scale;dragNode.vx=0;dragNode.vy=0;moved=true;}
    else if(panning){ox+=ev.clientX-lastX;oy+=ev.clientY-lastY;lastX=ev.clientX;lastY=ev.clientY;moved=true;}}
  window.addEventListener('mouseup',()=>{
    if(dragNode&&!moved){openNode(dragNode);}
    dragNode=null;panning=false;canvas.style.cursor='grab';});
  canvas.onclick=ev=>{if(moved)return;const n=at(ev);if(n)openNode(n);};
  canvas.onwheel=ev=>{ev.preventDefault();const f=ev.deltaY<0?1.1:0.9;scale=Math.max(.3,Math.min(3,scale*f));};
  function openNode(n){if(graphAnim)cancelAnimationFrame(graphAnim);window.removeEventListener('mousemove',onMove);openNote(n.id);}
  if(graphAnim)cancelAnimationFrame(graphAnim);tick();
}

/* ---------- Search ---------- */
function doSearch(q){
  const box=document.getElementById('searchResults');
  q=q.trim().toLowerCase();
  if(!q){box.classList.remove('show');return;}
  const res=notes.map(n=>{
    const inT=n.title.toLowerCase().includes(q);
    const ci=n.content.toLowerCase().indexOf(q);
    const tagHit=extractTags(n.content).some(t=>t.toLowerCase().includes(q.replace('#','')));
    if(!inT&&ci<0&&!tagHit)return null;
    let ctx='';if(ci>=0){const s=Math.max(0,ci-30);ctx=(s>0?'…':'')+n.content.slice(s,ci+q.length+50);}
    return{n,inT,ctx,score:(inT?3:0)+(tagHit?2:0)+(ci>=0?1:0)};
  }).filter(Boolean).sort((a,b)=>b.score-a.score).slice(0,12);
  if(!res.length){box.innerHTML='<div class="sr-item"><div class="x">Nada encontrado para "'+esc(q)+'"</div></div>';box.classList.add('show');return;}
  const safe=q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const hl=s=>esc(s).replace(new RegExp('('+safe+')','ig'),'<mark>$1</mark>');
  box.innerHTML=res.map(r=>`<div class="sr-item" data-id="${r.n.id}">
    <div class="t">${r.n.isDaily?'📅 ':''}${hl(r.n.title)}</div>
    ${r.ctx?`<div class="x">${hl(r.ctx)}</div>`:''}</div>`).join('');
  box.classList.add('show');
  box.querySelectorAll('.sr-item[data-id]').forEach(el=>el.onclick=()=>{
    box.classList.remove('show');document.getElementById('search').value='';openNote(el.dataset.id);});
}

/* ---------- Export / Import ---------- */
function noteToMd(n){
  const tags=extractTags(n.content);
  const fm=['---','title: '+n.title,'created: '+new Date(n.created).toISOString(),
    'updated: '+new Date(n.updated).toISOString()];
  if(n.folder)fm.push('folder: '+n.folder);
  if(n.isDaily)fm.push('daily: '+n.dayKey);
  if(tags.length)fm.push('tags: ['+tags.join(', ')+']');
  fm.push('---','');
  return fm.join('\n')+n.content+'\n';
}
async function exportAll(){
  if(!notes.length){toast('Nada para exportar');return;}
  toast('Preparando exportação…');
  try{await loadJSZip();}catch(e){return;}
  const zip=new JSZip();
  notes.forEach(n=>{const folder=n.folder?n.folder.replace(/[\/\\]/g,'-')+'/':'';
    zip.file(folder+slug(n.title)+'-'+n.id.slice(-4)+'.md',noteToMd(n));});
  const blob=await zip.generateAsync({type:'blob'});
  download(blob,'reflexos-diarios-'+dayKey(new Date())+'.zip');
  toast('Exportado: '+notes.length+' arquivos .md');
}
function download(blob,name){const u=URL.createObjectURL(blob);const a=document.createElement('a');
  a.href=u;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);}
function loadJSZip(){return new Promise((res,rej)=>{if(window.JSZip)return res();
  const s=document.createElement('script');
  s.src='https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
  s.onload=res;s.onerror=()=>{toast('Falha ao carregar exportador (offline?)');rej();};document.head.appendChild(s);});}
async function importFiles(files){
  let count=0;
  for(const f of files){const text=await f.text();
    let content=text,title=f.name.replace(/\.(md|markdown|txt)$/i,''),folder='',isDaily=false,dk=null;
    const fm=text.match(/^---\n([\s\S]*?)\n---\n?/);
    if(fm){const meta=fm[1];content=text.slice(fm[0].length);
      const mt=meta.match(/title:\s*(.+)/);if(mt)title=mt[1].trim();
      const mf=meta.match(/folder:\s*(.+)/);if(mf)folder=mf[1].trim();
      const md=meta.match(/daily:\s*(.+)/);if(md){isDaily=true;dk=md[1].trim();}}
    if(noteByTitle(title)){title=title+' (importado)';}
    await createNote(title,{content:content.replace(/^\n+/,''),folder,isDaily,dayKey:dk});count++;}
  toast(count+' nota(s) importada(s)');renderNoteList();showView(currentView);
}

/* ---------- Note menu / delete ---------- */
function openNoteMenu(anchor){
  const m=document.getElementById('noteMenu');const n=noteById(currentId);if(!n)return;
  m.innerHTML=`<button data-a="copy">📋 Copiar como Markdown</button>
    <button data-a="dl">⬇️ Baixar .md</button>
    <button data-a="dup">⧉ Duplicar nota</button><hr>
    <button data-a="del" class="danger">🗑️ Excluir nota</button>`;
  const r=anchor.getBoundingClientRect();m.style.top=(r.bottom+6)+'px';m.style.right=(innerWidth-r.right)+'px';m.style.left='auto';
  m.classList.add('show');
  m.querySelectorAll('button').forEach(b=>b.onclick=async()=>{m.classList.remove('show');
    if(b.dataset.a==='copy'){navigator.clipboard.writeText(noteToMd(n));toast('Copiado');}
    if(b.dataset.a==='dl'){download(new Blob([noteToMd(n)],{type:'text/markdown'}),slug(n.title)+'.md');}
    if(b.dataset.a==='dup'){const d=await createNote(n.title+' (cópia)',{content:n.content,folder:n.folder});openNote(d.id);}
    if(b.dataset.a==='del'){confirmModal('Excluir nota','Excluir "'+n.title+'"? Isso não pode ser desfeito.',async()=>{
      await dbDel('notes',n.id);notes=notes.filter(x=>x.id!==n.id);currentId=null;
      pushDelete(n.id);toast('Nota excluída');showView(currentView==='daily'?'daily':'all');});}
  });
}

/* ---------- Modals ---------- */
function promptModal(title,label,def){return new Promise(res=>{
  const bg=document.getElementById('modalBg'),box=document.getElementById('modalBox');
  box.innerHTML=`<h3>${title}</h3><p>${label}</p><input id="mInput" value="${esc(def||'')}">
    <div class="modal-actions"><button class="btn-ghost" id="mCancel">Cancelar</button><button class="btn-primary" id="mOk">OK</button></div>`;
  bg.classList.add('show');const inp=box.querySelector('#mInput');inp.focus();inp.select();
  const done=v=>{bg.classList.remove('show');res(v);};
  box.querySelector('#mOk').onclick=()=>done(inp.value.trim());
  box.querySelector('#mCancel').onclick=()=>done(null);
  inp.onkeydown=e=>{if(e.key==='Enter')done(inp.value.trim());if(e.key==='Escape')done(null);};
});}
function confirmModal(title,msg,onYes){
  const bg=document.getElementById('modalBg'),box=document.getElementById('modalBox');
  box.innerHTML=`<h3>${title}</h3><p>${msg}</p>
    <div class="modal-actions"><button class="btn-ghost" id="cNo">Cancelar</button><button class="btn-danger" id="cYes">Confirmar</button></div>`;
  bg.classList.add('show');
  box.querySelector('#cNo').onclick=()=>bg.classList.remove('show');
  box.querySelector('#cYes').onclick=()=>{bg.classList.remove('show');onYes();};
}

/* ---------- Settings ---------- */
function openSettings(){
  const bg=document.getElementById('modalBg'),box=document.getElementById('modalBox');
  const conta = user
    ? `<div style="background:var(--tag-soft);color:var(--tag);border-radius:10px;padding:10px 13px;font-size:13px;font-weight:600;margin-bottom:14px">☁️ Conectado como ${esc(user.email||'sua conta')} · notas sincronizam entre aparelhos</div>`
    : `<div style="background:var(--bg-3);color:var(--text-2);border-radius:10px;padding:10px 13px;font-size:13px;margin-bottom:14px">📴 Modo local (sem sincronizar). Faça login para acessar suas notas em outros aparelhos.</div>`;
  box.innerHTML=`<h3>⚙️ Configurações</h3>
    <p>Reflexos Diários · ${notes.length} notas.</p>
    ${conta}
    <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:16px">
      <button class="btn-ghost" id="setExp" style="text-align:left;border:1px solid var(--border);padding:11px 13px;border-radius:10px">⬇️ Exportar tudo (.md em .zip)</button>
      <button class="btn-ghost" id="setImp" style="text-align:left;border:1px solid var(--border);padding:11px 13px;border-radius:10px">⬆️ Importar arquivos .md</button>
      ${user
        ? `<button class="btn-ghost" id="setOut" style="text-align:left;border:1px solid var(--border);padding:11px 13px;border-radius:10px;color:var(--danger)">🚪 Sair desta conta</button>`
        : `<button class="btn-ghost" id="setIn" style="text-align:left;border:1px solid var(--border);padding:11px 13px;border-radius:10px;color:var(--accent)">🔑 Entrar / criar conta para sincronizar</button>`}
    </div>
    <div class="modal-actions"><button class="btn-primary" id="setClose">Fechar</button></div>`;
  bg.classList.add('show');
  box.querySelector('#setClose').onclick=()=>bg.classList.remove('show');
  box.querySelector('#setExp').onclick=()=>{bg.classList.remove('show');exportAll();};
  box.querySelector('#setImp').onclick=()=>{bg.classList.remove('show');document.getElementById('fileInput').click();};
  const out=box.querySelector('#setOut'); if(out) out.onclick=()=>{bg.classList.remove('show');
    confirmModal('Sair da conta','Suas notas continuam salvas na nuvem. Este aparelho será desconectado. Sair?',()=>signOut());};
  const inb=box.querySelector('#setIn'); if(inb) inb.onclick=async()=>{bg.classList.remove('show');
    await setSetting('offlineMode',false); showAuth();};
}

/* =========================================================================
   Supabase — autenticação por e-mail/senha + sincronização entre aparelhos
   ========================================================================= */
const SUPA_URL='https://jdfdbisydqdwzowqbpsj.supabase.co';
const SUPA_KEY='sb_publishable_v4OQ0cqLr1ZrnPjBmaZP8A_RqfuqBef';
let sb=null, user=null, pushTimers={}, lastPull=0, authMode='login';

function initSupa(){
  try{ if(window.supabase&&SUPA_URL&&SUPA_KEY){ sb=window.supabase.createClient(SUPA_URL,SUPA_KEY,{auth:{persistSession:true,autoRefreshToken:true}}); } }
  catch(e){ console.warn('supabase init',e); }
}
function noteToRow(n){return{id:n.id,user_id:user&&user.id,title:n.title||'',content:n.content||'',
  folder:n.folder||'',is_daily:!!n.isDaily,day_key:n.dayKey||null,
  created:n.created||now(),updated:n.updated||now(),deleted:!!n.deleted};}
function rowToNote(r){return{id:r.id,title:r.title||'',content:r.content||'',folder:r.folder||'',
  isDaily:!!r.is_daily,dayKey:r.day_key||null,created:Number(r.created)||now(),updated:Number(r.updated)||now()};}

function queuePush(n){ if(!sb||!user)return;
  clearTimeout(pushTimers[n.id]); pushTimers[n.id]=setTimeout(()=>pushNote(n),500); }
async function pushNote(n){ if(!sb||!user)return;
  try{ const{error}=await sb.from('notes').upsert(noteToRow(n)); if(error)throw error; }
  catch(e){ markDirty(n.id); } }
async function pushDelete(id){ if(!sb||!user)return;
  try{ const{error}=await sb.from('notes').upsert({id,user_id:user.id,deleted:true,updated:now()}); if(error)throw error; }
  catch(e){ markDirty(id); } }
function markDirty(id){ settings.dirty=settings.dirty||{}; settings.dirty[id]=1; setSetting('dirty',settings.dirty); }
async function flushDirty(){ if(!sb||!user||!settings.dirty)return;
  for(const id of Object.keys(settings.dirty)){ const n=noteById(id);
    if(n) await pushNote(n); else await pushDelete(id); }
  settings.dirty={}; await setSetting('dirty',{}); }

async function syncPull(silent){ if(!sb||!user)return;
  lastPull=now();
  try{
    const{data,error}=await sb.from('notes').select('*').eq('user_id',user.id);
    if(error)throw error;
    const remoteIds={};
    for(const r of data){ remoteIds[r.id]=r;
      const local=noteById(r.id);
      if(r.deleted){ if(local){ notes=notes.filter(x=>x.id!==r.id); await dbDel('notes',r.id); if(currentId===r.id)currentId=null; } continue; }
      if(local && local.id===currentId && document.getElementById('editor')) continue;
      const ln=rowToNote(r);
      if(!local){ notes.push(ln); await dbPut('notes',ln); }
      else if(ln.updated>(local.updated||0)){ Object.assign(local,ln); await dbPut('notes',local); }
    }
    for(const n of [...notes]){ const r=remoteIds[n.id];
      if(!r || (n.updated||0)>(Number(r.updated)||0)) await pushNote(n); }
    if(!silent)toast('Sincronizado ✓');
    refreshAfterSync();
  }catch(e){ console.warn('pull',e); if(!silent)toast('Offline — usando dados locais'); }
}
function syncPullThrottled(){ if(now()-lastPull>4000) syncPull(true); }
function refreshAfterSync(){
  if(document.getElementById('editor')&&currentId){ renderNoteList(); }
  else { showView(currentView); }
}

async function clearLocalNotes(){ await new Promise(r=>{const t=tx('notes','readwrite').clear();t.onsuccess=()=>r();}); notes=[]; }

/* ---------- Auth UI ---------- */
function showAuth(){ const l=document.getElementById('lock'); l.classList.add('show');
  setTimeout(()=>document.getElementById('authEmail').focus(),50); }
function traduzErro(m){ m=String(m||'');
  if(/Invalid login/i.test(m))return'E-mail ou senha incorretos.';
  if(/already registered|already been|exists/i.test(m))return'Este e-mail já tem conta — toque em “Já tenho conta”.';
  if(/at least 6|password.*6/i.test(m))return'A senha precisa de ao menos 6 caracteres.';
  if(/valid email|invalid.*email/i.test(m))return'Digite um e-mail válido.';
  if(/Failed to fetch|network/i.test(m))return'Sem conexão com o servidor.';
  return m; }
function wireAuth(){
  const email=document.getElementById('authEmail'), pass=document.getElementById('lockInput');
  const err=document.getElementById('lockErr'), btn=document.getElementById('lockBtn');
  const msg=document.getElementById('lockMsg'), toggle=document.getElementById('authToggle');
  toggle.onclick=()=>{ authMode=authMode==='login'?'signup':'login';
    btn.textContent=authMode==='login'?'Entrar':'Criar conta';
    msg.textContent=authMode==='login'?'Entre para sincronizar suas notas entre todos os aparelhos.':'Crie sua conta para guardar e sincronizar suas notas.';
    toggle.textContent=authMode==='login'?'Criar uma conta':'Já tenho conta'; err.textContent=''; };
  document.getElementById('authOffline').onclick=async()=>{ await setSetting('offlineMode',true);
    document.getElementById('lock').classList.remove('show'); await enterApp(); };
  const submit=async()=>{ err.textContent='';
    const e=email.value.trim(), p=pass.value;
    if(!e||!p){ err.textContent='Preencha e-mail e senha.'; return; }
    if(!sb){ err.textContent='Sem conexão com o servidor.'; return; }
    btn.disabled=true; btn.textContent='…';
    try{
      let res = authMode==='signup'
        ? await sb.auth.signUp({email:e,password:p})
        : await sb.auth.signInWithPassword({email:e,password:p});
      if(res.error) throw res.error;
      if(!res.data.session){ const r2=await sb.auth.signInWithPassword({email:e,password:p});
        if(r2.error) throw r2.error; user=r2.data.user; }
      else user=res.data.user||res.data.session.user;
      await setSetting('offlineMode',false);
      document.getElementById('lock').classList.remove('show');
      pass.value=''; await enterApp();
    }catch(ex){ err.textContent=traduzErro(ex.message||ex); }
    finally{ btn.disabled=false; btn.textContent=(authMode==='login'?'Entrar':'Criar conta'); }
  };
  btn.onclick=submit;
  pass.onkeydown=e=>{ if(e.key==='Enter') submit(); };
  email.onkeydown=e=>{ if(e.key==='Enter') submit(); };
}
async function signOut(){ try{ if(sb) await sb.auth.signOut(); }catch(e){}
  user=null; await setSetting('offlineMode',false); await clearLocalNotes(); location.reload(); }

/* ---------- Theme ---------- */
function applyTheme(t){document.documentElement.setAttribute('data-theme',t);
  document.querySelector('meta[name=theme-color]').setAttribute('content',t==='dark'?'#15151f':'#f6f6f4');}
async function toggleTheme(){const t=(settings.theme==='dark')?'light':'dark';
  await setSetting('theme',t);applyTheme(t);if(currentView==='graph')renderGraph();}

/* ---------- Mobile sidebar ---------- */
function openMobileSidebar(){document.getElementById('sidebar').classList.add('open');document.getElementById('scrim').classList.add('show');}
function closeMobileSidebar(){document.getElementById('sidebar').classList.remove('open');document.getElementById('scrim').classList.remove('show');}

/* ---------- Seed (first run) ---------- */
async function seed(){
  await createNote('Bem-vindo ao Reflexos Diários',{folder:'Guia',content:
`# Bem-vindo 🌿

Este é o seu **santuário de ideias** — um lugar para pensar em rede e cultivar conexões entre suas anotações ao longo do tempo.

## Como funciona

- Escreva livremente. O texto aceita **Markdown**: \`**negrito**\`, \`*itálico*\`, listas, \`# títulos\`, \`> citações\` e \`código\`.
- Conecte ideias com links: escreva [[Minha primeira ideia]] e clique para abrir — se a nota não existir, ela é criada na hora.
- Organize com tags como #começando e #ideias.
- Cada nota mostra suas **Menções (backlinks)** no rodapé: quem aponta para ela.

## Próximos passos

- Abra o Diário de hoje e registre um pensamento.
- Veja o Grafo na lateral para enxergar a rede crescer.
- Suas notas sincronizam na nuvem e ficam disponíveis em todos os aparelhos.

Boa escrita! ✨`});
  await createNote('Minha primeira ideia',{folder:'Guia',content:
`Toda grande rede de ideias começa com uma nota. Esta é a sua.

Conecte-a de volta ao [[Bem-vindo ao Reflexos Diários]] e adicione uma #ideia.`});
  const today=await getTodayDaily();
  today.content='Hoje comecei meu segundo cérebro. Quero registrar #gratidao e conectar pensamentos a [[Minha primeira ideia]].';
  await saveNote(today);
}

/* ---------- Boot ---------- */
async function enterApp(){
  document.getElementById('lock').classList.remove('show');
  if(user && sb){ await flushDirty(); await syncPull(true); }
  if(!notes.length){ await seed(); notes=await dbAll('notes'); if(user&&sb){ for(const n of notes) await pushNote(n); } }
  showView('daily');
}

async function boot(){
  await openDB();
  (await dbAll('settings')).forEach(s=>settings[s.k]=s.v);
  applyTheme(settings.theme||'light');
  notes=await dbAll('notes');
  wireEvents();
  wireAuth();
  initSupa();
  let session=null;
  if(sb){ try{ const{data}=await sb.auth.getSession(); session=data.session; }catch(e){} }
  if(session){ user=session.user; await enterApp(); }
  else if(settings.offlineMode){ await enterApp(); }
  else { showAuth(); }
  document.addEventListener('visibilitychange',()=>{ if(!document.hidden && user) syncPullThrottled(); });
  window.addEventListener('focus',()=>{ if(user) syncPullThrottled(); });
  window.addEventListener('online',()=>{ if(user){ flushDirty().then(()=>syncPull(true)); } });
  if('serviceWorker' in navigator){try{await navigator.serviceWorker.register('sw.js');}catch(e){}}
}

function wireEvents(){
  document.querySelectorAll('.nav button').forEach(b=>b.onclick=()=>showView(b.dataset.view));
  document.getElementById('newNoteBtn').onclick=async()=>{
    const t=await promptModal('Nova nota','Título da nota:','');
    if(t!==null){const n=await createNote(t||'Nota sem título');openNote(n.id);
      setTimeout(()=>{const e=document.getElementById('editor');if(e)e.focus();},50);}};
  document.getElementById('search').oninput=e=>doSearch(e.target.value);
  document.getElementById('search').onfocus=e=>{if(e.target.value)doSearch(e.target.value);};
  document.addEventListener('click',e=>{
    if(!e.target.closest('.search-wrap'))document.getElementById('searchResults').classList.remove('show');
    if(!e.target.closest('#noteMenu')&&!e.target.closest('#noteMenuBtn'))document.getElementById('noteMenu').classList.remove('show');});
  document.getElementById('exportBtn').onclick=exportAll;
  document.getElementById('importBtn').onclick=()=>document.getElementById('fileInput').click();
  document.getElementById('fileInput').onchange=e=>{if(e.target.files.length)importFiles([...e.target.files]);e.target.value='';};
  document.getElementById('themeBtn').onclick=toggleTheme;
  document.getElementById('settingsBtn').onclick=openSettings;
  document.getElementById('hamb').onclick=openMobileSidebar;
  document.getElementById('scrim').onclick=closeMobileSidebar;
  document.getElementById('noteMenuBtn').onclick=e=>openNoteMenu(e.currentTarget);
  document.getElementById('viewModeBtn').onclick=e=>{viewMode=viewMode==='preview'?'edit':'preview';
    e.currentTarget.classList.toggle('on',viewMode==='preview');
    document.getElementById('splitBtn').classList.remove('on');
    const s=document.getElementById('split');if(s){s.className='split '+(viewMode==='preview'?'preview-mode':'');updatePreview();}};
  document.getElementById('splitBtn').onclick=e=>{viewMode=viewMode==='split'?'edit':'split';
    e.currentTarget.classList.toggle('on',viewMode==='split');
    document.getElementById('viewModeBtn').classList.remove('on');
    const s=document.getElementById('split');if(s){s.className='split '+(viewMode==='split'?'split-mode':'');updatePreview();}};
  document.addEventListener('keydown',e=>{
    if((e.metaKey||e.ctrlKey)&&e.key==='k'){e.preventDefault();document.getElementById('search').focus();}
    if((e.metaKey||e.ctrlKey)&&e.key==='n'){e.preventDefault();document.getElementById('newNoteBtn').click();}});
}

boot();
