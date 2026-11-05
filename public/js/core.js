(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.JevCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

/**
 * Modelo de referência (baseline estatístico), usado para comparar com o jev.
 *
 * Para cada vendedor, o total vendido é tratado como uma variável aleatória:
 *  - com 2+ lançamentos: Normal(soma, desvio_amostral * sqrt(n))
 *  - com 1 lançamento:   Normal(valor, valor * cv)
 * Rodamos uma simulação de Monte Carlo e contamos em quantas rodadas
 * cada vendedor ficou em primeiro. Isso vira a probabilidade.
 */

// PRNG determinístico (mulberry32) para resultados reproduzíveis.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand) {
  // Box-Muller
  let u = 0;
  while (u === 0) u = rand();
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function stats(values) {
  const n = values.length;
  const total = values.reduce((s, x) => s + x, 0);
  if (n < 2) return { n, total, sd: 0 };
  const mean = total / n;
  const variance = values.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1);
  return { n, total, sd: Math.sqrt(variance) };
}

function baselineProbabilities(vendedores, { cv = 0.1, iterations = 20000, seed = 42 } = {}) {
  const rand = mulberry32(seed);
  const params = vendedores.map((v) => {
    const s = stats(v.vendas);
    const sdTotal = s.n >= 2 ? s.sd * Math.sqrt(s.n) : s.total * cv;
    return { nome: v.nome, total: s.total, sdTotal };
  });

  const wins = new Array(params.length).fill(0);
  for (let i = 0; i < iterations; i++) {
    let best = -Infinity;
    let bestIdx = [];
    for (let j = 0; j < params.length; j++) {
      const p = params[j];
      const draw = p.total + (p.sdTotal > 0 ? gaussian(rand) * p.sdTotal : 0);
      if (draw > best) {
        best = draw;
        bestIdx = [j];
      } else if (draw === best) {
        bestIdx.push(j);
      }
    }
    for (const j of bestIdx) wins[j] += 1 / bestIdx.length;
  }

  const probabilidades = {};
  params.forEach((p, j) => {
    probabilidades[p.nome] = wins[j] / iterations;
  });
  const vencedor = params.reduce((a, b, j) => (wins[j] > wins[a] ? j : a), 0);

  return {
    modelo: 'baseline-monte-carlo',
    probabilidades,
    vencedor: params[vencedor].nome,
    totais: Object.fromEntries(params.map((p) => [p.nome, p.total])),
    parametros: { cv, iterations, seed },
  };
}


const MAX_VENDEDORES = 20;
const MAX_LANCAMENTOS = 100;

function validar(payload) {
  const lista = payload && payload.vendedores;
  if (!Array.isArray(lista) || lista.length < 2) return { erro: 'Informe pelo menos 2 vendedores.' };
  if (lista.length > MAX_VENDEDORES) return { erro: `Máximo de ${MAX_VENDEDORES} vendedores.` };
  const nomes = new Set();
  const vendedores = [];
  for (const [i, v] of lista.entries()) {
    const nome = String((v && v.nome) ?? '').trim().slice(0, 60) || `Vendedor ${i + 1}`;
    if (nomes.has(nome.toLowerCase())) return { erro: `Nome repetido: ${nome}` };
    nomes.add(nome.toLowerCase());
    const bruto = v && v.vendas;
    const vendas = (Array.isArray(bruto) ? bruto : [bruto]).map(Number);
    if (vendas.length === 0 || vendas.length > MAX_LANCAMENTOS)
      return { erro: `${nome}: informe de 1 a ${MAX_LANCAMENTOS} valores.` };
    if (vendas.some((x) => !Number.isFinite(x) || x < 0))
      return { erro: `${nome}: os valores de venda devem ser números maiores ou iguais a zero.` };
    vendedores.push({ nome, vendas });
  }
  return { vendedores };
}

// Aceita "12500", "12.500", "1.234,56", "1234.56", "R$ 1.234,56"
function parseValor(txt) {
  let t = String(txt).trim().replace(/[R$\s]/g, '');
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, '');
  return t === '' ? NaN : Number(t);
}

// Preço por 1 milhão de tokens (USD). Claude: tabela pública da Anthropic.
// jev: preencher quando o preço do defapi.org for confirmado (sem preço, o custo aparece como "não informado").
const PRECOS = {
  'claude-opus-5-5': { entrada: 4, saida: 20 },
  'claude-sonnet-5-5': { entrada: 2, saida: 10 },
  'claude-haiku-5-5': { entrada: 0.1, saida: 0.5 },
  'claude-opus-5': { entrada: 5, saida: 25 },
  'claude-opus-4-8': { entrada: 5, saida: 25 },
};

function custoUSD(modelo, uso, precos) {
  const p = (precos && precos[modelo]) || PRECOS[modelo];
  if (!p || !uso) return null;
  return (uso.entrada * p.entrada + uso.saida * p.saida) / 1e6;
}

return { baselineProbabilities, stats, validar, parseValor, custoUSD, PRECOS };
});
