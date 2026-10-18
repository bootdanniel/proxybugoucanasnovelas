import './server.js';
import { spawn } from 'child_process';

console.log("Iniciando o Cloudflare Tunnel via Node...");
const tunnel = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', 'http://localhost:3000']);

tunnel.stdout.on('data', (data) => {
    console.log(`[tunnel]: ${data}`);
});

tunnel.stderr.on('data', (data) => {
    console.error(`[tunnel]: ${data}`);
});
