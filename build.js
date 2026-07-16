/* ============================================================
   build.js — Cloudflare Pages 部署時自動執行
   把 content/ 裡的公告與文章轉成 data/*.json 給網頁讀取。
   零相依套件，只用 Node 內建模組。診所人員不需要理解此檔。
   ============================================================ */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const ART_DIR = path.join(ROOT, 'content', 'articles');
const DATA_DIR = path.join(ROOT, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

/* ---------- frontmatter 解析 ---------- */
function parseFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: raw };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i === -1) continue;
    const key = line.slice(0, i).trim();
    let val = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    if (val === 'true') val = true;
    else if (val === 'false') val = false;
    meta[key] = val;
  }
  return { meta, body: m[2].trim() };
}

/* ---------- 極簡 Markdown → HTML ---------- */
function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function inline(s) {
  return esc(s)
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img src="$2" alt="$1" loading="lazy">')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}
function mdToHtml(md) {
  const blocks = md.split(/\r?\n\r?\n+/);
  return blocks.map(b => {
    const t = b.trim();
    if (!t) return '';
    if (/^###\s+/.test(t)) return `<h4>${inline(t.replace(/^###\s+/, ''))}</h4>`;
    if (/^##\s+/.test(t)) return `<h3>${inline(t.replace(/^##\s+/, ''))}</h3>`;
    if (/^#\s+/.test(t)) return `<h2>${inline(t.replace(/^#\s+/, ''))}</h2>`;
    if (t.split(/\r?\n/).every(l => /^[-*]\s+/.test(l.trim()))) {
      const items = t.split(/\r?\n/).map(l => `<li>${inline(l.trim().replace(/^[-*]\s+/, ''))}</li>`).join('');
      return `<ul>${items}</ul>`;
    }
    return `<p>${t.split(/\r?\n/).map(inline).join('<br>')}</p>`;
  }).filter(Boolean).join('\n');
}

/* ---------- 文章 ---------- */
const articles = [];
if (fs.existsSync(ART_DIR)) {
  for (const f of fs.readdirSync(ART_DIR)) {
    if (!f.endsWith('.md')) continue;
    const raw = fs.readFileSync(path.join(ART_DIR, f), 'utf8');
    const { meta, body } = parseFrontmatter(raw);
    const dateStr = String(meta.date || '').slice(0, 10);
    articles.push({
      slug: f.replace(/\.md$/, ''),
      title: meta.title || f,
      date: dateStr,
      category: meta.category || '未分類',
      author: meta.author || '晨昕診所',
      excerpt: meta.excerpt || '',
      thumbnail: meta.thumbnail || '',
      html: mdToHtml(body)
    });
  }
}
articles.sort((a, b) => b.date.localeCompare(a.date));
fs.writeFileSync(path.join(DATA_DIR, 'articles.json'), JSON.stringify(articles, null, 2));

/* ---------- 公告 ---------- */
const annSrc = path.join(ROOT, 'content', 'announcements.json');
let ann = { items: [] };
if (fs.existsSync(annSrc)) {
  try { ann = JSON.parse(fs.readFileSync(annSrc, 'utf8')); }
  catch (e) { console.error('announcements.json 格式錯誤：', e.message); process.exit(1); }
}
ann.items = (ann.items || []).sort((a, b) => String(b.date).localeCompare(String(a.date)));
fs.writeFileSync(path.join(DATA_DIR, 'announcements.json'), JSON.stringify(ann, null, 2));

/* ---- content.js：讓網頁不靠 fetch 也能讀到內容（本機雙擊預覽也能動） ---- */
const contentJs = 'window.__ANNOUNCEMENTS__ = ' + JSON.stringify(ann) + ';\n' +
                  'window.__ARTICLES__ = ' + JSON.stringify(articles) + ';\n';
fs.writeFileSync(path.join(DATA_DIR, 'content.js'), contentJs);

console.log(`✓ 建置完成：${articles.length} 篇文章、${ann.items.length} 則公告（顯示中 ${ann.items.filter(i => i.show).length} 則）`);
