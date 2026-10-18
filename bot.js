import axios from 'axios';
import fs from 'fs';

const API_BASE = 'https://console-api.akash.network/v1';
const API_KEYS = JSON.parse(process.env.AKASH_API_KEYS || '[]');

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function runBot() {
    console.log(`🤖 Iniciando Bot Akash com ${API_KEYS.length} contas...`);
    
    let chosenKey = null;
    let currentDeployDseq = null;

    // 1. Escolher conta com saldo > $0.60
    for (const key of API_KEYS) {
        try {
            const res = await axios.get(`${API_BASE}/balances`, { headers: { 'x-api-key': key } });
            const balanceUSD = res.data.data.balance / 1000000;
            console.log(`💰 Conta ${key.substring(15, 25)}... tem $${balanceUSD.toFixed(2)}`);

            if (balanceUSD > 0.60) {
                chosenKey = key;
                console.log(`✅ Conta escolhida!`);
                break;
            }
        } catch (e) {
            console.log(`⚠️ Erro na conta: ${e.message}`);
        }
    }

    if (!chosenKey) {
        console.error('❌ Nenhuma conta com saldo > $0.60. Abortando.');
        process.exit(1);
    }

    const headers = { 'x-api-key': chosenKey, 'Content-Type': 'application/json' };

    // 2. Fechar deploys antigos
    console.log('🧹 Limpando deploys antigos...');
    try {
        const deps = await axios.get(`${API_BASE}/deployments`, { headers });
        const depsList = deps.data && Array.isArray(deps.data.data) ? deps.data.data : (Array.isArray(deps.data) ? deps.data : []);
        
        const activeDeps = depsList.filter(d => d && (d.state === 'active' || d.state === 'open'));
        for (const d of activeDeps) {
            console.log(`Deletando deploy ${d.dseq}...`);
            await axios.delete(`${API_BASE}/deployments/${d.dseq}`, { headers });
            await sleep(2000);
        }
    } catch (e) { console.log(`⚠️ Erro ao limpar: ${e.message}`); }

    // 3. Criar novo deploy
    console.log('🚀 Criando novo deploy...');
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
          units: 1.5
        memory:
          size: 3Gi
        storage:
          size: 3Gi
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
    
    try {
        const createRes = await axios.post(`${API_BASE}/deployments`, { data: { sdl, deposit: 0.50 } }, { headers });
        currentDeployDseq = createRes.data.data.dseq;
        console.log(`✅ Deploy criado! DSEQ: ${currentDeployDseq}`);
    } catch (e) {
        console.error(`❌ Erro ao criar: ${e.message}`);
        process.exit(1);
    }

    // 4. Polling de bids (máx 90s)
    let bids = [];
    for (let i = 0; i < 18; i++) {
        await sleep(5000);
        try {
            const bidRes = await axios.get(`${API_BASE}/bids?dseq=${currentDeployDseq}`, { headers });
            bids = bidRes.data.data || [];
            if (bids.length > 0) break;
        } catch (e) {}
    }

    if (bids.length === 0) {
        console.error('❌ Nenhum bid encontrado.');
        await axios.delete(`${API_BASE}/deployments/${currentDeployDseq}`, { headers });
        process.exit(1);
    }

    // 5. Escolher bid (CORRIGIDO)
    let validBids = bids.map(item => {
        const b = item.bid ? item.bid : item;
        return {
            provider: b.id ? b.id.provider : b.provider,
            price: b.price,
            manifest: item.manifest || b.manifest || (bids[0] && bids[0].manifest)
        };
    }).filter(b => b.provider && b.price && b.price.amount);

    if (validBids.length === 0) {
        console.error('❌ Nenhum bid válido com preço encontrado.');
        await axios.delete(`${API_BASE}/deployments/${currentDeployDseq}`, { headers });
        process.exit(1);
    }

    validBids.sort((a, b) => parseInt(a.price.amount) - parseInt(b.price.amount));
    let chosenBid = validBids[0];
    if (validBids.length >= 3) chosenBid = validBids[Math.floor(validBids.length / 2)];
    
    console.log(`🤝 Aceitando bid do provedor: ${chosenBid.provider}`);

    try {
        await axios.post(`${API_BASE}/leases`, {
            manifest: chosenBid.manifest,
            leases: [{ dseq: currentDeployDseq, gseq: 1, oseq: 1, provider: chosenBid.provider }]
        }, { headers });
        console.log('✅ Contrato criado!');
    } catch (e) {
        console.error(`❌ Erro ao aceitar bid: ${e.message}`);
        await axios.delete(`${API_BASE}/deployments/${currentDeployDseq}`, { headers });
        process.exit(1);
    }

    // 6. Esperar container subir
    let isReady = false;
    for (let i = 0; i < 36; i++) {
        await sleep(5000);
        try {
            const statusRes = await axios.get(`${API_BASE}/deployments/${currentDeployDseq}`, { headers });
            const leases = statusRes.data.data.leases;
            if (leases && leases.length > 0 && leases[0].status.services[0].ready_replicas >= 1) {
                isReady = true;
                break;
            }
        } catch (e) {}
    }

    if (!isReady) {
        console.error('❌ Container não subiu.');
        await axios.delete(`${API_BASE}/deployments/${currentDeployDseq}`, { headers });
        process.exit(1);
    }

    // 7. Pegar URL
    let tunnelUrl = null;
    for (let i = 0; i < 12; i++) {
        try {
            const logRes = await axios.get(`${API_BASE}/deployments/${currentDeployDseq}/logs?service=proxy`, { headers });
            for (const log of logRes.data.data) {
                const match = log.message.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
                if (match) { tunnelUrl = match[0]; break; }
            }
            if (tunnelUrl) break;
        } catch (e) {}
        await sleep(5000);
    }

    if (!tunnelUrl) {
        console.error('❌ URL não encontrada nos logs.');
        process.exit(1);
    }

    console.log(`🎉 URL Encontrada: ${tunnelUrl}`);
    fs.writeFileSync('proxy_url.txt', tunnelUrl, 'utf8');
    console.log('✅ proxy_url.txt salvo com sucesso!');
}

runBot();
