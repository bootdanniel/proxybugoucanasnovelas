import axios from 'axios';
import fs from 'fs';
import https from 'https';

const API_BASE = 'https://console-api.akash.network/v1';
const API_KEYS = JSON.parse(process.env.AKASH_API_KEYS || '[]');
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function runBot() {
    try {
        console.log(`🤖 Iniciando Bot Akash...`);
        
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

        // ALTERADO PARA TAG v1
        const sdl = `
---
version: "2.0"
services:
  proxy:
    image: ghcr.io/bootdanniel/proxybugoucanasnovelas:v1
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

        let sucesso = false;

        for (let tentativa = 1; tentativa <= 3; tentativa++) {
            console.log(`\n--- TENTATIVA ${tentativa} DE 3 ---`);
            
            let createRes = await axios.post(`${API_BASE}/deployments`, { data: { sdl } }, { headers });
            let dseq = createRes.data.data.dseq;
            let manifest = createRes.data.data.manifest;
            
            console.log(`✅ Deploy criado! DSEQ: ${dseq}`);
            if (!manifest) { console.log("⚠️ Manifest não veio."); continue; }

            let bids = [];
            for (let i = 0; i < 12; i++) {
                await sleep(5000);
                try {
                    const bidRes = await axios.get(`${API_BASE}/bids?dseq=${dseq}`, { headers });
                    bids = bidRes.data.data || [];
                    if (bids.length > 0) break;
                } catch (e) {}
            }
            
            if (bids.length === 0) { await axios.delete(`${API_BASE}/deployments/${dseq}`, { headers }); continue; }

            let validBids = bids.map(item => {
                const b = item.bid ? item.bid : item;
                return { provider: b.id ? b.id.provider : b.provider, price: b.price };
            }).filter(b => b.provider && b.price);
            
            validBids.sort((a, b) => parseInt(a.price.amount) - parseInt(b.price.amount));
            let chosenBid = validBids[0];

            console.log(`🤝 Tentando provedor: ${chosenBid.provider.substring(0, 15)}...`);
            
            try {
                await axios.post(`${API_BASE}/leases`, {
                    manifest: manifest,
                    leases: [{ dseq: dseq, gseq: 1, oseq: 1, provider: chosenBid.provider }]
                }, { headers });
                console.log('✅ Contrato criado!');
            } catch (e) { 
                console.log('❌ Falha ao criar contrato.');
                await axios.delete(`${API_BASE}/deployments/${dseq}`, { headers });
                continue; 
            }

            // AUMENTADO PARA 5 MINUTOS (300s)
            let isReady = false;
            let providerUri = null;
            for (let i = 0; i < 60; i++) {
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
                    if (i % 12 === 0) console.log(`   ... aguardando container (${i*5}s)`);
                } catch (e) {}
            }

            if (isReady) {
                console.log(`✅ Container rodando! URI: ${providerUri}`);
                let baseUrl = providerUri.startsWith('http') ? providerUri : `https://${providerUri}`;
                
                for (let i = 0; i < 6; i++) {
                    try {
                        const resp = await axios.get(`${baseUrl}/tunnel-url`, { timeout: 10000, httpsAgent });
                        if (resp.data && resp.data.url) {
                            console.log(`🎉 URL Encontrada: ${resp.data.url}`);
                            fs.writeFileSync('proxy_url.txt', resp.data.url, 'utf8');
                            sucesso = true;
                            break;
                        }
                    } catch (e) {}
                    await sleep(5000);
                }
            }

            if (sucesso) break;
            
            console.log('❌ Provedor falhou. Limpando...');
            await axios.delete(`${API_BASE}/deployments/${dseq}`, { headers });
            await sleep(5000);
        }
        
        if (!sucesso) { console.error('❌ Todas as tentativas falharam.'); process.exit(1); }
        process.exit(0);
    } catch (error) {
        console.error(`❌ Erro crítico: ${error.message}`);
        process.exit(1);
    }
}
runBot();
