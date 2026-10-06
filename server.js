// FileShare: upload a file, anyone can see it, and it disappears after one download.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const MAX_SIZE = Number(process.env.MAX_SIZE_MB || 100) * 1024 * 1024;
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, 'uploads'));
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_HOURS = Number(process.env.SESSION_HOURS) || 24 * 7;

let PASSWORD = process.env.PASSWORD;
if (!PASSWORD) {
  PASSWORD = crypto.randomBytes(6).toString('base64url');
  console.log(`PASSWORD not set, using generated password: ${PASSWORD}`);
}
// Sessions are signed with a key derived from the password,
// so changing the password signs everyone out.
const SESSION_KEY = crypto.createHash('sha256').update('fileshare:' + PASSWORD).digest();
const COOKIE = 'fs_session';

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// id -> { id, name, size, type, uploadedAt }
const files = new Map();

// Restore metadata from disk so files survive a restart.
for (const f of fs.readdirSync(UPLOAD_DIR)) {
  if (!f.endsWith('.json')) continue;
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(UPLOAD_DIR, f), 'utf8'));
    if (fs.existsSync(dataPath(meta.id))) files.set(meta.id, meta);
  } catch {}
}

function dataPath(id) { return path.join(UPLOAD_DIR, id + '.bin'); }
function metaPath(id) { return path.join(UPLOAD_DIR, id + '.json'); }

function removeFiles(id) {
  fs.rm(dataPath(id), { force: true }, () => {});
  fs.rm(metaPath(id), { force: true }, () => {});
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function sign(value) {
  return crypto.createHmac('sha256', SESSION_KEY).update(value).digest('base64url');
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function isLoggedIn(req) {
  const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(c => {
    const i = c.indexOf('=');
    return [c.slice(0, i).trim(), c.slice(i + 1).trim()];
  }));
  const [expires, sig] = (cookies[COOKIE] || '').split('.');
  if (!expires || !sig || Number(expires) < Date.now()) return false;
  return safeEqual(sig, sign(expires));
}

// Per-IP limit on wrong passwords: ip -> { count, resetAt }
const failures = new Map();
const MAX_FAILURES = 10;
const LOCK_MS = 15 * 60 * 1000;

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > limit) { reject(new Error('too large')); req.destroy(); }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function login(req, res) {
  const ip = req.socket.remoteAddress;
  const f = failures.get(ip);
  if (f && f.resetAt < Date.now()) failures.delete(ip);
  else if (f && f.count >= MAX_FAILURES) return sendJson(res, 429, { error: '嘗試次數過多，請稍後再試' });

  let password = '';
  try { password = String(JSON.parse(await readBody(req, 4096)).password || ''); } catch {}

  if (!safeEqual(password, PASSWORD)) {
    const cur = failures.get(ip) || { count: 0, resetAt: Date.now() + LOCK_MS };
    cur.count++;
    failures.set(ip, cur);
    return sendJson(res, 401, { error: '密碼錯誤' });
  }
  failures.delete(ip);
  const expires = String(Date.now() + SESSION_HOURS * 3600 * 1000);
  res.setHeader('Set-Cookie', `${COOKIE}=${expires}.${sign(expires)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_HOURS * 3600}`);
  sendJson(res, 200, { ok: true });
}

function logout(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
  sendJson(res, 200, { ok: true });
}

function listFiles(res) {
  const list = [...files.values()].sort((a, b) => b.uploadedAt - a.uploadedAt);
  sendJson(res, 200, list);
}

function upload(req, res) {
  let name;
  try { name = decodeURIComponent(req.headers['x-filename'] || ''); } catch { name = ''; }
  name = path.basename(name).replace(/[\u0000-\u001f]/g, '').slice(0, 255);
  if (!name) return sendJson(res, 400, { error: '缺少檔名' });

  const declared = Number(req.headers['content-length']);
  if (declared > MAX_SIZE) return sendJson(res, 413, { error: '檔案太大' });

  const id = crypto.randomBytes(16).toString('hex');
  const out = fs.createWriteStream(dataPath(id));
  let size = 0;
  let failed = false;

  const fail = (status, msg) => {
    if (failed) return;
    failed = true;
    out.destroy();
    removeFiles(id);
    if (!res.headersSent) sendJson(res, status, { error: msg });
    req.resume();
  };

  req.on('data', chunk => {
    size += chunk.length;
    if (size > MAX_SIZE) fail(413, '檔案太大');
  });
  req.on('aborted', () => fail(400, '上傳中斷'));
  out.on('error', () => fail(500, '儲存失敗'));
  out.on('finish', () => {
    if (failed) return;
    const meta = {
      id, name, size,
      type: String(req.headers['content-type'] || 'application/octet-stream').slice(0, 100),
      uploadedAt: Date.now(),
    };
    fs.writeFileSync(metaPath(id), JSON.stringify(meta));
    files.set(id, meta);
    sendJson(res, 201, meta);
  });
  req.pipe(out);
}

function download(res, id) {
  const meta = files.get(id);
  if (!meta) return sendJson(res, 404, { error: '檔案不存在或已被下載' });

  // Claim the file right away so only one person can download it.
  files.delete(id);

  const stream = fs.createReadStream(dataPath(id));
  stream.on('error', () => {
    removeFiles(id);
    if (!res.headersSent) sendJson(res, 410, { error: '檔案已不存在' });
    else res.destroy();
  });
  stream.on('open', () => {
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': meta.size,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(meta.name)}`,
      'Cache-Control': 'no-store',
    });
    stream.pipe(res);
  });
  // Delete once the transfer is over (finished or interrupted).
  res.on('close', () => { stream.destroy(); removeFiles(id); });
}

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.slice(1);
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 404, { error: 'Not found' });
  fs.readFile(file, (err, data) => {
    if (err) return sendJson(res, 404, { error: 'Not found' });
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (req.method === 'POST' && pathname === '/api/login') return login(req, res);
  if (req.method === 'POST' && pathname === '/api/logout') return logout(res);
  if (pathname.startsWith('/api/') && !isLoggedIn(req)) {
    req.resume();
    return sendJson(res, 401, { error: '請先登入' });
  }
  if (req.method === 'GET' && pathname === '/api/files') return listFiles(res);
  if (req.method === 'POST' && pathname === '/api/upload') return upload(req, res);
  const m = pathname.match(/^\/api\/download\/([a-f0-9]{32})$/);
  if (req.method === 'GET' && m) return download(res, m[1]);
  if (req.method === 'GET') return serveStatic(res, pathname);
  sendJson(res, 405, { error: 'Method not allowed' });
});

server.listen(PORT, () => console.log(`FileShare running at http://localhost:${PORT}`));
