const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const app = $('#app');
const STORE = 'lenscape.state.v1';
const freshState = () => ({
  profile:{name:'Explorer', handle:'@explorer'},
  entries:[],
  language:(navigator.language || 'en').toLowerCase().startsWith('tr') ? 'tr' : 'en',
  deviceId: crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2),
  createdAt:new Date().toISOString(),
  schemaVersion:2
});
let state = loadState();
let cameraStream = null;
let speechTimer = null;
let currentUtterance = null;
let currentResult = null;
let lastLocation = null;
let mapInstance = null;

function loadState(){
  const base=freshState();
  try {
    const saved=JSON.parse(localStorage.getItem(STORE) || '{}');
    return {...base,...saved,profile:{...base.profile,...(saved.profile||{})},entries:Array.isArray(saved.entries)?saved.entries.slice(0,250):[]};
  } catch { return base; }
}
function saveState(){
  const durable={profile:state.profile,entries:state.entries,language:state.language,deviceId:state.deviceId,createdAt:state.createdAt,schemaVersion:2};
  try{localStorage.setItem(STORE,JSON.stringify(durable));return true;}catch(err){console.warn('Lenscape local save failed',err);return false;}
}
function esc(s=''){ return String(s).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
function fmtDate(iso){ const d=new Date(iso);if(Number.isNaN(d.getTime()))return '';return new Intl.DateTimeFormat(state.language==='tr'?'tr-TR':'en-US',{day:'numeric',month:'short',year:'numeric'}).format(d); }
function validCoord(lat,lng){const a=Number(lat),b=Number(lng);return Number.isFinite(a)&&Number.isFinite(b)&&a>=-90&&a<=90&&b>=-180&&b<=180;}
function safeUrl(value=''){try{const u=new URL(String(value));return /^https?:$/.test(u.protocol)?u.href:'#';}catch{return '#';}}
function safePhoto(value=''){return typeof value==='string'&&/^data:image\/(?:jpeg|png|webp);base64,/i.test(value)?value:'';}
function t(en,tr){ return state.language==='tr' ? tr : en; }
function toast(msg){ const el=document.createElement('div'); el.className='toast'; el.textContent=msg; $('#toast-root').appendChild(el); setTimeout(()=>el.remove(),3200); }
function route(){ return location.hash.replace(/^#/, '') || '/'; }
function go(path){ location.hash = path; }
function initials(name='Explorer'){ return name.split(/\s+/).slice(0,2).map(x=>x[0]).join('').toUpperCase(); }
function slugify(s='landmark'){ return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,''); }
function uniqueCities(){return new Set(state.entries.map(e=>{const city=String(e.city||'').trim().toLowerCase();const country=String(e.country||'').trim().toLowerCase();return city?`${city}|${country}`:'';}).filter(Boolean)).size;}
function uniqueCountries(){ return new Set(state.entries.map(e=>String(e.country||'').trim().toLowerCase()).filter(Boolean)).size; }
function verifiedEntries(){return state.entries.filter(e=>e.verified===true);}
function xp(){ return state.entries.length*20 + uniqueCities()*100 + uniqueCountries()*250; }

function nav(active='home'){
  return `<nav class="bottom-nav" aria-label="Main navigation">
    ${navItem('home','⌂',t('Home','Ana Sayfa'),active)}
    ${navItem('explore','◎',t('Scan','Tara'),active)}
    ${navItem('diary','▣',t('Diary','Günlük'),active)}
    ${navItem('map','⌖',t('Map','Harita'),active)}
    ${navItem('leaderboard','★',t('Rank','Sıralama'),active)}
  </nav>`;
}
function navItem(id,icon,label,active){ return `<button class="nav-item ${active===id?'active':''}" data-route="/${id==='home'?'':id}"><span class="nav-icon">${icon}</span><span>${label}</span></button>`; }
function topbar(){ return `<header class="topbar"><a href="#/" class="brand"><span class="brand-mark">◉</span><span>Lenscape</span><span class="brand-sub">AI travel diary</span></a><div class="top-actions"><button class="icon-btn" data-action="settings" aria-label="${t('Settings','Ayarlar')}">⚙</button></div></header>`; }

function render(){
  document.documentElement.lang=state.language;
  cleanupTransient();
  const r = route();
  if (r.startsWith('/share/')) return renderShared(r.slice(7));
  if (r==='/explore') return renderExplore();
  if (r==='/diary') return renderDiary();
  if (r==='/map') return renderMap();
  if (r==='/leaderboard') return renderLeaderboard();
  if (r==='/profile') return renderSettings();
  renderHome();
}
function cleanupTransient(){ stopCamera(); stopSpeech(); if(mapInstance){ try{mapInstance.remove();}catch{} mapInstance=null; } }

function renderHome(){
  app.innerHTML = `${topbar()}<main class="page">
    <section class="hero"><div class="hero-copy">
      <div class="eyebrow">${t('Point. Discover. Remember.','Kadrajla. Keşfet. Hatırla.')}</div>
      <h1>${t('Every city has a <span>story.</span>','Her şehrin bir <span>hikâyesi var.</span>')}</h1>
      <p>${t('Take a photo of a landmark. Lenscape identifies what you are looking at, finds its story, narrates it over an AR-style view, and saves the moment to your travel diary.','Bir yapının fotoğrafını çek. Lenscape baktığın yeri tanır, hikâyesini bulur, AR tarzı görünüm üzerinde anlatır ve anını seyahat günlüğüne kaydeder.')}</p>
      <div class="hero-actions"><button class="primary-btn" data-route="/explore">${t('Start exploring →','Keşfe başla →')}</button><button class="secondary-btn" data-route="/diary">${t('Open my diary','Günlüğümü aç')}</button></div>
      <div class="hero-meta"><div class="metric"><strong>${state.entries.length}</strong><span>${t('landmarks saved','kayıtlı yapı')}</span></div><div class="metric"><strong>${uniqueCities()}</strong><span>${t('cities explored','keşfedilen şehir')}</span></div><div class="metric"><strong>${xp()}</strong><span>XP</span></div></div>
    </div><div class="scanner-card"><div class="scanner-ui"><div class="scanner-badge">● ${t('Live landmark vision','Canlı landmark görüşü')}</div><div class="scanner-poi"><div class="dot"></div><h3>${t('Aim at a landmark','Bir yapıyı kadraja al')}</h3><p>${t('Visual + location recognition','Görsel + konum tanıma')}</p></div><div class="scanner-footer"><div class="mini-card">${t('History is grounded in search and public sources.','Tarih bilgisi arama ve açık kaynaklarla doğrulanır.')}</div><span class="pill-btn">AI + GPS</span></div></div></div></section>
    <section class="section"><div class="section-head"><div><div class="eyebrow">${t('One travel memory, four layers','Bir anı, dört katman')}</div><h2>${t('More than a camera.','Kameradan fazlası.')}</h2></div></div>
      <div class="cards"><article class="feature-card"><div class="feature-icon">◎</div><h3>${t('Recognize','Tanı')}</h3><p>${t('Vision AI combines the photo with your location to identify nearby landmarks with a confidence score.','Görsel yapay zekâ fotoğrafı konumunla birleştirir ve yakın yapıları güven skoru ile tanır.')}</p></article><article class="feature-card"><div class="feature-icon">▶</div><h3>${t('Hear the story','Hikâyeyi dinle')}</h3><p>${t('A concise, source-aware story becomes a narrated AR-style moment right over your photo.','Kısa ve kaynak odaklı hikâye, fotoğrafının üzerinde anlatımlı AR tarzı bir deneyime dönüşür.')}</p></article><article class="feature-card"><div class="feature-icon">⌖</div><h3>${t('Keep the journey','Yolculuğu sakla')}</h3><p>${t('Build a visual diary, export GeoJSON/KML, and share a compact interactive travel map.','Görsel günlük oluştur, GeoJSON/KML dışa aktar ve interaktif seyahat haritanı paylaş.')}</p></article></div>
    </section></main>${nav('home')}`;
  bindCommon();
}

function renderExplore(){
  app.innerHTML = `${topbar()}<main class="page scan-page"><div class="section-head"><div><div class="eyebrow">${t('Landmark scanner','Landmark tarayıcı')}</div><h2>${t('What are you looking at?','Neye bakıyorsun?')}</h2></div><button class="ghost-btn" data-action="demo-scan">${t('Try demo','Demoyu dene')}</button></div>
    <section class="camera-shell" id="camera-shell"><video id="camera" autoplay playsinline muted></video><canvas id="capture-canvas" hidden></canvas><div class="camera-overlay"><div class="focus-frame"></div></div><div class="camera-top"><span class="camera-status" id="camera-status">${t('Requesting camera…','Kamera isteniyor…')}</span><span class="camera-status" id="location-status">⌖ ${t('Location pending','Konum bekleniyor')}</span></div><div class="capture-row"><span></span><button class="capture-btn" data-action="capture" aria-label="${t('Capture photo','Fotoğraf çek')}"></button><label class="ghost-btn upload-btn">${t('Upload','Yükle')}<input id="file-input" type="file" accept="image/*" capture="environment" hidden></label></div></section><p class="camera-hint">${t('For best results, fit the whole facade in the frame.','En iyi sonuç için yapının cephesini mümkün olduğunca bütünüyle kadraja al.')}</p></main>${nav('explore')}`;
  bindCommon(); startCamera();
  $('#file-input')?.addEventListener('change', e=>{ const f=e.target.files?.[0]; if(f) analyzeFile(f); });
}

async function startCamera(){
  const status=$('#camera-status');
  try{
    cameraStream = await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:960}},audio:false});
    const v=$('#camera'); if(v){v.srcObject=cameraStream; await v.play();}
    if(status) status.textContent='● '+t('Camera ready','Kamera hazır');
  }catch(err){ if(status) status.textContent=t('Camera unavailable — upload a photo','Kamera kullanılamıyor — fotoğraf yükle'); }
  getLocation().then(pos=>{ const s=$('#location-status'); if(s) s.textContent=pos?`⌖ ${t('Location ready','Konum hazır')}`:`⌖ ${t('No location','Konum yok')}`; });
}
function stopCamera(){ if(cameraStream){ cameraStream.getTracks().forEach(t=>t.stop()); cameraStream=null; } }
function getLocation(){ return new Promise(resolve=>{ if(!navigator.geolocation) return resolve(null); navigator.geolocation.getCurrentPosition(p=>{lastLocation={lat:p.coords.latitude,lng:p.coords.longitude,accuracy:p.coords.accuracy};resolve(lastLocation);},()=>resolve(null),{enableHighAccuracy:true,timeout:6500,maximumAge:60000}); }); }

async function capture(){
  const v=$('#camera'), c=$('#capture-canvas'); if(!v||!c||!v.videoWidth){ toast(t('Camera is not ready yet.','Kamera henüz hazır değil.')); return; }
  const max=1024, scale=Math.min(1,max/v.videoWidth); c.width=Math.round(v.videoWidth*scale); c.height=Math.round(v.videoHeight*scale); c.getContext('2d').drawImage(v,0,0,c.width,c.height);
  await analyzeDataUrl(c.toDataURL('image/jpeg',.74));
}
async function analyzeFile(file){
  if(!file?.type?.startsWith('image/')){toast(t('Choose an image file.','Bir görsel dosyası seç.'));return;}
  if(file.size>15_000_000){toast(t('That image is too large. Choose one under 15 MB.','Bu görsel çok büyük. 15 MB altında bir dosya seç.'));return;}
  try{const src=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=reject;r.readAsDataURL(file);});await analyzeDataUrl(await resizeDataUrl(src));}
  catch{toast(t('The image could not be read.','Görsel okunamadı.'));}
}
function resizeDataUrl(src,max=1024,quality=.74){ return new Promise((resolve,reject)=>{ const img=new Image(); img.onload=()=>{ const scale=Math.min(1,max/img.width); const c=document.createElement('canvas');c.width=Math.max(1,Math.round(img.width*scale));c.height=Math.max(1,Math.round(img.height*scale));const ctx=c.getContext('2d');if(!ctx)return reject(new Error('Canvas unavailable'));ctx.drawImage(img,0,0,c.width,c.height);resolve(c.toDataURL('image/jpeg',quality));};img.onerror=reject;img.src=src; }); }
async function diaryThumbnail(src){try{return await resizeDataUrl(src,560,.62);}catch{return '';}}

function showProcessing(image){
  const shell=$('#camera-shell'); if(!shell) return; const layer=document.createElement('div');layer.className='processing';layer.innerHTML=`<div><div class="radar"></div><div class="eyebrow">${t('Reading the city','Şehri okuyor')}</div><h2>${t('Identifying landmark…','Yapı tanınıyor…')}</h2><p class="muted">${t('Combining image, location and public sources.','Görsel, konum ve açık kaynaklar birleştiriliyor.')}</p></div>`;shell.appendChild(layer);
}
async function analyzeDataUrl(imageDataUrl, demo=false){
  showProcessing(imageDataUrl); stopCamera();
  const loc=lastLocation||await getLocation();
  try{
    let result;
    if(demo){ result=demoResult(); }
    else{
      const res=await fetch('/api/analyze',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({imageDataUrl,lat:loc?.lat,lng:loc?.lng,language:state.language}),signal:AbortSignal.timeout?AbortSignal.timeout(55_000):undefined});
      if(!res.ok) throw new Error((await res.json().catch(()=>({}))).error || 'Analysis failed');
      result=await res.json();
    }
    result.photo=imageDataUrl;result.createdAt=new Date().toISOString();result.id=crypto.randomUUID?crypto.randomUUID():Date.now().toString();result.verified=Boolean(result.verified&&result.mode==='ai'&&Number(result.confidence)>=.75);currentResult=result;renderResult(result);
  }catch(err){ toast(`${t('Scan failed','Tarama başarısız')}: ${err.message}`); renderExplore(); }
}
function demoImageDataUrl(){const c=document.createElement('canvas');c.width=1200;c.height=800;const x=c.getContext('2d');const g=x.createLinearGradient(0,0,1200,800);g.addColorStop(0,'#829c91');g.addColorStop(1,'#192923');x.fillStyle=g;x.fillRect(0,0,1200,800);x.fillStyle='rgba(215,212,189,.82)';x.fillRect(520,310,160,380);x.fillRect(390,610,420,80);x.beginPath();x.moveTo(455,310);x.lineTo(745,310);x.lineTo(600,140);x.closePath();x.fill();x.fillStyle='#fff';x.font='34px system-ui';x.textAlign='center';x.fillText('Demo landmark',600,745);return c.toDataURL('image/jpeg',.82);}
function demoResult(){ return {recognized:true,name:'St. Stephen’s Cathedral',city:'Vienna',country:'Austria',lat:48.2085,lng:16.3731,confidence:.97,era:'Gothic',year:'12th–15th c.',summary:'A defining landmark of Vienna, St. Stephen’s Cathedral grew from a 12th-century Romanesque church into the Gothic cathedral that dominates the city center today.',narration:'You are looking at St. Stephen’s Cathedral, one of Vienna’s most recognizable landmarks. Its history reaches back to the twelfth century, while much of the structure you see today took shape in the Gothic period. The cathedral’s patterned tiled roof and tall south tower have become symbols of the city. For centuries, this site has stood at the center of Vienna’s religious and civic life, witnessing wars, rebuilding, ceremonies and the growth of the old city around it.',facts:['Its south tower rises above Vienna’s historic center.','The roof is famous for its colorful geometric tile pattern.','The cathedral has been rebuilt and restored across several periods.'],sources:[{title:'St. Stephen’s Cathedral — official site',url:'https://www.stephanskirche.at/'},{title:'St. Stephen’s Cathedral — Wikipedia',url:'https://en.wikipedia.org/wiki/St._Stephen%27s_Cathedral,_Vienna'}],mode:'demo'}; }

function renderResult(r){
  const photo=safePhoto(r.photo);const modeLabel=r.mode==='ai'?'AI':r.mode==='location'?t('Nearby suggestion','Yakın konum önerisi'):r.mode||'';const verifyLabel=r.verified?t('Verified for leaderboard','Sıralama için doğrulandı'):t('Not leaderboard-verified','Sıralama için doğrulanmadı');
  app.innerHTML = `${topbar()}<main class="page"><section class="result-shell"><div class="result-visual">${photo?`<img src="${photo}" alt="${esc(r.name)}">`:''}<div class="result-vignette"></div><span class="ar-chip a">${esc(r.year||t('Historic landmark','Tarihî yapı'))}</span><span class="ar-chip b">${esc(r.era||t('Cultural site','Kültür noktası'))}</span><span class="ar-chip c">⌖ ${esc([r.city,r.country].filter(Boolean).join(', '))}</span><div class="result-title"><span class="confidence"><span class="confidence-dot"></span>${Math.round((r.confidence||.6)*100)}% ${t('match','eşleşme')} · ${esc(modeLabel)}</span><span class="verification ${r.verified?'ok':'limited'}">${esc(verifyLabel)}</span><h1>${esc(r.name)}</h1><p>${esc([r.city,r.country].filter(Boolean).join(' · '))}</p></div></div>
    <div class="story-panel"><div class="story-controls"><button class="play-btn" data-action="narrate">▶</button><div class="progress-wrap"><div><strong>${t('Hear the story','Hikâyeyi dinle')}</strong> <span class="muted tiny">~${Math.max(20,Math.round((r.narration||'').split(/\s+/).length/2.5))} sec</span></div><div class="progress-track"><div class="progress-bar" id="speech-progress"></div></div></div></div>
      <p class="story-text">${esc(r.narration||r.summary)}</p>
      <div class="facts">${(r.facts||[]).slice(0,3).map(f=>`<div class="fact">✦ ${esc(f)}</div>`).join('')}</div>
      <div class="btn-row"><button class="primary-btn" data-action="save-entry">${state.entries.some(e=>e.landmarkKey===landmarkKey(r))?t('Saved ✓','Kaydedildi ✓'):t('Save to diary','Günlüğe kaydet')}</button><button class="secondary-btn" data-route="/explore">${t('Scan another','Başka tara')}</button></div>
      ${(r.sources||[]).length?`<div class="sources"><div class="eyebrow">${t('Sources','Kaynaklar')}</div>${r.sources.slice(0,5).map(s=>{const u=safeUrl(s.url);return u==='#'?'':`<a class="source-link" href="${esc(u)}" target="_blank" rel="noopener noreferrer"><span>${esc(s.title||s.url)}</span><span>↗</span></a>`;}).join('')}</div>`:''}
    </div></section></main>${nav('explore')}`;
  bindCommon();
}
function landmarkKey(r){ if(r.landmarkId)return String(r.landmarkId).slice(0,250);if(/^Q\d+$/.test(String(r.wikidataId||'')))return `wikidata:${r.wikidataId}`;const named=`${slugify(r.name)}|${slugify(r.city)}|${slugify(r.country)}`;if(named.replace(/\|/g,''))return named;if(validCoord(r.lat,r.lng))return `coord:${Number(r.lat).toFixed(4)},${Number(r.lng).toFixed(4)}`;return 'landmark'; }
async function saveCurrent(){ const r=currentResult;if(!r)return; const key=landmarkKey(r); if(state.entries.some(e=>e.landmarkKey===key)){toast(t('Already in your diary.','Zaten günlüğünde.'));return;}const token=r.verificationToken||'';const photo=await diaryThumbnail(r.photo);const entry={...r,photo,landmarkKey:key,note:'',savedAt:new Date().toISOString()};delete entry.verificationToken;state.entries.unshift(entry);if(!saveState()){state.entries.shift();toast(t('Browser storage is full. Export or clear older diary entries first.','Tarayıcı depolaması dolu. Önce eski günlük kayıtlarını dışa aktar veya temizle.'));return;}if(token)syncDiscovery({...entry,verificationToken:token});toast(t('Saved to your travel diary.','Seyahat günlüğüne kaydedildi.'));renderResult(r); }

function narrate(){
  const r=currentResult;if(!r||!('speechSynthesis'in window)){toast(t('Narration is not supported in this browser.','Bu tarayıcı sesli anlatımı desteklemiyor.'));return;}
  if(speechSynthesis.speaking){stopSpeech();return;}
  const text=r.narration||r.summary; const u=new SpeechSynthesisUtterance(text);u.lang=state.language==='tr'?'tr-TR':'en-US';u.rate=.96;u.pitch=1;currentUtterance=u;
  const total=Math.max(1,text.split(/\s+/).length/2.45)*1000,start=Date.now();const btn=$('[data-action="narrate"]');if(btn)btn.textContent='■';
  speechTimer=setInterval(()=>{const p=Math.min(98,(Date.now()-start)/total*100);const bar=$('#speech-progress');if(bar)bar.style.width=p+'%';},200);
  u.onend=()=>{const bar=$('#speech-progress');if(bar)bar.style.width='100%';setTimeout(()=>{if(bar)bar.style.width='0'},500);if(btn)btn.textContent='▶';clearInterval(speechTimer);};u.onerror=u.onend;speechSynthesis.speak(u);
}
function stopSpeech(){ if('speechSynthesis'in window) speechSynthesis.cancel();if(speechTimer)clearInterval(speechTimer);speechTimer=null;currentUtterance=null; }

function renderDiary(){
  const entries=state.entries;
  app.innerHTML=`${topbar()}<main class="page"><header class="dashboard-head"><div class="eyebrow">${t('Your travel archive','Seyahat arşivin')}</div><h1>${t('Travel diary','Seyahat günlüğü')}</h1><p class="muted">${t('Every saved place becomes part of your personal atlas.','Kaydettiğin her yer kişisel atlasının bir parçası olur.')}</p></header>
    <section class="stats-grid"><div class="stat-card"><strong>${entries.length}</strong><span>${t('Landmarks','Yapı')}</span></div><div class="stat-card"><strong>${uniqueCities()}</strong><span>${t('Cities','Şehir')}</span></div><div class="stat-card"><strong>${uniqueCountries()}</strong><span>${t('Countries','Ülke')}</span></div><div class="stat-card"><strong>${xp()}</strong><span>XP</span></div></section>
    <section class="section"><div class="section-head"><div><div class="eyebrow">${t('Memories','Anılar')}</div><h2>${t('Places you met','Tanıştığın yerler')}</h2></div><div class="btn-row"><button class="ghost-btn" data-action="share-diary">${t('Share map','Haritayı paylaş')}</button><button class="ghost-btn" data-action="export-menu">${t('Export','Dışa aktar')}</button></div></div>
    ${entries.length?`<div class="diary-grid">${entries.map(entryCard).join('')}</div>`:`<div class="empty-state"><div class="big">◎</div><h3>${t('Your diary is waiting for its first landmark.','Günlüğün ilk yapısını bekliyor.')}</h3><p>${t('Take a city photo and save the story you discover.','Şehirde bir fotoğraf çek ve keşfettiğin hikâyeyi kaydet.')}</p><button class="primary-btn" data-route="/explore">${t('Start a scan','Tarama başlat')}</button></div>`}</section></main>${nav('diary')}`;
  bindCommon();
}
function entryCard(e){const photo=safePhoto(e.photo);return `<article class="entry-card"><div class="entry-photo">${photo?`<img src="${photo}" alt="${esc(e.name)}">`:`<div class="photo-placeholder">◎</div>`}</div><div class="entry-body"><div class="entry-meta"><span>${esc([e.city,e.country].filter(Boolean).join(', '))}</span><span>${fmtDate(e.savedAt||e.createdAt)}</span></div><h3>${esc(e.name)}</h3><p class="entry-note">${esc(e.note||e.summary||'')}</p><div class="entry-actions"><button class="pill-btn" data-action="edit-entry" data-id="${e.id}">${e.note?t('Edit note','Notu düzenle'):t('Add note','Not ekle')}</button><button class="icon-btn" data-action="delete-entry" data-id="${e.id}" aria-label="${t('Delete entry','Kaydı sil')}">×</button></div></div></article>`;}

function renderMap(){
  app.innerHTML=`${topbar()}<main class="page"><header class="dashboard-head"><div class="eyebrow">${t('Your custom map','Özel haritan')}</div><h1>${t('Places become a path.','Yerler bir rotaya dönüşür.')}</h1></header>${state.entries.length?`<section class="map-layout"><div class="map-list">${state.entries.map(e=>`<button class="map-item wide" data-map-id="${e.id}"><strong>${esc(e.name)}</strong><span>${esc([e.city,e.country].filter(Boolean).join(', '))}</span></button>`).join('')}</div><div id="map" class="map-canvas"></div></section>`:`<div class="empty-state"><div class="big">⌖</div><h3>${t('No pins yet.','Henüz pin yok.')}</h3><p>${t('Saved landmarks appear here automatically.','Kaydettiğin yapılar burada otomatik görünür.')}</p><button class="primary-btn" data-route="/explore">${t('Explore nearby','Yakını keşfet')}</button></div>`}<div class="btn-row" style="margin-top:14px"><button class="ghost-btn" data-action="share-diary">${t('Share this map','Bu haritayı paylaş')}</button><button class="ghost-btn" data-action="export-geojson">GeoJSON</button><button class="ghost-btn" data-action="export-kml">KML</button></div></main>${nav('map')}`;
  bindCommon(); if(state.entries.length) waitForLeaflet(()=>initMap(state.entries,'map'));
}
function waitForLeaflet(cb,n=0){if(window.L)return cb();if(n>30){const el=$('#map')||$('#share-map');if(el)el.innerHTML=`<div class="map-unavailable">${t('Map library is unavailable offline. Your saved coordinates are still included in exports.','Harita kitaplığı çevrimdışıyken kullanılamıyor. Kayıtlı koordinatlar dışa aktarımlarda korunur.')}</div>`;return;}setTimeout(()=>waitForLeaflet(cb,n+1),120);}
function initMap(entries,id){
  if(mapInstance){try{mapInstance.remove()}catch{}}; mapInstance=L.map(id,{zoomControl:true});L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; OpenStreetMap contributors'}).addTo(mapInstance);
  const valid=entries.filter(e=>validCoord(e.lat,e.lng)); if(!valid.length){mapInstance.setView([39,35],4);return;}
  const bounds=[]; valid.forEach(e=>{const m=L.marker([+e.lat,+e.lng]).addTo(mapInstance).bindPopup(`<strong>${esc(e.name)}</strong><br>${esc([e.city,e.country].filter(Boolean).join(', '))}`);bounds.push([+e.lat,+e.lng]);m._lensId=e.id;}); if(bounds.length===1)mapInstance.setView(bounds[0],14);else mapInstance.fitBounds(bounds,{padding:[40,40]});
  $$('[data-map-id]').forEach(b=>b.addEventListener('click',()=>{const e=valid.find(x=>x.id===b.dataset.mapId);if(e)mapInstance.flyTo([+e.lat,+e.lng],15);}));
}

async function renderLeaderboard(){
  app.innerHTML=`${topbar()}<main class="page leaderboard"><header class="dashboard-head"><div class="eyebrow">${t('Explorer leaderboard','Kaşif sıralaması')}</div><h1>${t('Who went farther?','Kim daha çok keşfetti?')}</h1><p class="muted">${t('Ranked by unique verified landmarks. Re-scanning the same place does not add another point.','Benzersiz doğrulanmış yapılar üzerinden sıralanır. Aynı yeri tekrar taramak yeni puan kazandırmaz.')}</p></header><div id="leader-list">${leaderRows(localLeaders())}</div><p class="tiny muted" id="leader-mode">${t('Showing local preview while cloud ranking loads.','Bulut sıralaması yüklenirken yerel önizleme gösteriliyor.')}</p></main>${nav('leaderboard')}`;
  bindCommon();
  try{const r=await fetch('/api/social?leaderboard=1');if(r.ok){const data=await r.json();if(data.rows?.length){$('#leader-list').innerHTML=leaderRows(data.rows);$('#leader-mode').textContent=t('Live community leaderboard','Canlı topluluk sıralaması');}else{$('#leader-mode').textContent=t('No community scores yet — showing your local verified progress.','Henüz topluluk skoru yok — yerel doğrulanmış ilerlemen gösteriliyor.');}}else $('#leader-mode').textContent=t('Local leaderboard — cloud sync is not configured.','Yerel sıralama — bulut senkronizasyonu yapılandırılmamış.');}catch{$('#leader-mode').textContent=t('Local leaderboard — offline mode.','Yerel sıralama — çevrimdışı mod.');}
}
function localLeaders(){const verified=verifiedEntries();const cities=new Set(verified.map(e=>{const city=String(e.city||'').trim().toLowerCase();const country=String(e.country||'').trim().toLowerCase();return city?`${city}|${country}`:'';}).filter(Boolean)).size;const countries=new Set(verified.map(e=>String(e.country||'').trim().toLowerCase()).filter(Boolean)).size;return [{name:state.profile.name,handle:state.profile.handle,landmarks:verified.length,cities,countries,isMe:true}];}
function leaderRows(rows){return rows.map((r,i)=>{const rawHandle=r.handle||r.username||'explorer';const handle=String(rawHandle).startsWith('@')?rawHandle:'@'+rawHandle;return `<article class="leader-card ${i<3?'top':''}"><div class="rank">${i<3?['🥇','🥈','🥉'][i]:'#'+(i+1)}</div><div style="display:flex;align-items:center;gap:11px"><div class="avatar">${esc(initials(r.name||r.display_name))}</div><div class="leader-name"><strong>${esc(r.name||r.display_name||'Explorer')}${r.isMe?' · '+t('You','Sen'):''}</strong><span>${esc(handle)}</span></div></div><div class="leader-score cities-col"><strong>${Number(r.cities)||0}</strong><span>${t('cities','şehir')}</span></div><div class="leader-score"><strong>${Number(r.landmarks??r.unique_landmarks)||0}</strong><span>${t('landmarks','yapı')}</span></div></article>`;}).join('');}

function renderSettings(){
  app.innerHTML=`${topbar()}<main class="page"><header class="dashboard-head"><div class="eyebrow">${t('Profile & settings','Profil & ayarlar')}</div><h1>${t('Make Lenscape yours.','Lenscape’i kendine göre ayarla.')}</h1></header><section class="settings-grid"><div class="settings-card"><h3>${t('Explorer profile','Kaşif profili')}</h3><div class="field"><label>${t('Display name','Görünen ad')}</label><input id="profile-name" value="${esc(state.profile.name)}" maxlength="36"></div><div class="field"><label>${t('Handle','Kullanıcı adı')}</label><input id="profile-handle" value="${esc(state.profile.handle)}" maxlength="30"></div><button class="primary-btn" data-action="save-profile">${t('Save profile','Profili kaydet')}</button></div><div class="settings-card"><h3>${t('Language','Dil')}</h3><p class="muted">${t('Interface and generated narration language.','Arayüz ve oluşturulan anlatım dili.')}</p><div class="btn-row"><button class="${state.language==='en'?'primary-btn':'secondary-btn'}" data-lang="en">English</button><button class="${state.language==='tr'?'primary-btn':'secondary-btn'}" data-lang="tr">Türkçe</button></div></div><div class="settings-card"><h3>${t('Privacy','Gizlilik')}</h3><p class="muted">${t('Local mode keeps your diary in this browser. Shared maps contain compact place metadata and captions, never diary photos.','Yerel mod günlüğünü bu tarayıcıda tutar. Paylaşılan haritalar yalnızca kompakt yer bilgisi ve açıklama içerir; günlük fotoğraflarını içermez.')}</p><a class="ghost-btn" href="/privacy.html">${t('Read privacy note','Gizlilik notunu oku')}</a></div><div class="settings-card"><h3>${t('Local data','Yerel veriler')}</h3><p class="muted">${t('Export before clearing if you want a backup.','Yedek istiyorsan temizlemeden önce dışa aktar.')}</p><button class="danger-btn" data-action="clear-data">${t('Clear diary data','Günlük verilerini temizle')}</button></div></section></main>${nav('')}`;
  bindCommon();
}

function openSettings(){go('/profile');}
function editEntry(id){const e=state.entries.find(x=>x.id===id);if(!e)return;openModal(`<div class="modal-head"><div><div class="eyebrow">${t('Travel note','Seyahat notu')}</div><h2>${esc(e.name)}</h2></div><button class="close-btn" data-close>×</button></div><div class="field"><label>${t('Your memory','Senin anın')}</label><textarea id="entry-note" rows="5" maxlength="600" placeholder="${t('What do you want to remember?','Neyi hatırlamak istiyorsun?')}">${esc(e.note||'')}</textarea></div><button class="primary-btn wide" data-save-note="${id}">${t('Save note','Notu kaydet')}</button>`);}
function deleteEntry(id){state.entries=state.entries.filter(x=>x.id!==id);saveState();toast(t('Removed from diary.','Günlükten kaldırıldı.'));renderDiary();}
function openModal(html){const back=document.createElement('div');back.className='modal-backdrop';back.innerHTML=`<div class="modal">${html}</div>`;document.body.appendChild(back);back.addEventListener('click',e=>{if(e.target===back||e.target.matches('[data-close]'))back.remove();const save=e.target.closest('[data-save-note]');if(save){const en=state.entries.find(x=>x.id===save.dataset.saveNote);if(en){en.note=$('#entry-note',back).value.trim();saveState();back.remove();renderDiary();}}});}

function createSharePayload(limit=40,includeCaption=true){return {v:2,t:`${state.profile.name} · Lenscape`,d:new Date().toISOString(),e:state.entries.slice(0,limit).map(e=>({i:e.id,n:e.name,c:e.city,o:e.country,a:validCoord(e.lat,e.lng)?Number(e.lat):null,g:validCoord(e.lat,e.lng)?Number(e.lng):null,d:e.savedAt,x:includeCaption?String(e.note||e.summary||'').slice(0,220):''}))};}
function encodeShare(obj){const json=JSON.stringify(obj);const bytes=new TextEncoder().encode(json);let bin='';bytes.forEach(b=>bin+=String.fromCharCode(b));return btoa(bin).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
function decodeShare(s){let b64=s.replace(/-/g,'+').replace(/_/g,'/');b64+='='.repeat((4-b64.length%4)%4);const bin=atob(b64);const bytes=Uint8Array.from(bin,c=>c.charCodeAt(0));return JSON.parse(new TextDecoder().decode(bytes));}
function normalizeShared(data){if(!data||typeof data!=='object')throw new Error('Invalid share');if(data.v===2){const raw=Array.isArray(data.e)?data.e.slice(0,100):[];return {title:String(data.t||'Travel map').slice(0,100),entries:raw.map(e=>({id:String(e.i||''),name:String(e.n||'Landmark').slice(0,180),city:String(e.c||'').slice(0,100),country:String(e.o||'').slice(0,100),lat:validCoord(e.a,e.g)?Number(e.a):null,lng:validCoord(e.a,e.g)?Number(e.g):null,savedAt:e.d,caption:String(e.x||'').slice(0,300)}))};}const raw=Array.isArray(data.entries)?data.entries.slice(0,100):[];return {title:String(data.title||'Travel map').slice(0,100),entries:raw.map(e=>({id:String(e.id||''),name:String(e.name||'Landmark').slice(0,180),city:String(e.city||'').slice(0,100),country:String(e.country||'').slice(0,100),lat:validCoord(e.lat,e.lng)?Number(e.lat):null,lng:validCoord(e.lat,e.lng)?Number(e.lng):null,savedAt:e.savedAt,caption:String(e.note||e.summary||'').slice(0,300)}))};}
async function shareDiary(){if(!state.entries.length){toast(t('Save a landmark first.','Önce bir yapı kaydet.'));return;}let payload=createSharePayload(40,true);let url=`${location.origin}${location.pathname}#/share/${encodeShare(payload)}`;if(url.length>12000){payload=createSharePayload(40,false);url=`${location.origin}${location.pathname}#/share/${encodeShare(payload)}`;}if(url.length>12000){payload=createSharePayload(25,false);url=`${location.origin}${location.pathname}#/share/${encodeShare(payload)}`;toast(t('The share link includes your latest 25 places to stay portable.','Paylaşım bağlantısının taşınabilir kalması için son 25 yer eklendi.'));}try{if(navigator.share){await navigator.share({title:'Lenscape travel map',text:t('See my Lenscape travel map','Lenscape seyahat haritama bak'),url});}else if(navigator.clipboard){await navigator.clipboard.writeText(url);toast(t('Share link copied.','Paylaşım bağlantısı kopyalandı.'));}else{openModal(`<h2>${t('Share link','Paylaşım bağlantısı')}</h2><div class="field"><textarea rows="5" readonly>${esc(url)}</textarea></div><button class="primary-btn" data-close>${t('Close','Kapat')}</button>`);}}catch{} }
function renderShared(encoded){let data;try{data=normalizeShared(decodeShare(encoded));}catch{app.innerHTML=`<main class="page"><div class="empty-state"><h3>${t('This travel map link is invalid.','Bu seyahat haritası bağlantısı geçersiz.')}</h3><a class="primary-btn" href="#/">Lenscape</a></div></main>`;return;}const entries=data.entries;const cities=new Set(entries.map(e=>String(e.city||'').trim().toLowerCase()).filter(Boolean)).size;app.innerHTML=`${topbar()}<main class="page"><header class="shared-hero"><div class="eyebrow">${t('Shared Lenscape journey','Paylaşılan Lenscape yolculuğu')}</div><h1>${esc(data.title)}</h1><p class="muted">${entries.length} ${t('landmarks across','yapı ·')} ${cities} ${t('cities','şehir')}</p></header><div id="share-map" class="share-map"></div><section class="section"><div class="diary-grid">${entries.map(e=>`<article class="entry-card"><div class="entry-body"><div class="entry-meta"><span>${esc([e.city,e.country].filter(Boolean).join(', '))}</span><span>${fmtDate(e.savedAt)}</span></div><h3>${esc(e.name)}</h3><p class="entry-note">${esc(e.caption)}</p></div></article>`).join('')}</div></section><div class="btn-row"><a href="#/" class="primary-btn">${t('Create my own Lenscape','Kendi Lenscape’imi oluştur')}</a></div></main>`;bindCommon();if(entries.some(e=>validCoord(e.lat,e.lng)))waitForLeaflet(()=>initMap(entries,'share-map'));}

function exportGeoJSON(){const data={type:'FeatureCollection',features:state.entries.filter(e=>validCoord(e.lat,e.lng)).map(e=>({type:'Feature',geometry:{type:'Point',coordinates:[Number(e.lng),Number(e.lat)]},properties:{name:e.name,city:e.city,country:e.country,visited:e.savedAt,note:e.note||'',summary:e.summary||'',verified:Boolean(e.verified)}}))};downloadBlob(JSON.stringify(data,null,2),'lenscape-map.geojson','application/geo+json');}
function exportKML(){const placemarks=state.entries.filter(e=>validCoord(e.lat,e.lng)).map(e=>`<Placemark><name>${xml(e.name)}</name><description>${xml(e.note||e.summary||'')}</description><Point><coordinates>${Number(e.lng)},${Number(e.lat)},0</coordinates></Point></Placemark>`).join('');downloadBlob(`<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Lenscape Travel Map</name>${placemarks}</Document></kml>`,'lenscape-map.kml','application/vnd.google-earth.kml+xml');}
function xml(s=''){return String(s).replace(/[<>&'\"]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;',"'":'&apos;','"':'&quot;'}[c]));}
function downloadBlob(text,name,type){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([text],{type}));a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);}
function exportMenu(){openModal(`<div class="modal-head"><div><div class="eyebrow">${t('Portable travel map','Taşınabilir seyahat haritası')}</div><h2>${t('Export diary','Günlüğü dışa aktar')}</h2></div><button class="close-btn" data-close>×</button></div><p class="muted">${t('Use GeoJSON in most modern mapping tools, or KML in Google Earth and compatible apps.','GeoJSON’u modern harita araçlarında, KML’yi Google Earth ve uyumlu uygulamalarda kullanabilirsin.')}</p><div class="btn-row"><button class="primary-btn" data-action="export-geojson">GeoJSON</button><button class="secondary-btn" data-action="export-kml">KML</button></div>`);}

async function syncDiscovery(entry){if(!entry.verificationToken)return;try{await fetch('/api/social',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({profile:state.profile,verificationToken:entry.verificationToken})});}catch{} }

function bindCommon(){
  $$('[data-route]').forEach(el=>el.addEventListener('click',()=>go(el.dataset.route)));
  $$('[data-action]').forEach(el=>el.addEventListener('click',async()=>{
    const a=el.dataset.action;
    if(a==='settings')openSettings();
    if(a==='capture')capture();
    if(a==='demo-scan')analyzeDataUrl(demoImageDataUrl(),true);
    if(a==='narrate')narrate(); if(a==='save-entry')saveCurrent(); if(a==='share-diary')shareDiary(); if(a==='export-menu')exportMenu(); if(a==='export-geojson')exportGeoJSON(); if(a==='export-kml')exportKML(); if(a==='edit-entry')editEntry(el.dataset.id); if(a==='delete-entry')deleteEntry(el.dataset.id);
    if(a==='save-profile'){state.profile.name=($('#profile-name').value.trim()||'Explorer').slice(0,50);let h=($('#profile-handle').value.trim()||'explorer').replace(/^@/,'').replace(/[^a-zA-Z0-9_.-]/g,'').slice(0,30)||'explorer';state.profile.handle='@'+h;saveState();toast(t('Profile saved.','Profil kaydedildi.'));}
    if(a==='clear-data'){if(confirm(t('Clear all locally saved Lenscape data?','Yerel olarak kaydedilmiş tüm Lenscape verileri silinsin mi?'))){const keep={...freshState(),language:state.language};state=keep;saveState();toast(t('Local data cleared.','Yerel veriler temizlendi.'));renderSettings();}}
  }));
  $$('[data-lang]').forEach(b=>b.addEventListener('click',()=>{state.language=b.dataset.lang;saveState();render();}));
}

window.addEventListener('hashchange',render);
window.addEventListener('beforeunload',cleanupTransient);
if('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(()=>{});
render();
