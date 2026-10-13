'use strict';
// TEAM DDC 조회 전용 — 암호화된 파일을 받아서 브라우저 안에서만 풀어 주는 서비스 워커
const SCOPE = new URL(self.registration.scope);
const QP = {'api/day': 'date', 'api/moments': 'date', 'api/replay': 'id', 'api/map': 'code'};
let KEY = null, MAN = null, MAN_T = 0;
function idb(){return new Promise((res,rej)=>{const r=indexedDB.open('ddc-view',1);r.onupgradeneeded=()=>r.result.createObjectStore('k');r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error);});}
async function getKey(){
  if (KEY) return KEY;
  const d = await idb();
  KEY = await new Promise(res => { const r = d.transaction('k').objectStore('k').get('key'); r.onsuccess = () => res(r.result || null); r.onerror = () => res(null); });
  return KEY;
}
async function dropKey(){ KEY = null; MAN = null; try { const d = await idb(); d.transaction('k','readwrite').objectStore('k').delete('key'); } catch {} }
async function open(buf, key){ const u = new Uint8Array(buf); return crypto.subtle.decrypt({name:'AES-GCM', iv:u.slice(0,12)}, key, u.slice(12)); }
async function manifest(force){
  if (!force && MAN && Date.now() - MAN_T < 15000) return MAN;
  const key = await getKey(); if (!key) throw new Error('nokey');
  const r = await fetch(new URL('m.bin', SCOPE), {cache: 'no-cache'});
  if (!r.ok) throw new Error('목록을 받지 못했어요 (' + r.status + ')');
  MAN = JSON.parse(new TextDecoder().decode(await open(await r.arrayBuffer(), key)));
  MAN_T = Date.now(); return MAN;
}
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('message', e => { if (e.data === 'reset') { KEY = null; MAN = null; } });
const jerr = (code, msg) => new Response(JSON.stringify({error: msg}), {status: code, headers: {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'}});
function respond(req, buf, type){
  const h = {'Content-Type': type, 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes'}, total = buf.byteLength;
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('range') || '');
  if (!m) return new Response(buf, {status: 200, headers: h});
  let s, e;
  if (m[1] === '') { s = Math.max(0, total - +m[2]); e = total - 1; } else { s = +m[1]; e = m[2] === '' ? total - 1 : Math.min(+m[2], total - 1); }
  if (s > e || s >= total) return new Response(null, {status: 416, headers: {'Content-Range': 'bytes */' + total}});
  return new Response(buf.slice(s, e + 1), {status: 206, headers: {...h, 'Content-Range': `bytes ${s}-${e}/${total}`}});
}
async function serve(req, rel, sp){
  const q = QP[rel], k = q ? rel + '?' + q + '=' + (sp.get(q) || '') : rel;
  try {
    let man = await manifest(false), ent = man.files[k];
    if (!ent) { man = await manifest(true); ent = man.files[k]; }
    if (!ent) return jerr(404, '관리자가 아직 이 기록을 올리지 않았어요.');
    let r = await fetch(new URL(ent[0], SCOPE));
    if (!r.ok) {   // 그 사이 새로 올라와서 파일 이름이 바뀐 경우
      man = await manifest(true); ent = man.files[k];
      if (!ent) return jerr(404, '관리자가 아직 이 기록을 올리지 않았어요.');
      r = await fetch(new URL(ent[0], SCOPE));
      if (!r.ok) return jerr(502, '파일을 받지 못했어요 (' + r.status + ')');
    }
    let buf = await open(await r.arrayBuffer(), await getKey());
    if (ent[2]) buf = await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    return respond(req, buf, ent[1]);
  } catch (e) {
    if (e.message === 'nokey' || e.name === 'OperationError') { await dropKey(); return jerr(401, '비밀번호를 다시 입력해 주세요.'); }
    return jerr(502, '기록을 불러오지 못했어요 (' + (e.message || e) + ')');
  }
}
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin || !u.pathname.startsWith(SCOPE.pathname)) return;
  const rel = decodeURIComponent(u.pathname.slice(SCOPE.pathname.length)).normalize('NFC');
  if (/^(api|images|sounds)\//.test(rel)) e.respondWith(serve(e.request, rel, u.searchParams));
});
