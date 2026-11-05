'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { baselineProbabilities } = require('./src/baseline');
const { callJev } = require('./src/jev');

// Carrega .env sem dependências externas
(function loadEnv() {
  const file = path.join(__dirname, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
})();

const cfg = {
  apiKey: process.env.JEV_API_KEY || '',
  url: process.env.JEV_API_URL || 'https://api.defapi.org/v1/chat/completions',
  model: process.env.JEV_MODEL || 'jev-1.13',
  timeoutMs: Number(process.env.JEV_TIMEOUT_MS) || 30000,
  baselineCv: Number(process.env.BASELINE_CV) || 0.1,
};
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const LOG_DIR = path.join(__dirname, 'logs');

const MAX_VENDEDORES = 20;
const MAX_LANCAMENTOS = 100;

function validar(payload) {
  const lista = payload?.vendedores;
  if (!Array.isArray(lista) || lista.length < 2) return { erro: 'Informe pelo menos 2 vendedores.' };
  if (lista.length > MAX_VENDEDORES) return { erro: `Máximo de ${MAX_VENDEDORES} vendedores.` };
  const nomes = new Set();
  const vendedores = [];
  for (const [i, v] of lista.entries()) {
    const nome = String(v?.nome ?? '').trim().slice(0, 60) || `Vendedor ${i + 1}`;
    if (nomes.has(nome.toLowerCase())) return { erro: `Nome repetido: ${nome}` };
    nomes.add(nome.toLowerCase());
    const vendas = (Array.isArray(v?.vendas) ? v.vendas : [v?.vendas]).map(Number);
    if (vendas.length === 0 || vendas.length > MAX_LANCAMENTOS)
      return { erro: `${nome}: informe de 1 a ${MAX_LANCAMENTOS} valores.` };
    if (vendas.some((x) => !Number.isFinite(x) || x < 0))
      return { erro: `${nome}: os valores de venda devem ser números maiores ou iguais a zero.` };
    vendedores.push({ nome, vendas });
  }
  return { vendedores };
}

function registrar(entrada) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, 'decisoes.jsonl'), JSON.stringify(entrada) + '\n');
  } catch (e) {
    console.error('Falha ao gravar log:', e.message);
  }
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req, limit = 100_000) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > limit) {
        reject(new Error('Payload muito grande'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function handleDecidir(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { erro: 'JSON inválido.' });
  }
  const { vendedores, erro } = validar(payload);
  if (erro) return sendJson(res, 400, { erro });

  const id = crypto.randomUUID();
  const baseline = baselineProbabilities(vendedores, { cv: cfg.baselineCv });

  let jev = null;
  let jevErro = null;
  try {
    jev = await callJev(vendedores, cfg);
  } catch (e) {
    jevErro = { codigo: e.code || 'ERRO', mensagem: e.message, bruto: e.bruto };
  }

  const concordam = jev ? jev.vencedor === baseline.vencedor : null;
  registrar({
    id,
    em: new Date().toISOString(),
    vendedores,
    baseline: { vencedor: baseline.vencedor, probabilidades: baseline.probabilidades },
    jev: jev
      ? { modelo: jev.modelo, vencedor: jev.vencedor, probabilidades: jev.probabilidades, latenciaMs: jev.latenciaMs }
      : null,
    jevErro: jevErro && { codigo: jevErro.codigo, mensagem: jevErro.mensagem },
    concordam,
  });

  sendJson(res, 200, { id, vendedores, baseline, jev, jevErro, concordam });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.normalize(path.join(PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath));
  if (!file.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { erro: 'Proibido' });
  fs.readFile(file, (err, buf) => {
    if (err) return sendJson(res, 404, { erro: 'Não encontrado' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/decidir') {
    return handleDecidir(req, res).catch((e) => sendJson(res, 500, { erro: e.message }));
  }
  if (req.method === 'GET' && req.url === '/api/status') {
    return sendJson(res, 200, {
      jevConfigurado: Boolean(cfg.apiKey),
      modelo: cfg.model,
      endpoint: cfg.url,
      baselineCv: cfg.baselineCv,
    });
  }
  if (req.method === 'GET') return serveStatic(req, res);
  sendJson(res, 405, { erro: 'Método não permitido' });
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`Decisão de vendas com jev rodando em http://localhost:${PORT}`);
    console.log(`Modelo: ${cfg.model} | Endpoint: ${cfg.url} | Chave: ${cfg.apiKey ? 'configurada' : 'NÃO configurada'}`);
  });
}

module.exports = { server, validar };
