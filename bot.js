import axios from 'axios';
import fs from 'fs';

const API_BASE = 'https://console-api.akash.network/v1';
const API_KEYS = JSON.parse(process.env.AKASH_API_KEYS || '[]');

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function runBot() {
    console.log(`🤖 Iniciando Bot Akash...`);
    
    let chosenKey = null;
    let currentDeployDseq = null;

    // 1. Escolher conta com saldo > $0.60
    for (const key of API_KEYS) {
        try {
            const res = await axios.get(`${API_BASE}/balances`, { headers: { 'x-api-key': key } });
            const balanceUSD = res.data.data.balance / 1000000;
            if (balanceUSD > 0.60) { chosenKey = key; console.log(`✅ Conta com saldo escolhida!`); break; }
        } catch (e) {}
    }

    if (!chosenKey) { console.error('❌ Nenhuma conta com saldo.'); process.exit(1); }
    const headers = { 'x-api-key': chosenKey, 'Content-Type': 'application/json' };

    // 2. Limpar deploys antigos
    console.log('🧹 Limpando deploys antigos...');
    try {
        const deps = await axios.get(`${API_BASE}/deployments`, { headers });
        const depsList = deps.data && Array.isArray(deps.data.data) ? deps.data.data : [];
        for (const d of depsList) {
            if (d.state === 'active' || d.state === 'open') {
                await axios.delete(`${API_BASE}/deployments/${d.dseq}`, { headers });
                await sleep(2000);
            }
        }
    } catch (e) {}

    // 3. Criar deploy
    console.log('🚀 Criando deploy...');
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
          amount: 100000
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
    } catch (e) { console.error(`❌ Erro: ${e.message}`); process.exit(1); }

    // 4. Aguardar bids (checa a cada 5s, máx 60s)
    let bids = [];
    for (let i = 0; i < 12; i++) {
        await sleep(5000);
        try {
            const bidRes = await axios.get(`${API_BASE}/bids?dseq=${currentDeployDseq}`, { headers });
            bids = bidRes.data.data || [];
            if (bids.length > 0) break;
        } catch (e) {}
    }

    if (bids.length === 0) {
        console.error('❌ Nenhum bid.');
        await axios.delete(`${API_BASE}/deployments/${currentDeployDseq}`, { headers });
        process.exit(1);
    }

    // 5. Tentar cada bid (do mais barato para cima)
    let validBids = bids.map(item => {
        const b = item.bid ? item.bid : item;
        return { provider: b.id ? b.id.provider : b.provider, price: b.price, manifest: item.manifest || (bids[0] && bids[0].manifest) };
    }).filter(b => b.provider && b.price);

    validBids.sort((a, b) => parseInt(a.price.amount) - parseInt(b.price.amount));

    let isReady = false;
    let tunnelUrl = null;

    for (const bid of validBids) {
        console.log(`🤝 Tentando provedor: ${bid.provider.substring(0, 15)}...`);
        
        try {
            await axios.post(`${API_BASE}/leases`, {
                manifest: bid.manifest,
                leases: [{ dseq: currentDeployDseq, gseq: 1, oseq: 1, provider: bid.provider }]
            }, { headers });
        } catch (e) {
            continue; // Se falhar o contrato, tenta o próximo
        }

        // 6. Esperar container (máx 60s)
        console.log('⏳ Aguardando container... (máx 60s)');
        for (let i = 0; i < 12; i++) {
            await sleep(5000);
            try {
                const statusRes = await axios.get(`${API_BASE}/deployments/${currentDeployDseq}`, { headers });
                const leases = statusRes.data?.data?.leases || statusRes.data?.leases || [];
                const services = leases[0]?.status?.services || {};
                const list = Array.isArray(services) ? services : Object.values(services);
                
                if (list.some(s => (Number(s.ready_replicas) || 0) >= 1)) { 
                    isReady = true; 
                    break; 
                }
            } catch (e) {}
        }

        if (isReady) {
            console.log('✅ Container subiu neste provedor!');
            break;
        } else {
            console.log('❌ Provedor falhou em subir. Tentando próximo...');
            // Tenta fechar o lease para não gastar
            await axios.delete(`${API_BASE}/deployments/${currentDeployDseq}`, { headers });
            // Cria de novo para o próximo bid (porque a Akash cancela o deploy se der timeout)
            const newD = await axios.post(`${API_BASE}/deployments`, { data: { sdl, deposit: 0.50 } }, { headers });
            currentDeployDseq = newD.data.data.dseq;
            // Atualiza o bid com o novo DSEQ
            bid.manifest = bid.manifest || ''; 
        }
    }

    if (!isReady) {
        console.error('❌ Todos os provedores falharam.');
        process.exit(1);
    }

    // 7. Pegar URL
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

    if (!tunnelUrl) { console.error('❌ URL não encontrada.'); process.exit(1); }
    console.log(`🎉 URL Encontrada: ${tunnelUrl}`);
    fs.writeFileSync('proxy_url.txt', tunnelUrl, 'utf8');
}

runBot();
