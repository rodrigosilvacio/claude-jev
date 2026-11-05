(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Jev = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

/**
 * Adaptador do modelo jev (defapi.org) e lógica de decisão compartilhada.
 *
 * O jev é um modelo de DECISÃO, não de chat. Formato oficial (defapi.org):
 *   POST https://api.defapi.org/api/v1/decisions
 *   { "model": "typesafe/jev-1.13", "state": "<contexto>",
 *     "questions": { "<chave>": { "type": "noul", "instructions": "...",
 *                                 "criteria": { "true": "...", "false": "..." } } } }
 *
 * Mapeamento: o "state" descreve as vendas de todos e há uma pergunta por vendedor
 * ("probabilidade de X ser quem mais vendeu"). As probabilidades são normalizadas para somar 1.
 *
 *  - buildDecisionRequest / parseDecisionResponse: formato de decisões do jev
 *  - buildPrompt / SYSTEM_PROMPT / parseJevResponse: formato de texto (usado pelo Claude)
 *  - callJev: escolhe o formato pelo endpoint (".../chat/completions" usa chat; o resto usa decisões)
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

const total = (v) => v.vendas.reduce((s, x) => s + x, 0);
const chaveQuestao = (i) => `vendedor_${i + 1}`;

function buildDecisionRequest(vendedores, model) {
  const linhas = vendedores.map((v) =>
    v.vendas.length > 1
      ? `${v.nome}: ${v.vendas.length} sales entries [${v.vendas.join(', ')}], total ${total(v)}`
      : `${v.nome}: total sales ${total(v)}`
  );
  const state = `Sales report for one period. Each seller's total is the sum of their entries.\n${linhas.join('\n')}`;
  const questions = {};
  vendedores.forEach((v, i) => {
    questions[chaveQuestao(i)] = {
      type: 'noul',
      instructions: `Assess the probability that ${v.nome} is the seller with the highest total sales among all sellers listed.`,
      criteria: {
        true: `${v.nome} has the highest total sales`,
        false: `Another seller has higher total sales than ${v.nome}`,
      },
    };
  });
  return { model, state, questions };
}

// A resposta exata do endpoint de decisões ainda não está documentada aqui,
// então procuramos a probabilidade de cada pergunta de forma tolerante.
const CAMPOS_PROB = ['probability', 'prob', 'p', 'p_true', 'true_probability', 'likelihood', 'confidence', 'score', 'value', 'answer', 'result', 'true'];
const CAMPOS_TEXTO = ['reasoning', 'rationale', 'explanation', 'justification', 'summary'];

function numeroDe(x) {
  if (typeof x === 'number' && Number.isFinite(x)) return x;
  if (typeof x === 'string' && x.trim() !== '' && Number.isFinite(Number(x.replace('%', '')))) return Number(x.replace('%', ''));
  if (typeof x === 'boolean') return x ? 1 : 0;
  if (x && typeof x === 'object') {
    for (const c of CAMPOS_PROB) if (c in x) { const n = numeroDe(x[c]); if (n != null) return n; }
  }
  return null;
}

function acharTodos(obj, chave, prof = 0, out = []) {
  if (!obj || typeof obj !== 'object' || prof > 6) return out;
  if (Array.isArray(obj)) {
    for (const it of obj) {
      if (it && typeof it === 'object' && [it.key, it.id, it.name, it.question].includes(chave)) out.push(it);
      acharTodos(it, chave, prof + 1, out);
    }
    return out;
  }
  for (const [k, v] of Object.entries(obj)) {
    if (k === chave) out.push(v);
    acharTodos(v, chave, prof + 1, out);
  }
  return out;
}

function textoDe(x) {
  if (!x || typeof x !== 'object') return '';
  for (const c of CAMPOS_TEXTO) if (typeof x[c] === 'string') return x[c];
  return '';
}

function parseDecisionResponse(json, vendedores) {
  const brutas = vendedores.map((v, i) => {
    let n = null;
    for (const item of acharTodos(json, chaveQuestao(i))) { n = numeroDe(item); if (n != null) break; }
    return n == null ? null : n > 1 ? n / 100 : n;
  });
  if (brutas.every((x) => x == null)) {
    const err = new Error('Não encontrei as probabilidades na resposta do jev. Veja a resposta bruta.');
    err.code = 'RESPOSTA_INVALIDA';
    err.bruto = JSON.stringify(json).slice(0, 4000);
    throw err;
  }
  const vals = brutas.map((x) => (x == null || x < 0 ? 0 : x));
  const soma = vals.reduce((s, x) => s + x, 0);
  const probabilidades = {};
  vendedores.forEach((v, i) => { probabilidades[v.nome] = soma > 0 ? vals[i] / soma : 1 / vendedores.length; });
  const nomes = vendedores.map((v) => v.nome);
  const vencedor = nomes.reduce((a, n) => (probabilidades[n] > probabilidades[a] ? n : a), nomes[0]);
  const iv = nomes.indexOf(vencedor);
  const justificativa = acharTodos(json, chaveQuestao(iv)).map(textoDe).find(Boolean) || textoDe(json);
  return {
    probabilidades, vencedor, vencedorDeclarado: vencedor, coerente: true, somaOriginal: soma,
    justificativa,
    probabilidadesIndependentes: Object.fromEntries(nomes.map((n, i) => [n, brutas[i]])),
  };
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

  const formatoChat = /\/chat\/completions\/?$/.test(cfg.url);
  const body = formatoChat
    ? {
        model: cfg.model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildPrompt(vendedores) },
        ],
        temperature: 0,
      }
    : buildDecisionRequest(vendedores, cfg.model);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs || 30000);
  const inicio = Date.now();
  let res;
  try {
    res = await fetch(cfg.url, {
      method: 'POST',
      headers: Object.assign(
        { 'Content-Type': 'application/json', Accept: 'application/json' },
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

  const parsed = formatoChat
    ? parseJevResponse(json, vendedores.map((v) => v.nome))
    : parseDecisionResponse(json, vendedores);
  return { ...parsed, modelo: json.model || cfg.model, latenciaMs, uso: extractUsage(json), custoInformadoUSD: extractCost(json), bruto: json, requisicao: formatoChat ? undefined : body };
}

// Tokens no formato OpenAI (prompt/completion) ou Anthropic (input/output).
function extractUsage(json) {
  const u = (json && json.usage) || {};
  const entrada = Number(u.prompt_tokens ?? u.input_tokens);
  const saida = Number(u.completion_tokens ?? u.output_tokens);
  if (!Number.isFinite(entrada) && !Number.isFinite(saida)) return null;
  const e = Number.isFinite(entrada) ? entrada : 0;
  const s = Number.isFinite(saida) ? saida : 0;
  return { entrada: e, saida: s, total: e + s };
}

// Custo informado pela própria API, se houver (ex.: usage.cost, cost, price, credits_used).
function extractCost(json) {
  const cands = [json?.usage?.cost, json?.usage?.total_cost, json?.cost, json?.total_cost, json?.price, json?.billing?.cost];
  for (const c of cands) { const n = numeroDe(c); if (n != null) return n; }
  return null;
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

return { callJev, parseJevResponse, parseDecisionResponse, buildDecisionRequest, buildPrompt, extractUsage, extractCost, SYSTEM_PROMPT };
});
