import axios from 'axios';
import fs from 'fs';
import https from 'https';

const API_BASE = 'https://console-api.akash.network/v1';
const API_KEYS = JSON.parse(process.env.AKASH_API_KEYS || '[]');
const httpsAgent = new https.Agent({ rejectUnauthorized: false });
const FAIL_RE = /ImagePullBackOff|ErrImagePull|CrashLoopBackOff|CreateContainerConfigError|Back-off restarting|Failed to pull|exec format error|invalid image/i;

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function runBot() {
    try {
        console.log('🤖 Iniciando Bot Akash...');

        // Limpar deploys antigos
        for (const key of API_KEYS) {
            try {
                const h = { 'x-api-key': key };
                const deps = await axios.get(`${API_BASE}/deployments`, { headers: h });
                for (const d of (Array.isArray(deps.data?.data) ? deps.data.data : [])) {
                    if (d.state !== 'closed') {
                        await axios.delete(`${API_BASE}/deployments/${d.dseq}`, { headers: h });
                        console.log(`🧹 Deploy ${d.dseq} removido`);
                    }
                }
            } catch (e) {}
        }
        await sleep(8000);

        // Escolher conta com maior saldo
        let chosenKey = null, maxBalance = 0;
        for (const key of API_KEYS) {
            try {
                const res = await axios.get(`${API_BASE}/balances`, { headers: { 'x-api-key': key } });
                const b = Number(res.data?.data?.balance || 0) / 1000000;
                console.log(`💰 Conta ...${key.slice(-8)}: ${b.toFixed(3)} AKT`);
                if (b > maxBalance) { maxBalance = b; chosenKey = key; }
            } catch (e) {}
        }
        if (!chosenKey || maxBalance < 0.40) { 
            console.error('❌ Nenhuma conta com saldo suficiente (mínimo 0.40 AKT).'); 
            process.exit(1); 
        }
        console.log(`✅ Usando conta com ${maxBalance.toFixed(3)} AKT`);
        const headers = { 'x-api-key': chosenKey, 'Content-Type': 'application/json' };

        const sdl = `
---
version: "2.0"
services:
  proxy:
    image: ghcr.io/bootdanniel/proxybugoucanasnovelas:v1
    expose:
      - port: 3000
        as: 80
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

        const provedoresFalhos = new Set();
        let sucesso = false;

        // Tentar até 3 provedores diferentes
        for (let tentativa = 1; tentativa <= 3 && !sucesso; tentativa++) {
            console.log(`\n=== TENTATIVA ${tentativa} DE 3 ===`);
            
            let createRes;
            try { 
                createRes = await axios.post(`${API_BASE}/deployments`, { data: { sdl } }, { headers }); 
            } catch (e) { 
                console.log('❌ Erro ao criar deploy:', e.response?.data?.message || e.message); 
                continue; 
            }
            
            const dseq = createRes.data?.data?.dseq;
            const manifest = createRes.data?.data?.manifest;
            console.log(`✅ Deploy criado! DSEQ: ${dseq}`);
            
            if (!dseq || !manifest) { 
                console.log('⚠️ dseq ou manifest ausentes.'); 
                continue; 
            }

            // Aguardar bids
            let bids = [];
            for (let i = 0; i < 20; i++) {
                await sleep(3000);
                try { 
                    const r = await axios.get(`${API_BASE}/bids?dseq=${dseq}`, { headers }); 
                    bids = r.data?.data || []; 
                    if (bids.length) {
                        console.log(`✅ ${bids.length} bid(s) em ${(i+1)*3}s`);
                        break;
                    }
                } catch (e) {}
            }
            
            if (!bids.length) { 
                console.log('❌ Nenhum bid recebido.'); 
                await axios.delete(`${API_BASE}/deployments/${dseq}`, { headers }).catch(() => {});
                continue; 
            }

            // Processar bids e escolher provedor (evitar os que já falharam)
            const validBids = bids.map(it => { 
                const b = it.bid || it; 
                return { provider: b.id?.provider || b.provider, price: b.price }; 
            }).filter(b => b.provider && b.price?.amount);
            
            validBids.sort((a, b) => parseInt(a.price.amount) - parseInt(b.price.amount));
            
            const chosenBid = validBids.filter(b => !provedoresFalhos.has(b.provider))[0] || validBids[0];
            console.log(`🤝 Provedor escolhido: ${chosenBid.provider.substring(0, 20)}...`);

            // Criar lease
            try {
                await axios.post(`${API_BASE}/leases`, { 
                    manifest, 
                    leases: [{ dseq, gseq: 1, oseq: 1, provider: chosenBid.provider }] 
                }, { headers });
                console.log('✅ Contrato/lease criado!');
            } catch (e) {
                console.log('❌ Falha ao criar lease:', e.response?.data?.message || e.message);
                provedoresFalhos.add(chosenBid.provider);
                await axios.delete(`${API_BASE}/deployments/${dseq}`, { headers }).catch(() => {});
                continue;
            }

            // Monitorar container
            let isReady = false, providerUri = null, falha = null;
            for (let i = 0; i < 36; i++) {
                await sleep(5000);
                try {
                    const r = await axios.get(`${API_BASE}/deployments/${dseq}`, { headers });
                    const lease = (r.data?.data?.leases || [])[0];
                    const raw = JSON.stringify(lease?.status || {});
                    
                    // Fail-fast: detectar erros de imagem/crash
                    if (FAIL_RE.test(raw)) { 
                        falha = raw.slice(0, 400); 
                        break; 
                    }
                    
                    const svcs = lease?.status?.services || {};
                    for (const svc of (Array.isArray(svcs) ? svcs : Object.values(svcs))) {
                        const ready = (Number(svc.ready_replicas) || Number(svc.available) || 0) >= 1;
                        const uris = svc.uris || svc.uri || [];
                        if (ready && uris.length) { 
                            isReady = true; 
                            providerUri = uris[0]; 
                            break; 
                        }
                    }
                    
                    if (isReady) break;
                    
                    if (i % 12 === 0) {
                        const svcs = lease?.status?.services || {};
                        const info = (Array.isArray(svcs) ? svcs : Object.values(svcs)).map(s => ({
                            av: s.available,
                            rdy: s.ready_replicas,
                            uri: (s.uris || s.uri || [])[0] || 'nenhum'
                        }));
                        console.log(`   [${i*5}s] status: ${JSON.stringify(info).slice(0, 100)}`);
                    }
                } catch (e) {}
            }

            if (falha) {
                console.log(`❌ Container não sobe neste provedor: ${falha.slice(0, 200)}`);
                provedoresFalhos.add(chosenBid.provider);
                await axios.delete(`${API_BASE}/deployments/${dseq}`, { headers }).catch(() => {});
                await sleep(3000);
                continue;
            }

            if (isReady) {
                console.log(`✅ Container rodando! URI: ${providerUri}`);
                const baseUrl = providerUri.startsWith('http') ? providerUri : `https://${providerUri}`;
                
                for (let i = 0; i < 10; i++) {
                    try {
                        const resp = await axios.get(`${baseUrl}/tunnel-url`, { timeout: 10000, httpsAgent });
                        if (resp.data?.url) {
                            console.log(`🎉 URL Encontrada: ${resp.data.url}`);
                            fs.writeFileSync('proxy_url.txt', resp.data.url, 'utf8');
                            sucesso = true;
                            break;
                        }
                    } catch (e) {}
                    await sleep(3000);
                }
                
                if (sucesso) break;
            }

            console.log('❌ Provedor falhou. Tentando outro...');
            provedoresFalhos.add(chosenBid.provider);
            await axios.delete(`${API_BASE}/deployments/${dseq}`, { headers }).catch(() => {});
            await sleep(3000);
        }

        if (!sucesso) { 
            console.error('\n❌ Todas as tentativas falharam.'); 
            process.exit(1); 
        }
        
        console.log('\n✅ Bot concluído com sucesso!');
        process.exit(0);
        
    } catch (error) {
        console.error(`❌ Erro crítico: ${error.message}`);
        process.exit(1);
    }
}

runBot();
