(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Jev = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

/**
 * Adaptador do modelo jev (defapi.org).
 *
 * Toda a dependência do formato da API está concentrada aqui:
 *  - buildPrompt: o que pedimos ao jev
 *  - callJev: a chamada HTTP (formato chat completions, compatível com OpenAI)
 *  - parseJevResponse: como lemos a resposta e normalizamos as probabilidades
 *
 * Se a documentação do defapi.org indicar outro formato, ajuste somente este arquivo.
 */

const SYSTEM_PROMPT = [
  'Você é um modelo de decisão comercial.',
  'Recebe as vendas de cada vendedor (um total ou uma lista de lançamentos que devem ser somados).',
  'Estime a probabilidade de cada vendedor ser o que MAIS vendeu, considerando a incerteza dos dados',
  '(poucos lançamentos, variação alta, valores muito próximos).',
  'As probabilidades devem somar 1.',
  'Responda SOMENTE com um JSON válido, sem texto extra, no formato:',
  '{"probabilidades": {"<nome do vendedor>": <número entre 0 e 1>}, "vencedor": "<nome>", "justificativa": "<até 2 frases em português>"}',
].join(' ');

function buildPrompt(vendedores) {
  const linhas = vendedores.map((v) => {
    const total = v.vendas.reduce((s, x) => s + x, 0);
    return v.vendas.length > 1
      ? `- ${v.nome}: lançamentos [${v.vendas.join(', ')}] (total ${total})`
      : `- ${v.nome}: total ${total}`;
  });
  return `Vendas por vendedor:\n${linhas.join('\n')}\n\nQual vendedor vendeu mais? Retorne o JSON.`;
}

async function callJev(vendedores, cfg) {
  if (!cfg.url) {
    const err = new Error('Informe o endpoint do jev em Configurações.');
    err.code = 'NAO_CONFIGURADO';
    throw err;
  }
  if (!cfg.apiKey && /defapi\.org/i.test(cfg.url)) {
    const err = new Error('Informe a chave da API do defapi.org em Configurações.');
    err.code = 'NAO_CONFIGURADO';
    throw err;
  }

  const body = {
    model: cfg.model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildPrompt(vendedores) },
    ],
    temperature: 0,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs || 30000);
  const inicio = Date.now();
  let res;
  try {
    res = await fetch(cfg.url, {
      method: 'POST',
      headers: Object.assign(
        { 'Content-Type': 'application/json' },
        cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}
      ),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    const err = new Error(
      e.name === 'AbortError'
        ? `jev não respondeu em ${cfg.timeoutMs} ms`
        : typeof window !== 'undefined'
          ? 'O navegador não conseguiu chamar o jev. Causa provável: a API não permite chamadas direto do navegador (CORS) ou o endereço está errado. Solução: use um proxy (ex.: webhook n8n ou Cloudflare Worker) como endpoint.'
          : `Falha de rede ao chamar o jev: ${(e.cause && e.cause.code) || e.message}`
    );
    err.code = 'FALHA_REDE';
    throw err;
  } finally {
    clearTimeout(timer);
  }

  const texto = await res.text();
  const latenciaMs = Date.now() - inicio;
  if (!res.ok) {
    const err = new Error(`jev retornou HTTP ${res.status}`);
    err.code = 'HTTP_' + res.status;
    err.bruto = texto.slice(0, 4000);
    throw err;
  }

  let json;
  try {
    json = JSON.parse(texto);
  } catch {
    const err = new Error('Resposta do jev não é JSON');
    err.code = 'RESPOSTA_INVALIDA';
    err.bruto = texto.slice(0, 4000);
    throw err;
  }

  const parsed = parseJevResponse(json, vendedores.map((v) => v.nome));
  return { ...parsed, modelo: cfg.model, latenciaMs, bruto: json };
}

function extractContent(json) {
  // chat completions (OpenAI-compatível)
  const c = json?.choices?.[0]?.message?.content ?? json?.choices?.[0]?.text;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => p?.text ?? '').join('');
  // formatos alternativos comuns
  if (typeof json?.output_text === 'string') return json.output_text;
  if (typeof json?.output === 'string') return json.output;
  if (json?.probabilidades) return JSON.stringify(json);
  return null;
}

function extractJsonObject(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function parseJevResponse(json, nomes) {
  const content = extractContent(json);
  if (content == null) {
    const err = new Error('Não encontrei o conteúdo da resposta do jev');
    err.code = 'RESPOSTA_INVALIDA';
    err.bruto = JSON.stringify(json).slice(0, 4000);
    throw err;
  }
  const obj = extractJsonObject(content);
  if (!obj || typeof obj.probabilidades !== 'object' || obj.probabilidades === null) {
    const err = new Error('O jev não retornou o JSON de probabilidades esperado');
    err.code = 'RESPOSTA_INVALIDA';
    err.bruto = content.slice(0, 4000);
    throw err;
  }

  // Mapeia nomes ignorando maiúsculas/espaços e normaliza (aceita 0..1 ou 0..100).
  const norm = (s) => String(s).trim().toLowerCase();
  const recebidas = new Map(Object.entries(obj.probabilidades).map(([k, v]) => [norm(k), Number(v)]));
  const brutas = nomes.map((n) => {
    const v = recebidas.get(norm(n));
    return Number.isFinite(v) && v >= 0 ? v : 0;
  });
  const soma = brutas.reduce((s, x) => s + x, 0);
  const probabilidades = {};
  nomes.forEach((n, i) => {
    probabilidades[n] = soma > 0 ? brutas[i] / soma : 0;
  });

  const topo = nomes.reduce((a, n) => (probabilidades[n] > probabilidades[a] ? n : a), nomes[0]);
  const vencedorDeclarado = nomes.find((n) => norm(n) === norm(obj.vencedor ?? ''));

  return {
    probabilidades,
    vencedor: topo,
    vencedorDeclarado: vencedorDeclarado ?? obj.vencedor ?? null,
    coerente: !vencedorDeclarado || vencedorDeclarado === topo,
    somaOriginal: soma,
    justificativa: typeof obj.justificativa === 'string' ? obj.justificativa : '',
  };
}

return { callJev, parseJevResponse, buildPrompt, SYSTEM_PROMPT };
});
