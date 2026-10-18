import express from 'express';
import fetch from 'node-fetch';

const app = express();
const PORT = 3000;

app.get('/proxy', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send('Missing url');

    try {
        const response = await fetch(targetUrl, {
            headers: {
                'Referer': 'https://embed.bugoumods.com/',
                'Origin': 'https://embed.bugoumods.com',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
            }
        });

        const contentType = response.headers.get('content-type') || '';
        
        if (targetUrl.includes('.m3u8') || contentType.includes('mpegurl')) {
            let text = await response.text();
            const baseUrl = new URL(targetUrl);
            text = text.split('\n').map(line => {
                let l = line.trim();
                if (!l) return line;
                if (l.startsWith('#')) return line;
                const abs = new URL(l, baseUrl).toString();
                return `/proxy?url=${encodeURIComponent(abs)}`;
            }).join('\n');

            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            return res.send(text);
        }

        res.setHeader('Access-Control-Allow-Origin', '*');
        if (targetUrl.includes('.png') || targetUrl.includes('.ts')) {
            res.setHeader('Content-Type', 'video/mp2t');
        } else {
            res.setHeader('Content-Type', contentType);
        }
        
        response.body.pipe(res);
    } catch (e) {
        res.status(500).send(e.message);
    }
});

// OUVINDO EM 0.0.0.0 PARA PERMITIR CONEXÕES EXTERNAS
app.listen(PORT, '0.0.0.0', () => console.log(`Proxy rodando na porta ${PORT}`));
