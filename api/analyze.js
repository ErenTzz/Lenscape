import { createHmac } from 'node:crypto';

const WINDOW_MS = 10 * 60 * 1000;
const MAX_SCANS_PER_WINDOW = 18;
const rateBuckets = new Map();
const json = (res, status, body) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.status(status).json(body);
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return json(res, 405, { error: 'Method not allowed' });
  }
  if (!allowRequest(req)) {
    res.setHeader('Retry-After', '60');
    return json(res, 429, { error: 'Too many scans. Please try again shortly.' });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const imageDataUrl = body.imageDataUrl;
  const language = body.language === 'tr' ? 'tr' : 'en';
  const lat = cleanCoord(body.lat, -90, 90);
  const lng = cleanCoord(body.lng, -180, 180);

  if (typeof imageDataUrl !== 'string' || !/^data:image\/(?:jpeg|png|webp);base64,/i.test(imageDataUrl)) {
    return json(res, 400, { error: 'A JPEG, PNG, or WebP image is required.' });
  }
  // Keep comfortably below common serverless request-body limits after JSON overhead.
  if (imageDataUrl.length > 4_000_000) return json(res, 413, { error: 'Image is too large.' });

  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey) {
    try {
      const result = await analyzeWithOpenAI({ imageDataUrl, lat, lng, language, apiKey });
      const normalized = normalizeResult(result, { lat, lng, mode: 'ai' });
      const verificationToken = Number(normalized.confidence) >= 0.75 ? createVerificationToken(normalized) : '';
      return json(res, 200, { ...normalized, verificationToken });
    } catch (error) {
      console.error('AI analysis failed; attempting location fallback', error?.message || error);
    }
  }

  if (validCoord(lat, lng)) {
    try {
      const result = await locationFallback({ lat, lng, language });
      return json(res, 200, normalizeResult(result, { lat, lng, mode: 'location' }));
    } catch (error) {
      console.error('Location fallback failed', error?.message || error);
    }
  }

  return json(res, 503, {
    error: apiKey
      ? 'The landmark could not be identified. Try a wider view of the facade or enable location.'
      : 'AI recognition is not configured on the server and no usable location fallback was available.'
  });
}

async function analyzeWithOpenAI({ imageDataUrl, lat, lng, language, apiKey }) {
  const locale = language === 'tr' ? 'Turkish' : 'English';
  const locationHint = validCoord(lat, lng)
    ? `The camera was near latitude ${lat.toFixed(4)}, longitude ${lng.toFixed(4)}. Use this only as corroborating evidence; return the landmark's own coordinates when you can verify them.`
    : 'No reliable GPS coordinates are available.';

  const schema = {
    type: 'object', additionalProperties: false,
    required: ['recognized','name','city','country','lat','lng','wikidataId','confidence','era','year','summary','narration','facts','sources'],
    properties: {
      recognized: { type: 'boolean' },
      name: { type: 'string' }, city: { type: 'string' }, country: { type: 'string' },
      lat: { type: ['number','null'] }, lng: { type: ['number','null'] },
      wikidataId: { type: 'string' },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      era: { type: 'string' }, year: { type: 'string' }, summary: { type: 'string' }, narration: { type: 'string' },
      facts: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'string' } },
      sources: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'object', additionalProperties: false, required: ['title','url'], properties: { title: {type:'string'}, url: {type:'string'} } } }
    }
  };

  const prompt = `Identify the exact landmark in this image. ${locationHint}\nSearch the web to verify the identity and historical facts using reputable public sources, preferring official monument/museum/city heritage sources and established reference works. Do not claim certainty when the image is ambiguous. If the exact landmark cannot be identified, set recognized=false and confidence below 0.6. The lat/lng fields should describe the landmark itself when verifiable, not merely the camera position. If the landmark has a verified Wikidata entity, return only its Q-number (for example Q123) in wikidataId; otherwise return an empty string. Write all user-facing text in ${locale}. The narration should be engaging but factual, around 90-140 words, suitable for text-to-speech. Sources must be HTTP(S) URLs you actually used for verification.`;

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-6-luna',
      store: false,
      max_output_tokens: 2200,
      reasoning: { effort: 'low' },
      tools: [{ type: 'web_search' }],
      text: { format: { type: 'json_schema', name: 'landmark_story', strict: true, schema } },
      input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }, { type: 'input_image', image_url: imageDataUrl, detail: 'high' }] }]
    }),
    signal: AbortSignal.timeout(48_000)
  });
  if (!response.ok) throw new Error(`OpenAI ${response.status}: ${truncate(await response.text(), 500)}`);
  const payload = await response.json();
  const outputText = extractOutputText(payload);
  if (!outputText) throw new Error('AI returned no structured text.');
  const parsed = JSON.parse(outputText);
  if (!parsed.recognized || Number(parsed.confidence) < 0.6) throw new Error('Low-confidence landmark identification.');
  return parsed;
}

function extractOutputText(payload) {
  if (typeof payload?.output_text === 'string' && payload.output_text.trim()) return payload.output_text.trim();
  const chunks = [];
  for (const item of payload?.output || []) {
    for (const content of item?.content || []) {
      if (content?.type === 'output_text' && typeof content.text === 'string') chunks.push(content.text);
    }
  }
  return chunks.join('').trim();
}

function normalizeResult(result, { lat, lng, mode }) {
  const out = {
    recognized: Boolean(result?.recognized),
    name: cleanText(result?.name, 180) || 'Landmark',
    city: cleanText(result?.city, 100),
    country: cleanText(result?.country, 100),
    lat: cleanCoord(result?.lat, -90, 90),
    lng: cleanCoord(result?.lng, -180, 180),
    wikidataId: /^Q\d+$/.test(String(result?.wikidataId||'').trim()) ? String(result.wikidataId).trim() : '',
    confidence: clamp(Number(result?.confidence) || (mode === 'location' ? 0.62 : 0), 0, 1),
    era: cleanText(result?.era, 120),
    year: cleanText(result?.year, 80),
    summary: cleanText(result?.summary, 1200),
    narration: cleanText(result?.narration, 1800),
    facts: Array.isArray(result?.facts) ? result.facts.map(x => cleanText(x, 350)).filter(Boolean).slice(0, 3) : [],
    sources: Array.isArray(result?.sources) ? result.sources.map(cleanSource).filter(Boolean).slice(0, 5) : [],
    mode
  };
  if (!validCoord(out.lat, out.lng) && validCoord(lat, lng)) { out.lat = lat; out.lng = lng; }
  out.landmarkId = cleanText(result?.landmarkId, 250) || stableLandmarkId(out);
  out.verified = mode === 'ai' && Number(out.confidence) >= 0.75;
  return out;
}

async function locationFallback({ lat, lng, language }) {
  const [candidates, place] = await Promise.all([nearbyLandmarks(lat, lng), reverseGeocode(lat, lng)]);
  if (!candidates.length) throw new Error('No nearby landmark candidates.');
  const chosen = candidates[0];
  const name = chosen.tags.name || chosen.tags['name:en'] || chosen.tags['name:tr'];
  if (!name) throw new Error('Nearby landmark has no usable name.');
  const wiki = await wikipediaStory(name, language, place?.city, place?.country);
  const center = chosen.center || (chosen.type === 'node' ? { lat: chosen.lat, lon: chosen.lon } : null) || { lat, lon: lng };
  const type = chosen.tags.historic || chosen.tags.tourism || chosen.tags.amenity || 'landmark';
  const facts = wiki.facts.length >= 3 ? wiki.facts.slice(0,3) : [
    language === 'tr' ? `OpenStreetMap bu noktayı “${type}” olarak sınıflandırıyor.` : `OpenStreetMap classifies this place as “${type}”.`,
    language === 'tr' ? 'Kimlik fotoğraftan değil, yakındaki konum verisinden önerildi.' : 'The identity was suggested from nearby location data rather than the photo itself.',
    language === 'tr' ? 'Bu öneri global sıralama için doğrulanmış keşif sayılmaz.' : 'This nearby suggestion does not count as a verified leaderboard discovery.'
  ];
  return {
    recognized: true, name, city: place?.city || '', country: place?.country || '', lat: center.lat, lng: center.lon,
    confidence: .62, era: wiki.era || humanize(type), year: wiki.year || '', summary: wiki.summary,
    narration: wiki.narration, facts, landmarkId: `osm:${chosen.type}/${chosen.id}`,
    sources: [{ title: 'OpenStreetMap', url: `https://www.openstreetmap.org/${chosen.type}/${chosen.id}` }, ...wiki.sources].slice(0,5)
  };
}

async function nearbyLandmarks(lat, lng) {
  const query = `[out:json][timeout:12];(nwr(around:700,${lat},${lng})[historic][name];nwr(around:700,${lat},${lng})[tourism=attraction][name];nwr(around:700,${lat},${lng})[tourism=museum][name];nwr(around:700,${lat},${lng})[amenity=place_of_worship][name];);out center tags 30;`;
  const response = await fetch('https://overpass-api.de/api/interpreter', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded','User-Agent':'Lenscape/1.1 landmark travel app'}, body:`data=${encodeURIComponent(query)}`, signal: AbortSignal.timeout(13_000) });
  if (!response.ok) throw new Error(`Overpass ${response.status}`);
  const data = await response.json();
  return (data.elements || []).filter(x=>x.tags?.name).sort((a,b)=>scoreCandidate(b,lat,lng)-scoreCandidate(a,lat,lng));
}
function scoreCandidate(x,lat,lng){const c=x.center||(x.type==='node'?{lat:x.lat,lon:x.lon}:null);const dist=c?Math.hypot(c.lat-lat,c.lon-lng):1;let s=0;if(x.tags?.historic)s+=5;if(x.tags?.tourism==='attraction')s+=4;if(x.tags?.wikidata||x.tags?.wikipedia)s+=4;s-=dist*1000;return s;}

async function reverseGeocode(lat,lng){
  try{const r=await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=12&addressdetails=1`,{headers:{'User-Agent':'Lenscape/1.1 landmark travel app','Accept-Language':'en'},signal:AbortSignal.timeout(8000)});if(!r.ok)return null;const d=await r.json();return{city:d.address?.city||d.address?.town||d.address?.municipality||d.address?.county||'',country:d.address?.country||''};}catch{return null;}
}

async function wikipediaStory(name, language, city='', country=''){
  const lang = language === 'tr' ? 'tr' : 'en';
  const query = `${name}${city?` ${city}`:''}${country?` ${country}`:''}`;
  let title=name, pageUrl='';
  try{
    const searchRes=await fetch(`https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&origin=*`,{headers:{'User-Agent':'Lenscape/1.1 landmark travel app'},signal:AbortSignal.timeout(8000)});
    if(!searchRes.ok)throw new Error('Wikipedia search failed');
    const search=await searchRes.json();
    title=search.query?.search?.[0]?.title||name;
    const summaryRes=await fetch(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g,'_'))}`,{headers:{'User-Agent':'Lenscape/1.1 landmark travel app'},signal:AbortSignal.timeout(8000)});
    if(!summaryRes.ok)throw new Error('No Wikipedia summary');
    const s=await summaryRes.json(); const extract=(s.extract||'').trim(); pageUrl=s.content_urls?.desktop?.page||`https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g,'_'))}`;
    const sentences=extract.split(/(?<=[.!?])\s+/).filter(Boolean);
    const summary=sentences.slice(0,2).join(' ')|| (lang==='tr'?`${name}, bulunduğunuz konuma yakın bir kültürel veya tarihî noktadır.`:`${name} is a cultural or historic point near your current location.`);
    const narration=sentences.slice(0,5).join(' ')||summary;
    return {summary,narration,facts:sentences.slice(1,4),sources:[{title:`Wikipedia — ${title}`,url:pageUrl}],era:'',year:''};
  }catch{
    const summary=lang==='tr'?`${name}, mevcut konum verilerine göre yakınınızdaki bir landmark adayıdır. Görsel AI yapılandırılmadığı veya kullanılamadığı için bu sonuç konum tabanlı bir öneridir.`:`${name} is a nearby landmark candidate based on your current location. Because visual AI is unavailable, this result is a location-based suggestion.`;
    return {summary,narration:summary,facts:[],sources:pageUrl?[{title:`Wikipedia — ${title}`,url:pageUrl}]:[],era:'',year:''};
  }
}

function createVerificationToken(result){
  const secret = socialSecret();
  if (!secret || result.mode !== 'ai' || Number(result.confidence) < 0.75) return '';
  const payload = {
    v:1, exp:Date.now()+10*60*1000, landmarkKey:stableLandmarkId(result),
    name:result.name, city:result.city, country:result.country,
    lat:validCoord(result.lat,result.lng)?Number(result.lat):null,
    lng:validCoord(result.lat,result.lng)?Number(result.lng):null
  };
  const encoded=Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature=createHmac('sha256',secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}
function socialSecret(){return process.env.SOCIAL_SIGNING_SECRET||process.env.SUPABASE_SERVICE_ROLE_KEY||process.env.SUPABASE_SECRET_KEY||'';}
function stableLandmarkId(r){if(r?.landmarkId)return cleanText(r.landmarkId,250);if(/^Q\d+$/.test(String(r?.wikidataId||'')))return `wikidata:${r.wikidataId}`;const named=`${slug(r?.name)}|${slug(r?.city)}|${slug(r?.country)}`;if(named.replace(/\|/g,''))return named;if(validCoord(r?.lat,r?.lng))return `coord:${Number(r.lat).toFixed(4)},${Number(r.lng).toFixed(4)}`;return 'landmark';}
function slug(v=''){return String(v).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,'');}
function cleanSource(s){if(!s||typeof s!=='object')return null;try{const u=new URL(String(s.url||''));if(!/^https?:$/.test(u.protocol))return null;return {title:cleanText(s.title,180)||u.hostname,url:u.href};}catch{return null;}}
function cleanText(v,max){return String(v??'').replace(/[\u0000-\u001F\u007F]/g,' ').replace(/\s+/g,' ').trim().slice(0,max);}
function cleanCoord(v,min,max){const n=Number(v);return Number.isFinite(n)&&n>=min&&n<=max?n:null;}
function validCoord(lat,lng){return cleanCoord(lat,-90,90)!==null&&cleanCoord(lng,-180,180)!==null;}
function clamp(v,min,max){return Math.min(max,Math.max(min,v));}
function truncate(v,max){const s=String(v||'');return s.length>max?s.slice(0,max)+'…':s;}
function humanize(v='landmark'){return v.replace(/_/g,' ').replace(/\b\w/g,c=>c.toUpperCase());}
function allowRequest(req){
  const forwarded=String(req.headers?.['x-forwarded-for']||req.socket?.remoteAddress||'unknown').split(',')[0].trim();
  const now=Date.now();
  pruneRateBuckets(now);
  const bucket=rateBuckets.get(forwarded);
  if(!bucket||now-bucket.start>WINDOW_MS){rateBuckets.set(forwarded,{start:now,count:1});return true;}
  bucket.count+=1;
  return bucket.count<=MAX_SCANS_PER_WINDOW;
}
function pruneRateBuckets(now){if(rateBuckets.size<5000)return;for(const [k,v] of rateBuckets){if(now-v.start>WINDOW_MS)rateBuckets.delete(k);}if(rateBuckets.size>6000)rateBuckets.clear();}
