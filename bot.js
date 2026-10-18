import axios from 'axios';
import fs from 'fs';

const API_BASE = 'https://console-api.akash.network/v1';
const API_KEYS = JSON.parse(process.env.AKASH_API_KEYS || '[]');

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function runBot() {
    console.log(`🤖 Iniciando Bot Akash...`);
    
    let chosenKey = null;
    let currentDeployDseq = null;

    // 1. Escolher conta
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

    // 4. Bids
    let bids = [];
    for (let i = 0; i < 12; i++) {
        await sleep(5000);
        try {
            const bidRes = await axios.get(`${API_BASE}/bids?dseq=${currentDeployDseq}`, { headers });
            bids = bidRes.data.data || [];
            if (bids.length > 0) break;
        } catch (e) {}
    }

    if (bids.length === 0) { await axios.delete(`${API_BASE}/deployments/${currentDeployDseq}`, { headers }); process.exit(1); }

    // 5. Tentar bid (pega o primeiro)
    let validBids = bids.map(item => {
        const b = item.bid ? item.bid : item;
        return { provider: b.id ? b.id.provider : b.provider, price: b.price, manifest: item.manifest || (bids[0] && bids[0].manifest) };
    }).filter(b => b.provider && b.price);
    validBids.sort((a, b) => parseInt(a.price.amount) - parseInt(b.price.amount));
    
    let isReady = false;
    let tunnelUrl = null;
    let chosenBid = validBids[0];

    console.log(`🤝 Tentando provedor: ${chosenBid.provider.substring(0, 15)}...`);
    try {
        await axios.post(`${API_BASE}/leases`, {
            manifest: chosenBid.manifest,
            leases: [{ dseq: currentDeployDseq, gseq: 1, oseq: 1, provider: chosenBid.provider }]
        }, { headers });
    } catch (e) { console.error("Erro no lease"); process.exit(1); }

    // 6. Esperar container e pegar a URI do provedor
    console.log('⏳ Aguardando container... (máx 60s)');
    let providerUri = null;
    for (let i = 0; i < 12; i++) {
        await sleep(5000);
        try {
            const statusRes = await axios.get(`${API_BASE}/deployments/${currentDeployDseq}`, { headers });
            const leases = statusRes.data?.data?.leases || statusRes.data?.leases || [];
            if (leases && leases.length > 0) {
                const services = leases[0].status?.services || {};
                const list = Array.isArray(services) ? services : Object.values(services);
                for (const svc of list) {
                    if ((Number(svc.ready_replicas) || 0) >= 1 && svc.uris && svc.uris.length > 0) {
                        isReady = true;
                        providerUri = svc.uris[0];
                        break;
                    }
                }
            }
            if (isReady) break;
        } catch (e) {}
    }

    if (!isReady) { console.error('❌ Container não subiu ou URI não gerada.'); process.exit(1); }
    console.log(`✅ Container rodando! URI do provedor: ${providerUri}`);

    // 7. Consultar o endpoint /tunnel-url do proxy na Akash
    console.log('🔍 Buscando URL do túnel via HTTP no proxy...');
    for (let i = 0; i < 12; i++) {
        try {
            const resp = await axios.get(`https://${providerUri}/tunnel-url`, { timeout: 10000 });
            if (resp.data && resp.data.url) {
                tunnelUrl = resp.data.url;
                break;
            }
        } catch (e) {
            console.log(`   ... tentativa ${i+1}: Ainda não disponível (${e.message})`);
        }
        await sleep(5000);
    }

    if (!tunnelUrl) { console.error('❌ URL não encontrada via /tunnel-url.'); process.exit(1); }
    
    console.log(`🎉 URL Encontrada: ${tunnelUrl}`);
    fs.writeFileSync('proxy_url.txt', tunnelUrl, 'utf8');
    console.log('✅ proxy_url.txt salvo com sucesso!');
}
runBot();
