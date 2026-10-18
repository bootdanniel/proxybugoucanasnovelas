import './server.js';
import { setTunnelUrl } from './server.js';
import { spawn } from 'child_process';
import axios from 'axios';

console.log("Iniciando o Cloudflare Tunnel via Node...");
const tunnel = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', 'http://localhost:3000', '--metrics', '127.0.0.1:20241']);

tunnel.stdout.on('data', (data) => console.log(`[tunnel]: ${data}`));
tunnel.stderr.on('data', (data) => console.error(`[tunnel]: ${data}`));

async function esperarTunnel() {
    for (let i = 0; i < 30; i++) {
        try {
            const res = await axios.get('http://127.0.0.1:20241/quicktunnel');
            if (res.data && res.data.url) {
                setTunnelUrl(res.data.url);
                return;
            }
        } catch (e) {
            // Ignora erro, a porta de métrica ainda não subiu
        }
        await new Promise(r => setTimeout(r, 1000));
    }
    console.error("Aviso: Não foi possível obter a URL do quick tunnel.");
}

esperarTunnel();
