import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, f), 'utf8'));

// .env (без зависимостей)
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
} catch {}

const PORT = +process.env.PORT || 3000;
const POLL = (+process.env.POLL_SECONDS || 60) * 1000;
const KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;
const MAX_AGE = 24 * 3600 * 1000;
const DB = path.join(__dirname, 'data', 'news.json');

const sources = read('sources.json');
const topics = read('topics.json');
const CATEGORIES = ['conflicts', 'statements', 'markets', 'tech'];

let news = [];
try { news = JSON.parse(fs.readFileSync(DB, 'utf8')); } catch {}
const seen = new Set(news.map((n) => n.id));
const clients = new Set();

// ---------- разбор источников ----------
const decode = (s = '') => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&#0?39;/g, "'").replace(/&#(\d+);/g, (_, c) => String.fromCharCode(c))
  .replace(/\s+/g, ' ').trim();

const tag = (x, t) => (x.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, 'i')) || [])[1];

async function get(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 NewsMonitor/0.1' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

async function fetchRss(src) {
  const xml = await get(src.rss);
  const items = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) || [];
  return items.slice(0, 25).map((it) => {
    const date = new Date(decode(tag(it, 'pubDate') || tag(it, 'published') || tag(it, 'updated') || ''));
    const link = decode(tag(it, 'link')) || (it.match(/<link[^>]*href="([^"]+)"/i) || [])[1];
    const desc = decode(tag(it, 'description') || tag(it, 'summary') || tag(it, 'content') || '');
    return { source: src.name, title: decode(tag(it, 'title')), text: desc, url: link, time: date.getTime(), html: it };
  });
}

async function fetchTelegram(src) {
  const html = await get(`https://t.me/s/${src.channel}`);
  const blocks = html.split('tgme_widget_message_wrap').slice(1);
  return blocks.map((b) => {
    const post = (b.match(/data-post="([^"]+)"/) || [])[1];
    const text = decode((b.match(/tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/) || [])[1] || '');
    const dt = (b.match(/<time[^>]*datetime="([^"]+)"/) || [])[1];
    const ext = (b.match(/tgme_widget_message_text[\s\S]*?<a [^>]*href="(https?:\/\/(?!t\.me)[^"]+)"/) || [])[1];
    return { source: src.name, title: '', text, url: post ? `https://t.me/${post}` : null, primary: ext, time: dt ? Date.parse(dt) : NaN };
  }).filter((x) => x.text);
}

// ---------- обработка: перевод, сжатие, классификация ----------
// Слова ищутся с начала слова (не «war» внутри «warns»); окончания допускаются: «missile» → «missiles».
// Вес: 3 — однозначный признак, 2 — сильный, 1 — слабый. Заголовок весит вдвое больше текста.
const RULES = {
  conflicts: [
    [3, 'war!', 'wars!', 'airstrike', 'missile', 'rocket', 'shelling', 'invasion', 'invade', 'ceasefire', 'hostage', 'idf!', 'irgc', 'hamas', 'hezbollah', 'houthi', 'военн', 'войн', 'ракет', 'обстрел', 'перемири', 'хусит', 'хамас', 'ксир'],
    [2, 'troops', 'military', 'army!', 'drone', 'soldier', 'militant', 'bombing', 'airstrikes', 'gaza', 'west bank', 'frontline', 'армия', 'войск', 'беспилотн', 'дрон', 'сектор газа', 'сектора газа'],
    [1, 'attack', 'strike', 'killed', 'weapon', 'nuclear', 'sanction', 'атак', 'удар', 'санкци'],
  ],
  markets: [
    [3, 'oil price', 'brent', 'crude', 'opec', 'gold price', 'barrel', 'нефт', 'баррел', 'опек'],
    [2, 'gold!', 'silver', 'platinum', 'commodit', 'stocks', 'markets', 'золот', 'серебр', 'платин', 'бирж'],
    [1, 'price', 'inflation', 'tariff', 'dollar', 'цен', 'инфляц', 'пошлин'],
  ],
  statements: [
    [3, 'iaea', 'grossi', 'tedros', 'guterres', 'united nations', 'security council', 'world health organization', 'магатэ', 'оон!', 'воз!', 'генсек'],
    [2, 'statement', 'warns', 'urges', 'calls for', 'condemn', 'announce', 'deal!', 'talks', 'summit', 'diplomac', 'minister', 'president', 'white house', 'kremlin', 'заявлени', 'заявил', 'призвал', 'осудил', 'переговор', 'саммит', 'министр', 'президент'],
    [1, 'said', 'says', 'official', 'proposal', 'offer', 'election', 'government', 'сообщил', 'предлож', 'правительств'],
  ],
  tech: [
    [3, 'artificial intelligence', 'spacecraft', 'nasa', 'robot', 'startup', 'smartphone', 'искусственн', 'космос', 'робот'],
    [2, 'ai!', 'tech', 'launch', 'scientist', 'discover', 'vaccine', 'rescue', 'record', 'учён', 'открыт', 'вакцин', 'спас'],
  ],
};
const URGENT_WORDS = ['earthquake', 'tsunami', 'flood', 'hurricane', 'typhoon', 'cyclone', 'wildfire', 'landslide', 'eruption', 'explosion', 'blast', 'plane crash', 'airstrike', 'missile', 'invasion', 'invade', 'terror', 'massacre', 'death toll', 'dozens killed', 'breaking', 'землетряс', 'цунами', 'наводнен', 'ураган', 'взрыв', 'теракт', 'нападени', 'вторжени', 'ракетн', 'погибл', 'срочно'];
const words = (list) => new RegExp(`(?<![\\p{L}\\p{N}])(${list.map((w) => w.replace(/!$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + (w.endsWith('!') ? '(?![\\p{L}\\p{N}])' : '')).join('|')})`, 'giu');
const RULE_RE = Object.fromEntries(Object.entries(RULES).map(([c, groups]) => [c, groups.map(([w, ...l]) => [w, words(l)])]));
const URGENT_RE = words(URGENT_WORDS);
const SOURCE_HINT = { 'ВОЗ': 'statements', 'ООН': 'statements', 'МАГАТЭ': 'statements', 'IDF': 'conflicts', 'КСИР': 'conflicts' };

function classify(item) {
  const score = (s) => Object.fromEntries(Object.entries(RULE_RE).map(([c, gs]) => [c, gs.reduce((a, [w, re]) => a + w * (s.match(re) || []).length, 0)]));
  const t = score(item.title || ''), b = score(item.text || '');
  const total = Object.fromEntries(Object.keys(RULES).map((c) => [c, 2 * t[c] + b[c]]));
  const hint = SOURCE_HINT[item.source.replace(' (TG)', '')];
  if (hint) total[hint] += 2;
  const [best, s] = Object.entries(total).sort((x, y) => y[1] - x[1])[0];
  return s >= 3 ? best : 'tech';
}

function heuristic(item) {
  const t = `${item.title} ${item.text}`;
  const category = classify(item);
  const urgent = (t.match(URGENT_RE) || []).length > 0 && !/\b(anniversary|years after|remember|documentary|годовщин)/i.test(t);
  return heuristicOut(item, category, urgent);
}

function heuristicOut(item, category, urgent) {
  const dup = item.title && item.text.startsWith(item.title.slice(0, 40));
  const summary = dup ? item.title : (item.title ? `${item.title}. ` : '') + item.text;
  return { summary: summary.slice(0, 400), category, urgent, translated: false };
}

async function enrich(item) {
  const base = heuristic(item);
  // убираем хвост « - AP News» / « - Reuters» от Google News
  base.summary = base.summary.replace(/\s+-\s+(AP News|Reuters|AP)\s*$/, '');
  let out = base;
  if (KEY) {
    try {
      const prompt = `Ты помощник редактора международного отдела ТВ-канала. Новость (язык любой):\nИсточник: ${item.source}\nЗаголовок: ${item.title}\nТекст: ${item.text.slice(0, 3000)}\n\nВерни ТОЛЬКО JSON: {"summary":"грамотное изложение на русском в 2-3 предложениях, только главные факты","category":"conflicts|statements|markets|tech","urgent":true|false}\ncategory: conflicts — военные и силовые темы; statements — официальные заявления МАГАТЭ/ООН/ВОЗ и др.; markets — нефть и драгметаллы; tech — технологии и позитивные новости. urgent=true только для катастроф, наводнений, землетрясений, нападений на страны и подобных экстренных событий.`;
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: MODEL, max_tokens: 500, messages: [{ role: 'user', content: prompt }] }),
        signal: AbortSignal.timeout(30000),
      });
      const j = await r.json();
      const p = JSON.parse(j.content[0].text.match(/\{[\s\S]*\}/)[0]);
      if (p.summary) out = { summary: p.summary, category: CATEGORIES.includes(p.category) ? p.category : base.category, urgent: !!p.urgent, translated: true };
    } catch (e) { console.error('Claude:', e.message); }
  }
  const hay = `${item.title} ${item.text} ${item.source}`.toLowerCase();
  const tags = topics.filter((tp) => tp.keywords.some((k) => hay.includes(k.toLowerCase()))).map((tp) => tp.id);
  // первоисточник: внешняя ссылка из поста/статьи
  let primary = item.primary;
  if (!primary && item.html) {
    const m = item.html.match(/href=["'](https?:\/\/[^"']+)["']/gi) || [];
    const host = item.url ? new URL(item.url).host : '';
    const l = m.map((x) => x.slice(6, -1)).find((u) => { try { return new URL(u).host !== host && !/google\.com|feedburner/.test(u); } catch { return false; } });
    primary = l;
  }
  return { ...out, tags, primary: primary || null };
}

// ---------- цикл опроса ----------
function broadcast(n) {
  for (const c of clients) c.write(`data: ${JSON.stringify(n)}\n\n`);
}

async function notify(n) {
  if (!TG_TOKEN || !TG_CHAT || !(n.urgent || n.tags.length)) return;
  const text = `${n.urgent ? '🔴 СРОЧНО\n' : ''}[${n.source}] ${n.summary}\n${n.url || ''}`;
  fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: TG_CHAT, text }),
  }).catch(() => {});
}

let polling = false;
async function poll() {
  if (polling) return;
  polling = true;
  const jobs = [...sources.sites.map((s) => [s, fetchRss]), ...sources.telegram.map((s) => [s, fetchTelegram])];
  const results = await Promise.allSettled(jobs.map(([s, f]) => f(s)));
  const fresh = [];
  results.forEach((r, i) => {
    if (r.status === 'rejected') return console.error(`[${jobs[i][0].name}] ${r.reason.message}`);
    for (const it of r.value) {
      if (!it.url || !Number.isFinite(it.time) || Date.now() - it.time > MAX_AGE) continue;
      const id = it.url;
      if (seen.has(id)) continue;
      seen.add(id);
      fresh.push(it);
    }
  });
  fresh.sort((a, b) => a.time - b.time);
  for (const it of fresh) {
    const e = await enrich(it);
    const n = { id: it.url, source: it.source, time: it.time, url: it.url, ...e };
    news.push(n);
    broadcast(n);
    notify(n);
  }
  news = news.filter((n) => Date.now() - n.time < MAX_AGE * 3).sort((a, b) => b.time - a.time).slice(0, 1000);
  if (fresh.length) fs.writeFileSync(DB, JSON.stringify(news));
  console.log(`${new Date().toLocaleTimeString()} опрос: +${fresh.length}, всего ${news.length}`);
  polling = false;
}

// ---------- HTTP ----------
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/news') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ news: [...news].sort((a, b) => b.time - a.time), topics: topics.map(({ id, name }) => ({ id, name })), ai: !!KEY }));
  }
  if (u.pathname === '/api/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(': ok\n\n');
    clients.add(res);
    const ka = setInterval(() => res.write(': ka\n\n'), 25000);
    return req.on('close', () => { clients.delete(res); clearInterval(ka); });
  }
  const f = path.join(__dirname, 'public', u.pathname === '/' ? 'index.html' : path.normalize(u.pathname).replace(/^(\.\.[\\/])+/, ''));
  fs.readFile(f, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': mime[path.extname(f)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, () => console.log(`Монитор новостей: http://localhost:${PORT}  (ИИ-режим: ${KEY ? 'вкл' : 'выкл — нужен ANTHROPIC_API_KEY'})`));

poll();
setInterval(poll, POLL);
