import express from 'express';
import axios from 'axios';

const app = express();
const PORT = 3000;

app.get('/proxy', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send('Missing url');

    try {
        const resp = await axios.get(targetUrl, {
            responseType: 'stream',
            timeout: 60000,
            maxContentLength: Infinity,
            validateStatus: () => true,
            headers: {
                'Referer': 'https://embed.bugoumods.com/',
                'Origin': 'https://embed.bugoumods.com',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
            }
        });

        const contentType = resp.headers['content-type'] || '';
        res.setHeader('Access-Control-Allow-Origin', '*');

        // Se for arquivo M3U8, reescreve os links
        if (targetUrl.includes('.m3u8') || contentType.includes('mpegurl')) {
            let text = '';
            for await (const chunk of resp.data) { text += chunk; }
            
            const baseUrl = new URL(targetUrl);
            const out = text.split('\n').map(line => {
                const l = line.trim();
                if (!l || l.startsWith('#')) return line;
                return `/proxy?url=${encodeURIComponent(new URL(l, baseUrl).toString())}`;
            }).join('\n');

            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            return res.send(out);
        }

        // Se for segmento de vídeo, repassa direto
        if (targetUrl.includes('.png') || targetUrl.includes('.ts') || contentType.includes('image/png')) {
            res.setHeader('Content-Type', 'video/mp2t');
        } else if (contentType) {
            res.setHeader('Content-Type', contentType);
        }
        
        resp.data.pipe(res);
    } catch (e) {
        res.status(500).send(e.message);
    }
});

app.listen(PORT, '0.0.0.0', () => console.log(`Proxy rodando na porta ${PORT}`));
