import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

const COOKIE = 'lenscape_explorer';
const WINDOW_MS = 10 * 60 * 1000;
const MAX_WRITES_PER_WINDOW = 40;
const rateBuckets = new Map();
const json=(res,status,body)=>{res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/json; charset=utf-8');return res.status(status).json(body);};
function cfg(){return {url:process.env.SUPABASE_URL,key:process.env.SUPABASE_SERVICE_ROLE_KEY||process.env.SUPABASE_SECRET_KEY,secret:process.env.SOCIAL_SIGNING_SECRET||process.env.SUPABASE_SERVICE_ROLE_KEY||process.env.SUPABASE_SECRET_KEY};}
function headers(key,extra={}){return {'apikey':key,'Authorization':`Bearer ${key}`,'Content-Type':'application/json',...extra};}

export default async function handler(req,res){
  const {url,key,secret}=cfg();
  if(!url||!key||!secret)return json(res,503,{error:'Cloud leaderboard is not configured.'});
  try{
    if(req.method==='GET'){
      const r=await fetch(`${url}/rest/v1/leaderboard_stats?select=display_name,username,unique_landmarks,cities,countries&unique_landmarks=gt.0&order=unique_landmarks.desc&limit=50`,{headers:headers(key),signal:AbortSignal.timeout(10_000)});
      if(!r.ok)throw new Error(await r.text());
      return json(res,200,{rows:await r.json()});
    }
    if(req.method==='POST'){
      if(!allowWrite(req)){res.setHeader('Retry-After','60');return json(res,429,{error:'Too many leaderboard updates.'});}
      const {profile,verificationToken}=req.body&&typeof req.body==='object'?req.body:{};
      const verified=verifyDiscoveryToken(verificationToken,secret);
      if(!verified)return json(res,422,{error:'A valid verified scan is required for leaderboard credit.'});

      const explorerId=getOrCreateExplorerId(req,res,secret);
      const displayName=cleanText(profile?.name||'Explorer',50)||'Explorer';
      const username=(cleanText(profile?.handle||'explorer',60).replace(/^@/,'').replace(/[^a-zA-Z0-9_.-]/g,'').slice(0,30)||'explorer');
      const p=await fetch(`${url}/rest/v1/explorers?on_conflict=id`,{method:'POST',headers:headers(key,{'Prefer':'resolution=merge-duplicates,return=minimal'}),body:JSON.stringify({id:explorerId,display_name:displayName,username,updated_at:new Date().toISOString()}),signal:AbortSignal.timeout(10_000)});
      if(!p.ok)throw new Error(await p.text());

      const verificationHash=createHash('sha256').update(String(verificationToken)).digest('hex');
      const d=await fetch(`${url}/rest/v1/discoveries?on_conflict=explorer_id,landmark_key`,{method:'POST',headers:headers(key,{'Prefer':'resolution=ignore-duplicates,return=minimal'}),body:JSON.stringify({
        explorer_id:explorerId,
        landmark_key:cleanText(verified.landmarkKey,250),
        landmark_name:cleanText(verified.name,180),
        city:cleanText(verified.city,100),
        country:cleanText(verified.country,100),
        lat:validCoord(verified.lat,verified.lng)?Number(verified.lat):null,
        lng:validCoord(verified.lat,verified.lng)?Number(verified.lng):null,
        verification_hash:verificationHash
      }),signal:AbortSignal.timeout(10_000)});
      if(!d.ok){
        const message=await d.text();
        if(message.includes('verification_hash'))return json(res,200,{ok:true,duplicate:true});
        throw new Error(message);
      }
      return json(res,200,{ok:true});
    }
    res.setHeader('Allow','GET, POST');
    return json(res,405,{error:'Method not allowed'});
  }catch(error){console.error('Social sync failed',error?.message||error);return json(res,500,{error:'Social sync failed.'});}
}

function verifyDiscoveryToken(token,secret){
  try{
    if(typeof token!=='string'||token.length>3000)return null;
    const [encoded,signature,...rest]=token.split('.');if(!encoded||!signature||rest.length)return null;
    const expected=createHmac('sha256',secret).update(encoded).digest('base64url');
    if(!safeEqual(signature,expected))return null;
    const payload=JSON.parse(Buffer.from(encoded,'base64url').toString('utf8'));
    if(payload?.v!==1||!payload.exp||Date.now()>Number(payload.exp)||Number(payload.exp)-Date.now()>11*60*1000)return null;
    if(!payload.landmarkKey||!payload.name)return null;
    return payload;
  }catch{return null;}
}
function getOrCreateExplorerId(req,res,secret){
  const cookies=parseCookies(req.headers?.cookie||'');
  const existing=verifyExplorerCookie(cookies[COOKIE],secret);
  if(existing)return existing;
  const id=randomUUID();const sig=createHmac('sha256',secret).update(id).digest('base64url');
  const secure=(process.env.VERCEL||String(req.headers?.['x-forwarded-proto']||'').toLowerCase()==='https')?' Secure;':'';
  res.setHeader('Set-Cookie',`${COOKIE}=${id}.${sig}; Path=/; Max-Age=31536000; HttpOnly;${secure} SameSite=Lax`);
  return id;
}
function verifyExplorerCookie(value,secret){
  if(!value)return null;const [id,sig,...rest]=String(value).split('.');if(!id||!sig||rest.length)return null;
  const expected=createHmac('sha256',secret).update(id).digest('base64url');return safeEqual(sig,expected)?id:null;
}
function parseCookies(raw){const out={};for(const part of String(raw).split(';')){const i=part.indexOf('=');if(i>0){try{out[part.slice(0,i).trim()]=decodeURIComponent(part.slice(i+1).trim());}catch{}}}return out;}
function safeEqual(a,b){try{const aa=Buffer.from(a),bb=Buffer.from(b);return aa.length===bb.length&&timingSafeEqual(aa,bb);}catch{return false;}}
function cleanText(v,max){return String(v??'').replace(/[\u0000-\u001F\u007F]/g,' ').replace(/\s+/g,' ').trim().slice(0,max);}
function validCoord(lat,lng){const a=Number(lat),b=Number(lng);return Number.isFinite(a)&&Number.isFinite(b)&&a>=-90&&a<=90&&b>=-180&&b<=180;}
function allowWrite(req){const key=String(req.headers?.['x-forwarded-for']||req.socket?.remoteAddress||'unknown').split(',')[0].trim();const now=Date.now();pruneRateBuckets(now);const b=rateBuckets.get(key);if(!b||now-b.start>WINDOW_MS){rateBuckets.set(key,{start:now,count:1});return true;}b.count+=1;return b.count<=MAX_WRITES_PER_WINDOW;}
function pruneRateBuckets(now){if(rateBuckets.size<5000)return;for(const [k,v] of rateBuckets){if(now-v.start>WINDOW_MS)rateBuckets.delete(k);}if(rateBuckets.size>6000)rateBuckets.clear();}
