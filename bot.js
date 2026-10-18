import axios from 'axios';
import fs from 'fs';
import https from 'https';

const API_BASE = 'https://console-api.akash.network/v1';
const API_KEYS = JSON.parse(process.env.AKASH_API_KEYS || '[]');

// Agente para ignorar certificados SSL inválidos dos provedores da Akash
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function runBot() {
    try {
        console.log(`🤖 Iniciando Bot Akash...`);
        
        // 1. Limpar deploys de todas as contas
        for (const key of API_KEYS) {
            try {
                const headers = { 'x-api-key': key };
                const deps = await axios.get(`${API_BASE}/deployments`, { headers });
                const depsList = deps.data && Array.isArray(deps.data.data) ? deps.data.data : [];
                for (const d of depsList) {
                    if (d.state !== 'closed') await axios.delete(`${API_BASE}/deployments/${d.dseq}`, { headers });
                }
            } catch (e) {}
        }
        await sleep(15000);

        // 2. Escolher conta com maior saldo
        let chosenKey = null;
        let maxBalance = 0;
        for (const key of API_KEYS) {
            try {
                const res = await axios.get(`${API_BASE}/balances`, { headers: { 'x-api-key': key } });
                const balanceUSD = res.data.data.balance / 1000000;
                if (balanceUSD > maxBalance) { maxBalance = balanceUSD; chosenKey = key; }
            } catch (e) {}
        }
        if (!chosenKey || maxBalance < 0.40) { console.error('❌ Saldo insuficiente.'); process.exit(1); }
        const headers = { 'x-api-key': chosenKey, 'Content-Type': 'application/json' };

        // 3. Criar deploy
        const sdl = `
---
version: "2.0"
services:
  proxy:
    image: ghcr.io/bootdanniel/proxybugoucanasnovelas:latest
    expose:
      - port: 3000
        to:
          - global: true
profiles:
  compute:
    proxy:
      resources:
        cpu:
          units: 2.0
        memory:
          size: 4Gi
        storage:
          size: 4Gi
  placement:
    akash:
      pricing:
        proxy:
          denom: uakt
          amount: 80000
deployment:
  proxy:
    akash:
      profile: proxy
      count: 1
`;
        
        let createRes = await axios.post(`${API_BASE}/deployments`, { data: { sdl } }, { headers });
        let dseq = createRes.data.data.dseq;
        console.log(`✅ Deploy criado! DSEQ: ${dseq}`);

        // 4. Aguardar bids
        let bids = [];
        for (let i = 0; i < 12; i++) {
            await sleep(5000);
            try {
                const bidRes = await axios.get(`${API_BASE}/bids?dseq=${dseq}`, { headers });
                bids = bidRes.data.data || [];
                if (bids.length > 0) break;
            } catch (e) {}
        }
        
        if (bids.length === 0) { await axios.delete(`${API_BASE}/deployments/${dseq}`, { headers }); process.exit(1); }

        // 5. Tentar até 3 provedores diferentes
        let validBids = bids.map(item => {
            const b = item.bid ? item.bid : item;
            return { provider: b.id ? b.id.provider : b.provider, price: b.price, manifest: item.manifest || (bids[0] && bids[0].manifest) };
        }).filter(b => b.provider && b.price);
        
        validBids.sort((a, b) => parseInt(a.price.amount) - parseInt(b.price.amount));

        for (const bid of validBids.slice(0, 3)) {
            console.log(`🤝 Tentando provedor: ${bid.provider.substring(0, 15)}...`);
            
            try {
                await axios.post(`${API_BASE}/leases`, {
                    manifest: bid.manifest,
                    leases: [{ dseq: dseq, gseq: 1, oseq: 1, provider: bid.provider }]
                }, { headers });
            } catch (e) { continue; }

            // 6. Esperar container (60s)
            let isReady = false;
            let providerUri = null;
            for (let i = 0; i < 12; i++) {
                await sleep(5000);
                try {
                    const statusRes = await axios.get(`${API_BASE}/deployments/${dseq}`, { headers });
                    const leases = statusRes.data?.data?.leases || [];
                    if (leases.length > 0) {
                        const services = leases[0].status?.services || {};
                        const list = Array.isArray(services) ? services : Object.values(services);
                        for (const svc of list) {
                            if ((Number(svc.ready_replicas) || 0) >= 1 && svc.uris && svc.uris.length > 0) {
                                isReady = true; providerUri = svc.uris[0]; break;
                            }
                        }
                    }
                    if (isReady) break;
                } catch (e) {}
            }

            if (isReady) {
                console.log(`✅ Container rodando no provedor ${bid.provider.substring(0, 15)}! URI: ${providerUri}`);
                
                // 7. Buscar URL do túnel (COM SUPORTE A SSL INVÁLIDO)
                for (let i = 0; i < 6; i++) {
                    try {
                        const resp = await axios.get(`https://${providerUri}/tunnel-url`, { 
                            timeout: 10000,
                            httpsAgent: httpsAgent // <-- CORREÇÃO AQUI
                        });
                        if (resp.data && resp.data.url) {
                            console.log(`🎉 URL Encontrada: ${resp.data.url}`);
                            fs.writeFileSync('proxy_url.txt', resp.data.url, 'utf8');
                            process.exit(0);
                        }
                    } catch (e) {
                        console.log(`   ... tentativa ${i+1}/6 falhou: ${e.message}`);
                    }
                    await sleep(5000);
                }
            } else {
                console.log(`❌ Provedor ${bid.provider.substring(0, 15)} falhou. Tentando próximo...`);
                await axios.delete(`${API_BASE}/deployments/${dseq}`, { headers });
                createRes = await axios.post(`${API_BASE}/deployments`, { data: { sdl } }, { headers });
                dseq = createRes.data.data.dseq;
            }
        }
        
        console.error('❌ Todos os provedores falharam.');
        process.exit(1);

    } catch (error) {
        // Tratamento de erro para não imprimir o objeto gigante do Node.js
        console.error(`❌ Erro crítico: ${error.message}`);
        if (error.response) {
            console.error(`Status da API: ${error.response.status}`);
            console.error(`Detalhes: ${JSON.stringify(error.response.data)}`);
        }
        process.exit(1);
    }
}
runBot();
