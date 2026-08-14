/* ============================================================
   build.js — 部署時自動執行（build command: npm run build）
   1. 讀 content/ 的診所資料、公告、文章、分類
   2. 產生 data/*.json 與 data/content.js 給首頁讀取
   3. 為每篇文章產生真實網址 article/<slug>/index.html（SEO 用）
   4. 抽出 styles.css、產生 sitemap.xml
   零相依套件，只用 Node 內建模組。診所人員不需要理解此檔。
   ============================================================ */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const ART_DIR = path.join(ROOT, 'content', 'articles');
const DATA_DIR = path.join(ROOT, 'data');
const ART_OUT = path.join(ROOT, 'article');
fs.mkdirSync(DATA_DIR, { recursive: true });

/* ---------- 診所基本資料（後台「診所資料」可編輯） ---------- */
const SITE_SRC = path.join(ROOT, 'content', 'site.json');
let SITE = {};
if (fs.existsSync(SITE_SRC)) {
  try { SITE = JSON.parse(fs.readFileSync(SITE_SRC, 'utf8')); }
  catch (e) { console.error('site.json 格式錯誤：', e.message); process.exit(1); }
} else {
  console.error('找不到 content/site.json，請先建立。'); process.exit(1);
}
const BASE = (SITE.baseUrl || '').replace(/\/+$/, '');

/* ---------- frontmatter 解析（支援 YAML 列表） ---------- */
function parseFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: raw };
  const meta = {};
  const lines = m[1].split(/\r?\n/);
  let curKey = null;
  const unquote = s => s.trim().replace(/^["']|["']$/g, '');

  for (const line of lines) {
    if (!line.trim()) continue;
    const li = line.match(/^\s*-\s+(.*)$/);
    if (li && curKey) {
      if (!Array.isArray(meta[curKey])) meta[curKey] = [];
      meta[curKey].push(unquote(li[1]));
      continue;
    }
    const i = line.indexOf(':');
    if (i === -1) continue;
    const key = line.slice(0, i).trim();
    let val = unquote(line.slice(i + 1));
    if (val === '') { curKey = key; meta[key] = ''; continue; }
    curKey = null;
    if (val === 'true') val = true;
    else if (val === 'false') val = false;
    meta[key] = val;
  }
  return { meta, body: m[2].trim() };
}

/* ---------- 工具 ---------- */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
/* 只允許安全的連結協定，擋掉 javascript: 之類 */
function safeUrl(u) {
  const s = String(u || '').trim();
  if (/^(https?:|mailto:|tel:|\/|#|\.)/i.test(s)) return s;
  return '#';
}
function plain(html, max) {
  const t = String(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}
/* ---------- 網址代稱：太長的中文檔名會產生 400+ 字元的網址 ----------
   優先順序：frontmatter 的 slug 欄位 > 自動截短檔名
   一旦產生就不要再改，否則舊連結會失效。                              */
const SLUG_MAX = 22;                       // 日期後面最多保留幾個字
function makeSlug(filename, metaSlug, used) {
  let base;
  if (metaSlug) {
    base = String(metaSlug).trim();
  } else {
    const m = filename.match(/^(\d{4}-\d{2}-\d{2})-([\s\S]*)$/);
    const datePart = m ? m[1] : '';
    let rest = (m ? m[2] : filename)
      .replace(/[，。、？！；：「」『』（）《》〈〉—…·,.?!;:'"()\[\]{}]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    if (rest.length > SLUG_MAX) rest = rest.slice(0, SLUG_MAX).replace(/-$/, '');
    base = datePart ? (rest ? datePart + '-' + rest : datePart) : rest;
  }
  let slug = base, n = 2;
  while (used.has(slug)) { slug = base + '-' + (n++); }
  used.add(slug);
  return slug;
}

function absUrl(u) {
  if (!u) return '';
  if (/^https?:/i.test(u)) return u;
  return BASE + (u.startsWith('/') ? u : '/' + u);
}

/* ---------- 極簡 Markdown → HTML ---------- */
function inline(s) {
  return esc(s)
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g,
      (_, alt, src) => '<img src="' + esc(safeUrl(src)) + '" alt="' + alt + '" loading="lazy">')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g,
      (_, txt, href) => '<a href="' + esc(safeUrl(href)) + '" target="_blank" rel="noopener">' + txt + '</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}
function mdToHtml(md) {
  const blocks = md.split(/\r?\n\r?\n+/);
  return blocks.map(b => {
    const t = b.trim();
    if (!t) return '';
    if (/^###\s+/.test(t)) return '<h4>' + inline(t.replace(/^###\s+/, '')) + '</h4>';
    if (/^##\s+/.test(t)) return '<h3>' + inline(t.replace(/^##\s+/, '')) + '</h3>';
    if (/^#\s+/.test(t)) return '<h2>' + inline(t.replace(/^#\s+/, '')) + '</h2>';
    if (t.split(/\r?\n/).every(l => /^[-*]\s+/.test(l.trim()))) {
      const items = t.split(/\r?\n/).map(l => '<li>' + inline(l.trim().replace(/^[-*]\s+/, '')) + '</li>').join('');
      return '<ul>' + items + '</ul>';
    }
    return '<p>' + t.split(/\r?\n/).map(inline).join('<br>') + '</p>';
  }).filter(Boolean).join('\n');
}

/* ---------- 文章 ---------- */
const articles = [];
const usedSlugs = new Set();
if (fs.existsSync(ART_DIR)) {
  for (const f of fs.readdirSync(ART_DIR).sort()) {
    if (!f.endsWith('.md')) continue;
    const raw = fs.readFileSync(path.join(ART_DIR, f), 'utf8');
    const { meta, body } = parseFrontmatter(raw);
    const dateStr = String(meta.date || '').slice(0, 10);
    let tags = [];
    const cat = meta.category;
    if (Array.isArray(cat)) tags = cat;
    else if (typeof cat === 'string') {
      const s = cat.trim().replace(/^\[|\]$/g, '');
      tags = s.split(/[,、]/).map(t => t.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    }
    if (!tags.length) tags = ['未分類'];
    const html = mdToHtml(body);
    const rawName = f.replace(/\.md$/, '');
    articles.push({
      slug: makeSlug(rawName, meta.slug, usedSlugs),
      rawName: rawName,
      title: meta.title || f,
      date: dateStr,
      tags: tags,
      author: meta.author || SITE.name || '',
      excerpt: meta.excerpt || plain(html, 110),
      thumbnail: meta.thumbnail || '',
      html: html
    });
  }
}
articles.sort((a, b) => b.date.localeCompare(a.date));
const articlesOut = articles.map(a => { const o = Object.assign({}, a); delete o.rawName; return o; });
fs.writeFileSync(path.join(DATA_DIR, 'articles.json'), JSON.stringify(articlesOut, null, 2));

/* ---------- 公告 ---------- */
const annSrc = path.join(ROOT, 'content', 'announcements.json');
let ann = { items: [] };
if (fs.existsSync(annSrc)) {
  try { ann = JSON.parse(fs.readFileSync(annSrc, 'utf8')); }
  catch (e) { console.error('announcements.json 格式錯誤：', e.message); process.exit(1); }
}
ann.items = (ann.items || []).sort((a, b) => String(b.date).localeCompare(String(a.date)));
fs.writeFileSync(path.join(DATA_DIR, 'announcements.json'), JSON.stringify(ann, null, 2));

/* ---- content.js：首頁一次讀到所有內容（本機雙擊預覽也能動） ---- */
const contentJs =
  'window.__SITE__ = ' + JSON.stringify(SITE) + ';\n' +
  'window.__ANNOUNCEMENTS__ = ' + JSON.stringify(ann) + ';\n' +
  'window.__ARTICLES__ = ' + JSON.stringify(articlesOut) + ';\n';
fs.writeFileSync(path.join(DATA_DIR, 'content.js'), contentJs);

/* ============================================================
   SEO：抽出 styles.css、產生文章實體頁、sitemap.xml
   ============================================================ */
const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const styleMatch = indexHtml.match(/<style>([\s\S]*?)<\/style>/);
if (!styleMatch) { console.error('index.html 找不到 <style> 區塊'); process.exit(1); }
fs.writeFileSync(path.join(ROOT, 'styles.css'), styleMatch[1].trim() + '\n');

function headerHtml() {
  return '<div class="topbar">\n' +
    '  <div class="wrap">\n' +
    '    <span>📞 <a href="tel:' + esc(SITE.phoneLink) + '">' + esc(SITE.phone) + '</a>　' + esc(SITE.address) + '</span>\n' +
    '    <span><a href="' + esc(safeUrl(SITE.facebook)) + '" target="_blank" rel="noopener">Facebook 粉絲專頁</a>　|　<a href="' + esc(safeUrl(SITE.line)) + '" target="_blank" rel="noopener">LINE 加好友</a></span>\n' +
    '  </div>\n</div>\n' +
    '<header>\n  <div class="wrap nav">\n' +
    '    <a class="brand" href="/#home"><img class="logo" src="/images/logo.png" alt="' + esc(SITE.name) + ' Logo">' + esc(SITE.name) + '</a>\n' +
    '    <ul class="menu">\n' +
    '      <li><a href="/#home">首頁</a></li>\n' +
    '      <li><a href="/#team">醫療團隊</a></li>\n' +
    '      <li><a href="/#news">健康新知</a></li>\n' +
    '      <li><a href="' + esc(safeUrl(SITE.booking)) + '" target="_blank" rel="noopener">線上預約</a></li>\n' +
    '    </ul>\n  </div>\n</header>';
}
function footerHtml() {
  return '<footer>\n  <div class="wrap">\n' +
    '    <div class="brand"><img class="logo" src="/images/logo.png" alt="">' + esc(SITE.name) + '</div>\n' +
    '    <p>' + esc(SITE.address) + '</p>\n' +
    '    <p style="margin-top:8px"><a href="' + esc(safeUrl(SITE.facebook)) + '" target="_blank" rel="noopener">Facebook</a>　|　<a href="' + esc(safeUrl(SITE.line)) + '" target="_blank" rel="noopener">LINE</a>　|　<a href="' + esc(safeUrl(SITE.booking)) + '" target="_blank" rel="noopener">線上預約</a></p>\n' +
    '    <p style="margin-top:14px;font-size:12.5px;color:#8fa79c">© ' + esc(SITE.name) + ' All Rights Reserved.</p>\n' +
    '  </div>\n</footer>';
}
function shareHtml(url, title) {
  const u = encodeURIComponent(url), t = encodeURIComponent(title);
  return '<div class="share">\n  <div class="lbl">分享這篇文章</div>\n  <div class="share-btns">\n' +
    '    <a class="sbtn threads" target="_blank" rel="noopener" href="https://www.threads.net/intent/post?text=' + t + '%0A' + u + '">Threads</a>\n' +
    '    <a class="sbtn fb" target="_blank" rel="noopener" href="https://www.facebook.com/sharer/sharer.php?u=' + u + '">Facebook</a>\n' +
    '    <a class="sbtn line" target="_blank" rel="noopener" href="https://social-plugins.line.me/lineit/share?url=' + u + '&amp;text=' + t + '">LINE</a>\n' +
    '    <button class="sbtn copy" onclick="navigator.clipboard.writeText(location.href);this.textContent=\'已複製\'">複製連結</button>\n' +
    '  </div>\n</div>';
}

fs.rmSync(ART_OUT, { recursive: true, force: true });
fs.mkdirSync(ART_OUT, { recursive: true });

for (const a of articles) {
  const url = BASE + '/article/' + encodeURIComponent(a.slug) + '/';
  const desc = plain(a.excerpt || a.html, 150);
  const img = absUrl(a.thumbnail || SITE.ogImage || '/images/logo.png');

  const jsonld = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: a.title,
    description: desc,
    datePublished: a.date,
    author: { '@type': 'Person', name: a.author },
    publisher: {
      '@type': 'MedicalClinic',
      name: SITE.name,
      logo: { '@type': 'ImageObject', url: absUrl('/images/logo.png') }
    },
    mainEntityOfPage: url,
    keywords: a.tags.join('、')
  };
  if (a.thumbnail) jsonld.image = absUrl(a.thumbnail);

  const page = '<!DOCTYPE html>\n<html lang="zh-Hant">\n<head>\n' +
    '<meta charset="UTF-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
    '<title>' + esc(a.title) + '｜' + esc(SITE.name) + '</title>\n' +
    '<meta name="description" content="' + esc(desc) + '">\n' +
    '<link rel="canonical" href="' + esc(url) + '">\n' +
    '<meta property="og:type" content="article">\n' +
    '<meta property="og:site_name" content="' + esc(SITE.name) + '">\n' +
    '<meta property="og:title" content="' + esc(a.title) + '">\n' +
    '<meta property="og:description" content="' + esc(desc) + '">\n' +
    '<meta property="og:url" content="' + esc(url) + '">\n' +
    '<meta property="og:image" content="' + esc(img) + '">\n' +
    '<meta name="twitter:card" content="summary_large_image">\n' +
    '<link rel="icon" type="image/png" href="/images/logo.png">\n' +
    '<link rel="preconnect" href="https://fonts.googleapis.com">\n' +
    '<link href="https://fonts.googleapis.com/css2?family=Noto+Serif+TC:wght@500;700;900&family=Noto+Sans+TC:wght@400;500;700&display=swap" rel="stylesheet">\n' +
    '<link rel="stylesheet" href="/styles.css">\n' +
    '<script type="application/ld+json">' + JSON.stringify(jsonld) + '</script>\n' +
    '</head>\n<body>\n' +
    headerHtml() + '\n' +
    '<div class="page show">\n  <section>\n    <div class="wrap article-page">\n' +
    '      <div class="cats">' + a.tags.map(t => '<span class="cat">' + esc(t) + '</span>').join('') + '</div>\n' +
    '      <h1>' + esc(a.title) + '</h1>\n' +
    '      <div class="meta">' + esc(a.author) + '　·　建立日期：' + esc(a.date) + '</div>\n' +
    '      <div class="article-body">' + a.html + '</div>\n' +
    '      ' + shareHtml(url, a.title) + '\n' +
    '      <a class="back-link" href="/#news">← 回文章列表</a>\n' +
    '    </div>\n  </section>\n</div>\n' +
    footerHtml() + '\n</body>\n</html>\n';

  const dir = path.join(ART_OUT, a.slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), page);

  /* 舊的完整檔名網址 → 轉址到新網址，避免已分享出去的連結失效 */
  if (a.rawName && a.rawName !== a.slug) {
    const oldDir = path.join(ART_OUT, a.rawName);
    fs.mkdirSync(oldDir, { recursive: true });
    fs.writeFileSync(path.join(oldDir, 'index.html'),
      '<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="UTF-8">' +
      '<meta name="robots" content="noindex">' +
      '<link rel="canonical" href="' + esc(url) + '">' +
      '<meta http-equiv="refresh" content="0; url=' + esc(url) + '">' +
      '<title>前往文章…</title></head><body>' +
      '<p>已搬移，正在前往 <a href="' + esc(url) + '">新網址</a>…</p></body></html>\n');
  }
}

/* ---------- sitemap.xml ---------- */
const today = new Date().toISOString().slice(0, 10);
const urls = [{ loc: BASE + '/', pri: '1.0', mod: today }].concat(
  articles.map(a => ({ loc: BASE + '/article/' + encodeURIComponent(a.slug) + '/', pri: '0.8', mod: a.date || today }))
);
fs.writeFileSync(path.join(ROOT, 'sitemap.xml'),
  '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
  urls.map(u => '  <url><loc>' + u.loc + '</loc><lastmod>' + u.mod + '</lastmod><priority>' + u.pri + '</priority></url>').join('\n') +
  '\n</urlset>\n');

console.log('✓ 建置完成：' + articles.length + ' 篇文章（已產生實體頁）、' +
  ann.items.length + ' 則公告（顯示中 ' + ann.items.filter(i => i.show).length + ' 則）、sitemap ' + urls.length + ' 筆');
