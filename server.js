// Serveur : roue + countdown + admin. Stockage Postgres (DATABASE_URL) ou data.json en repli local.
try { process.loadEnvFile(); } catch { /* pas de .env : on utilise les variables du système (Render) */ }
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const PUBLIC = path.join(__dirname, 'public');
const CATEGORIES = ['idea', 'lab', 'scale'];
let countdownSeconds = 300;

/* ---------- Couche de stockage ---------- */
let store;
if (process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    const url = process.env.DATABASE_URL;
    // SSL : URL externe Render (*.render.com) ou PGSSL=true ; l'URL interne n'en a pas besoin
    const useSsl = process.env.PGSSL ? process.env.PGSSL === 'true' : /render\.com/.test(url);
    const ssl = useSsl ? { rejectUnauthorized: false } : false;
    const pool = new Pool({ connectionString: url, ssl });
    const map = (r) => ({ id: r.id, number: r.number, name: r.name, project: r.project, category: r.category, done: r.done });
    store = {
        kind: 'Postgres',
        async init() {
            await pool.query(`CREATE TABLE IF NOT EXISTS teams (
                id SERIAL PRIMARY KEY,
                number INTEGER NOT NULL,
                name TEXT NOT NULL,
                project TEXT NOT NULL DEFAULT '',
                category TEXT NOT NULL,
                done BOOLEAN NOT NULL DEFAULT FALSE)`);
            // Permettre le même numéro dans des catégories différentes
            await pool.query(`ALTER TABLE teams DROP CONSTRAINT IF EXISTS teams_number_key`);
            await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS teams_num_cat_idx ON teams (number, category)`);
        },
        async list() { return (await pool.query('SELECT * FROM teams ORDER BY category, number')).rows.map(map); },
        async add(t) {
            try { await pool.query('INSERT INTO teams (number,name,project,category) VALUES ($1,$2,$3,$4)', [t.number, t.name, t.project, t.category]); }
            catch (e) { if (e.code === '23505') return false; throw e; }
            return true;
        },
        async remove(id) { await pool.query('DELETE FROM teams WHERE id=$1', [id]); },
        async setDone(id, v) { await pool.query('UPDATE teams SET done=$2 WHERE id=$1', [id, v]); },
        async toggle(id) { await pool.query('UPDATE teams SET done = NOT done WHERE id=$1', [id]); },
        async reset() { await pool.query('UPDATE teams SET done=FALSE'); }
    };
} else {
    const FILE = path.join(process.env.DATA_DIR || __dirname, 'data.json');
    const load = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return { teams: [] }; } };
    const save = (d) => fs.writeFileSync(FILE, JSON.stringify(d, null, 2));
    store = {
        kind: 'data.json',
        async init() {},
        async list() { return load().teams.sort((a, b) => a.number - b.number); },
        async add(t) {
            const d = load();
            if (d.teams.some((x) => x.number === t.number && x.category === t.category)) return false;
            d.teams.push({ id: d.teams.reduce((a, x) => Math.max(a, x.id), 0) + 1, ...t, done: false });
            save(d); return true;
        },
        async remove(id) { const d = load(); d.teams = d.teams.filter((t) => t.id !== id); save(d); },
        async setDone(id, v) { const d = load(); const t = d.teams.find((x) => x.id === id); if (t) { t.done = v; save(d); } },
        async toggle(id) { const d = load(); const t = d.teams.find((x) => x.id === id); if (t) { t.done = !t.done; save(d); } },
        async reset() { const d = load(); d.teams.forEach((t) => (t.done = false)); save(d); }
    };
}

/* ---------- HTTP ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
function send(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); }
function readBody(req) {
    return new Promise((resolve) => {
        let s = '';
        req.on('data', (c) => { s += c; if (s.length > 1e6) req.destroy(); });
        req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch { resolve({}); } });
    });
}
const isAdmin = (req) => req.headers['x-admin-password'] === ADMIN_PASSWORD;

async function api(req, res, p) {
    if (req.method === 'GET' && p === '/api/config') return send(res, 200, { countdownSeconds });
    if (req.method === 'GET' && p === '/api/teams') return send(res, 200, await store.list());

    let m = p.match(/^\/api\/teams\/(\d+)\/done$/);
    if (req.method === 'POST' && m) { await store.setDone(+m[1], true); return send(res, 200, { ok: true }); }

    if (!isAdmin(req)) return send(res, 401, { error: 'Mot de passe incorrect' });
    if (req.method === 'POST' && p === '/api/admin/check') return send(res, 200, { ok: true });

    if (req.method === 'POST' && p === '/api/admin/config') {
        const b = await readBody(req);
        const s = parseInt(b.countdownSeconds, 10);
        if (!s || s < 1) return send(res, 400, { error: 'Durée invalide' });
        countdownSeconds = s;
        return send(res, 200, { ok: true, countdownSeconds });
    }

    if (req.method === 'POST' && p === '/api/admin/teams') {
        const b = await readBody(req);
        const number = parseInt(b.number, 10);
        const name = String(b.name || '').trim();
        const project = String(b.project || '').trim();
        if (!number || !name || !CATEGORIES.includes(b.category)) return send(res, 400, { error: 'Champs invalides' });
        if (!(await store.add({ number, name, project, category: b.category }))) return send(res, 400, { error: 'Ce numéro existe déjà' });
        return send(res, 200, { ok: true });
    }
    m = p.match(/^\/api\/admin\/teams\/(\d+)$/);
    if (req.method === 'DELETE' && m) { await store.remove(+m[1]); return send(res, 200, { ok: true }); }
    m = p.match(/^\/api\/admin\/teams\/(\d+)\/toggle$/);
    if (req.method === 'POST' && m) { await store.toggle(+m[1]); return send(res, 200, { ok: true }); }
    if (req.method === 'POST' && p === '/api/admin/reset') { await store.reset(); return send(res, 200, { ok: true }); }
    return send(res, 404, { error: 'Not found' });
}

const server = http.createServer(async (req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    if (p.startsWith('/api/')) {
        try { return await api(req, res, p); }
        catch (e) { console.error(e); return send(res, 500, { error: 'Erreur serveur' }); }
    }
    const file = p === '/' ? '/index.html' : p === '/admin' ? '/admin.html' : p;
    const full = path.normalize(path.join(PUBLIC, file));
    if (!full.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
    fs.readFile(full, (err, buf) => {
        if (err) { res.writeHead(404); return res.end('Not found'); }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
        res.end(buf);
    });
});

// Équipes par défaut : 1 à 5 Idea, 1 à 5 Scale, 1 à 5 LAB
async function seed() {
    if ((await store.list()).length) return;
    for (const cat of ['idea', 'scale', 'lab']) {
        for (let n = 1; n <= 5; n++) {
            await store.add({ number: n, name: `Équipe ${n}`, project: '', category: cat });
        }
    }
}

store.init()
    .then(seed)
    .then(() => server.listen(PORT, () => console.log(`Serveur sur http://localhost:${PORT} · stockage : ${store.kind}`)))
    .catch((e) => { console.error('Init stockage impossible :', e); process.exit(1); });
