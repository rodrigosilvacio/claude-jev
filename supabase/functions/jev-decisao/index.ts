// Edge Function: recebe os vendedores e o provedor escolhido (jev ou claude),
// chama o modelo com a chave guardada nos secrets e devolve decisão, tempo, tokens e custo.
// A lógica de validação, prompt e leitura da resposta vem de core.js e jev.js (cópias de public/js).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk";
import "./core.js";
import "./jev.js";

// deno-lint-ignore no-explicit-any
const { validar, custoUSD } = (globalThis as any).JevCore;
// deno-lint-ignore no-explicit-any
const { callJev, parseJevResponse, buildPrompt, SYSTEM_PROMPT } = (globalThis as any).Jev;

const lista = (v: string | undefined, padrao: string) =>
  (v ?? padrao).split(",").map((s) => s.trim()).filter(Boolean);

// jev
const JEV_API_KEY = Deno.env.get("JEV_API_KEY") ?? "";
const JEV_API_URL = Deno.env.get("JEV_API_URL") ?? "https://api.defapi.org/v1/chat/completions";
const JEV_MODELOS = lista(Deno.env.get("JEV_MODELOS"), "typesafe/jev-1.13");
// Preço do jev em USD por 1M tokens, se conhecido (ex.: "0.5,1.5" = entrada,saída)
const JEV_PRECO = lista(Deno.env.get("JEV_PRECO_POR_MILHAO"), "").map(Number);

// Claude
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const CLAUDE_MODELOS = lista(Deno.env.get("CLAUDE_MODELOS"), "claude-opus-5-5");
const CLAUDE_EFFORT = Deno.env.get("CLAUDE_EFFORT") ?? "low";

const ORIGENS = lista(Deno.env.get("ALLOWED_ORIGINS"), "https://rodrigosilvacio.github.io,http://localhost:3000");
const LIMITE_POR_HORA = Number(Deno.env.get("LIMITE_POR_HORA") ?? "60");

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);
const anthropic = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY, timeout: 60_000 }) : null;

function cors(origin: string | null) {
  const permitido = origin && ORIGENS.includes(origin) ? origin : ORIGENS[0];
  return {
    "Access-Control-Allow-Origin": permitido,
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(body: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...cors(origin) },
  });
}

async function hashOrigem(req: Request) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "desconhecido";
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("jev:" + ip));
  return Array.from(new Uint8Array(buf)).slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Saída estruturada: lista de {nome, probabilidade}, porque os nomes variam a cada pedido.
const SCHEMA_DECISAO = {
  type: "object",
  properties: {
    probabilidades: {
      type: "array",
      items: {
        type: "object",
        properties: { nome: { type: "string" }, probabilidade: { type: "number" } },
        required: ["nome", "probabilidade"],
        additionalProperties: false,
      },
    },
    vencedor: { type: "string" },
    justificativa: { type: "string" },
  },
  required: ["probabilidades", "vencedor", "justificativa"],
  additionalProperties: false,
};

type Vendedor = { nome: string; vendas: number[] };

// ---------- descoberta de modelos do defapi ----------
// O nome exato do modelo no defapi pode ter prefixo (ex.: "fornecedor/jev-1.13").
// Consultamos a lista de modelos da conta (formato OpenAI: GET .../models) e guardamos por 10 min.
const JEV_MODELS_URL = Deno.env.get("JEV_MODELS_URL") ?? JEV_API_URL.replace(/\/chat\/completions\/?$/, "/models");
let cacheModelos: { em: number; ids: string[] } | null = null;
const resolvidos = new Map<string, string>();

async function modelosDefapi(): Promise<string[]> {
  if (cacheModelos && Date.now() - cacheModelos.em < 600_000) return cacheModelos.ids;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(JEV_MODELS_URL, { headers: { Authorization: `Bearer ${JEV_API_KEY}` }, signal: ctrl.signal });
    if (!r.ok) return [];
    const j = await r.json();
    const lista = Array.isArray(j?.data) ? j.data : Array.isArray(j?.models) ? j.models : Array.isArray(j) ? j : [];
    // deno-lint-ignore no-explicit-any
    const ids = lista.map((m: any) => (typeof m === "string" ? m : m?.id ?? m?.name)).filter((x: unknown) => typeof x === "string");
    cacheModelos = { em: Date.now(), ids };
    return ids;
  } catch {
    return [];
  } finally {
    clearTimeout(t);
  }
}

const jevLike = (ids: string[]) => ids.filter((id) => /jev/i.test(id));

function escolherModelo(pedido: string, ids: string[]): string | null {
  const p = pedido.toLowerCase();
  return ids.find((id) => id.toLowerCase() === p)
    ?? ids.find((id) => id.toLowerCase().endsWith("/" + p))
    ?? ids.find((id) => id.toLowerCase().includes(p))
    ?? null;
}

const modeloNaoEncontrado = (e: unknown) =>
  // deno-lint-ignore no-explicit-any
  /model not found|model_not_found|does not exist|invalid model/i.test(String((e as any)?.bruto ?? (e as any)?.message ?? ""));

async function callJevResolvendo(vendedores: Vendedor[], modelo: string) {
  const cfg = (m: string) => ({ apiKey: JEV_API_KEY, url: JEV_API_URL, model: m, timeoutMs: 30000 });
  const atual = resolvidos.get(modelo) ?? modelo;
  try {
    return await callJev(vendedores, cfg(atual));
  } catch (e) {
    if (!modeloNaoEncontrado(e)) throw e;
    const ids = await modelosDefapi();
    const alt = escolherModelo(modelo, ids);
    // Sem lista de modelos: tenta as grafias conhecidas (defapi usa "typesafe/jev-1.13"; a TypeSafe usa "jev-1.13.0").
    if (!alt && !ids.length) {
      const base = modelo.replace(/^typesafe\//, "").replace(/\.0$/, "");
      const candidatos = [`typesafe/${base}`, base, `typesafe/${base}.0`, `${base}.0`].filter((c) => c !== atual);
      for (const c of candidatos) {
        try {
          const r = await callJev(vendedores, cfg(c));
          resolvidos.set(modelo, c);
          return { ...r, modeloSolicitado: modelo, modeloResolvido: c };
        } catch (e2) {
          if (!modeloNaoEncontrado(e2)) throw e2;
        }
      }
    }
    if (alt && alt !== atual) {
      resolvidos.set(modelo, alt);
      const r = await callJev(vendedores, cfg(alt));
      return { ...r, modeloSolicitado: modelo, modeloResolvido: alt };
    }
    const sugestoes = jevLike(ids);
    // deno-lint-ignore no-explicit-any
    const err = e as any;
    err.message = `O defapi não reconhece o modelo "${modelo}". ` + (sugestoes.length
      ? `Modelos jev disponíveis na sua conta: ${sugestoes.join(", ")}. Cadastre o nome certo no secret JEV_MODELOS.`
      : ids.length
        ? `Nenhum modelo com "jev" no nome foi encontrado. Alguns disponíveis: ${ids.slice(0, 15).join(", ")}.`
        : `Também testei typesafe/, sem prefixo e com sufixo .0, sem sucesso. Copie o nome exato e o exemplo de código da página do jev no defapi.org.`);
    err.sugestoes = sugestoes;
    throw err;
  }
}

async function callClaude(vendedores: Vendedor[], modelo: string) {
  if (!anthropic) {
    const err = new Error("A chave da Claude API ainda não foi cadastrada nos secrets do Supabase (ANTHROPIC_API_KEY).");
    // deno-lint-ignore no-explicit-any
    (err as any).code = "NAO_CONFIGURADO";
    throw err;
  }
  const inicio = Date.now();
  // deno-lint-ignore no-explicit-any
  const params: any = {
    model: modelo,
    max_tokens: 4000,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildPrompt(vendedores) }],
    output_config: { effort: CLAUDE_EFFORT, format: { type: "json_schema", schema: SCHEMA_DECISAO } },
    // Se um classificador de segurança recusar, a API refaz o pedido no modelo de reserva recomendado.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
  };
  const resp = await anthropic.beta.messages.create(params);
  const latenciaMs = Date.now() - inicio;

  if (resp.stop_reason === "refusal") {
    const err = new Error("O Claude recusou o pedido" + (resp.stop_details?.category ? ` (${resp.stop_details.category})` : "") + ".");
    // deno-lint-ignore no-explicit-any
    (err as any).code = "RECUSA";
    throw err;
  }
  // deno-lint-ignore no-explicit-any
  const texto = resp.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
  let obj;
  try {
    obj = JSON.parse(texto);
  } catch {
    const err = new Error("Resposta do Claude não é JSON");
    // deno-lint-ignore no-explicit-any
    Object.assign(err, { code: "RESPOSTA_INVALIDA", bruto: texto.slice(0, 4000) });
    throw err;
  }
  // Converte para o mesmo formato do jev e reaproveita a mesma normalização.
  const normalizado = {
    probabilidades: Object.fromEntries(
      (obj.probabilidades ?? []).map((p: { nome: string; probabilidade: number }) => [p.nome, p.probabilidade]),
    ),
    vencedor: obj.vencedor,
    justificativa: obj.justificativa,
  };
  const parsed = parseJevResponse({ output_text: JSON.stringify(normalizado) }, vendedores.map((v) => v.nome));
  // output_tokens já inclui os tokens de raciocínio (thinking).
  const uso = {
    entrada: resp.usage.input_tokens + (resp.usage.cache_read_input_tokens ?? 0) + (resp.usage.cache_creation_input_tokens ?? 0),
    saida: resp.usage.output_tokens,
    total: 0,
  };
  uso.total = uso.entrada + uso.saida;
  return { ...parsed, modelo: resp.model, latenciaMs, uso, bruto: { id: resp.id, model: resp.model, stop_reason: resp.stop_reason, usage: resp.usage, content: obj } };
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(origin) });

  if (req.method === "GET") {
    const url = new URL(req.url);
    if (url.searchParams.get("descobrir") === "jev") {
      if (!JEV_API_KEY) return json({ erro: "JEV_API_KEY não configurada." }, 200, origin);
      const ids = await modelosDefapi();
      return json({ endpoint: JEV_MODELS_URL, total: ids.length, jev: jevLike(ids), amostra: ids.slice(0, 50) }, 200, origin);
    }
    return json({
      provedores: {
        jev: { modelos: JEV_MODELOS, configurado: Boolean(JEV_API_KEY) },
        claude: { modelos: CLAUDE_MODELOS, configurado: Boolean(ANTHROPIC_API_KEY) },
      },
      // compatibilidade com a versão anterior da tela
      modelos: JEV_MODELOS,
      configurado: Boolean(JEV_API_KEY),
    }, 200, origin);
  }
  if (req.method !== "POST") return json({ erro: "Método não permitido" }, 405, origin);
  if (origin && !ORIGENS.includes(origin)) return json({ erro: "Origem não autorizada" }, 403, origin);

  let payload: { provedor?: string; modelo?: string; vendedores?: unknown };
  try {
    payload = await req.json();
  } catch {
    return json({ erro: "JSON inválido." }, 400, origin);
  }

  const provedor = payload.provedor === "claude" ? "claude" : "jev";
  const permitidos = provedor === "claude" ? CLAUDE_MODELOS : JEV_MODELOS;
  const modelo = payload.modelo || permitidos[0];
  if (!permitidos.includes(modelo)) return json({ erro: `Modelo não permitido: ${modelo}` }, 400, origin);

  const { vendedores, erro } = validar({ vendedores: payload.vendedores });
  if (erro) return json({ erro }, 400, origin);

  const chave = provedor === "claude" ? ANTHROPIC_API_KEY : JEV_API_KEY;
  if (!chave) {
    const secret = provedor === "claude" ? "ANTHROPIC_API_KEY" : "JEV_API_KEY";
    return json({ resultado: null, erroModelo: { codigo: "NAO_CONFIGURADO", mensagem: `A chave ainda não foi cadastrada nos secrets do Supabase (${secret}).` } }, 200, origin);
  }

  // Limite simples por origem para proteger os créditos.
  const origemHash = await hashOrigem(req);
  const umaHoraAtras = new Date(Date.now() - 3600_000).toISOString();
  const { count } = await supabase
    .from("jev_decisoes")
    .select("id", { count: "exact", head: true })
    .eq("origem_hash", origemHash)
    .gte("criado_em", umaHoraAtras);
  if ((count ?? 0) >= LIMITE_POR_HORA) {
    return json({ erro: `Limite de ${LIMITE_POR_HORA} decisões por hora atingido. Tente mais tarde.` }, 429, origin);
  }

  // deno-lint-ignore no-explicit-any
  let resultado: any = null;
  // deno-lint-ignore no-explicit-any
  let erroModelo: any = null;
  try {
    resultado = provedor === "claude"
      ? await callClaude(vendedores, modelo)
      : await callJevResolvendo(vendedores, modelo);
    const precoJev = JEV_PRECO.length === 2 && JEV_PRECO.every(Number.isFinite)
      ? { [resultado.modelo]: { entrada: JEV_PRECO[0], saida: JEV_PRECO[1] } }
      : undefined;
    resultado.custoUSD = custoUSD(resultado.modelo, resultado.uso, precoJev);
  } catch (e) {
    // deno-lint-ignore no-explicit-any
    const err = e as any;
    erroModelo = { codigo: err.code ?? err.status ?? "ERRO", mensagem: err.message, bruto: err.bruto, sugestoes: err.sugestoes };
  }

  const { error: logErro } = await supabase.from("jev_decisoes").insert({
    provedor,
    modelo: resultado?.modelo ?? modelo,
    vendedores,
    probabilidades: resultado?.probabilidades ?? null,
    vencedor: resultado?.vencedor ?? null,
    justificativa: resultado?.justificativa ?? null,
    latencia_ms: resultado?.latenciaMs ?? null,
    tokens_entrada: resultado?.uso?.entrada ?? null,
    tokens_saida: resultado?.uso?.saida ?? null,
    custo_usd: resultado?.custoUSD ?? null,
    erro: erroModelo?.mensagem ?? null,
    origem_hash: origemHash,
  });
  if (logErro) console.error("Falha ao registrar decisão:", logErro.message);

  // jev/jevErro mantidos por compatibilidade
  return json({ provedor, resultado, erroModelo, jev: resultado, jevErro: erroModelo }, 200, origin);
});
