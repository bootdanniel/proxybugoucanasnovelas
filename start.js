import './server.js';
import { setTunnelUrl } from './server.js';
import { spawn } from 'child_process';
import axios from 'axios';

console.log("Iniciando o Cloudflare Tunnel...");
const tunnel = spawn('cloudflared', [
    'tunnel', 
    '--no-autoupdate', 
    '--protocol', 'http2', // <--- Força HTTP2
    '--url', 'http://localhost:3000', 
    '--metrics', '127.0.0.1:20241'
]);

let urlEncontrada = false;

tunnel.stderr.on('data', (data) => {
    const log = String(data);
    console.error(`[tunnel]: ${log.trim()}`);
    
    // Tenta extrair a URL direto do log
    if (!urlEncontrada) {
        const match = log.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (match) {
            setTunnelUrl(match[0]);
            urlEncontrada = true;
        }
    }
});

// Fallback: Tenta pegar do endpoint de métricas
async function esperarTunnel() {
    for (let i = 0; i < 30; i++) {
        if (urlEncontrada) return;
        try {
            const res = await axios.get('http://127.0.0.1:20241/quicktunnel');
            if (res.data && res.data.hostname) {
                setTunnelUrl(`https://${res.data.hostname}`);
                urlEncontrada = true;
                return;
            }
        } catch (e) {}
        await new Promise(r => setTimeout(r, 1000));
    }
}
esperarTunnel();
