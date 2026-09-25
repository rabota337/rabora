const http = require('http');
const fs = require('fs');
const path = require('path');

function loadEnv(filePath) {
    if (!fs.existsSync(filePath)) return;
    for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const separator = trimmed.indexOf('=');
        if (separator < 1) continue;
        const key = trimmed.slice(0, separator).trim();
        let value = trimmed.slice(separator + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (!process.env[key]) process.env[key] = value;
    }
}

function option(name, fallback) {
    const index = process.argv.indexOf(name);
    return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

loadEnv(path.join(__dirname, '.env'));

const siteRoot = path.resolve(__dirname, option('--dir', 'site-workers'));
const defaultSiteName = path.basename(siteRoot) === 'site-opora'
    ? 'Рабочий дом «Опора»'
    : 'Рабочие руки Краснодар';
const siteName = option('--name', process.env.SITE_NAME || defaultSiteName);
const port = Number(option('--port', process.env.PORT || '8765'));
const botToken = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const recentRequests = new Map();

const contentTypes = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon'
};

function json(res, status, payload) {
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
    });
    res.end(JSON.stringify(payload));
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', chunk => {
            size += chunk.length;
            if (size > 16 * 1024) {
                reject(new Error('request_too_large'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

function parseLead(req, rawBody) {
    const contentType = String(req.headers['content-type'] || '');
    if (contentType.includes('application/json')) return JSON.parse(rawBody || '{}');
    return Object.fromEntries(new URLSearchParams(rawBody));
}

function clean(value, maxLength) {
    return String(value || '').replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, maxLength);
}

async function sendLead(req, res) {
    if (!botToken || !chatId) {
        json(res, 503, { ok: false, message: 'Сервис заявок не настроен' });
        return;
    }

    const address = req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    if (now - (recentRequests.get(address) || 0) < 5000) {
        json(res, 429, { ok: false, message: 'Повторите отправку через несколько секунд' });
        return;
    }

    try {
        const lead = parseLead(req, await readBody(req));
        const phone = clean(lead.phone, 40);
        const name = clean(lead.name, 80);
        const digits = phone.replace(/\D/g, '');

        if (!phone || digits.length < 7) {
            json(res, 400, { ok: false, message: 'Укажите корректный номер телефона' });
            return;
        }

        const timestamp = new Intl.DateTimeFormat('ru-RU', {
            dateStyle: 'medium',
            timeStyle: 'medium',
            timeZone: 'Europe/Moscow'
        }).format(new Date());
        const message = [
            '📩 Новая заявка',
            '',
            `Сайт: ${siteName}`,
            `Телефон: ${phone}`,
            `Имя: ${name || 'не указано'}`,
            `Время: ${timestamp}`
        ].join('\n');

        const telegramResponse = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: message })
        });
        const telegramResult = await telegramResponse.json();
        if (!telegramResponse.ok || !telegramResult.ok) {
            throw new Error(telegramResult.description || 'Telegram API error');
        }

        recentRequests.set(address, now);
        json(res, 200, { ok: true });
    } catch (error) {
        console.error('Lead delivery failed:', error.message);
        json(res, 502, { ok: false, message: 'Не удалось доставить заявку' });
    }
}

function serveFile(req, res) {
    let pathname;
    try {
        pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
        res.writeHead(400).end('Bad request');
        return;
    }

    if (pathname.split('/').some(part => part.startsWith('.'))) {
        res.writeHead(404).end('Not found');
        return;
    }

    const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const filePath = path.resolve(siteRoot, relativePath);
    if (filePath !== siteRoot && !filePath.startsWith(siteRoot + path.sep)) {
        res.writeHead(403).end('Forbidden');
        return;
    }

    fs.stat(filePath, (error, stats) => {
        if (error || !stats.isFile()) {
            res.writeHead(404).end('Not found');
            return;
        }
        const extension = path.extname(filePath).toLowerCase();
        res.writeHead(200, {
            'Content-Type': contentTypes[extension] || 'application/octet-stream',
            'Cache-Control': extension === '.html' ? 'no-cache' : 'public, max-age=86400'
        });
        fs.createReadStream(filePath).pipe(res);
    });
}

const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/lead') {
        sendLead(req, res);
        return;
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
        serveFile(req, res);
        return;
    }
    res.writeHead(405, { Allow: 'GET, HEAD, POST' }).end('Method not allowed');
});

server.listen(port, '127.0.0.1', () => {
    console.log(`${siteName}: http://127.0.0.1:${port}`);
});
