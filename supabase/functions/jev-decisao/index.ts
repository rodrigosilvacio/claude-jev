// Edge Function: recebe os vendedores e o modelo escolhido, chama o jev (defapi.org)
// com a chave guardada nos secrets e devolve as probabilidades.
// A lógica de prompt e leitura da resposta vem de jev.js (cópia de public/js/jev.js).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import "./core.js";
import "./jev.js";

// deno-lint-ignore no-explicit-any
const { validar } = (globalThis as any).JevCore;
// deno-lint-ignore no-explicit-any
const { callJev } = (globalThis as any).Jev;

const API_KEY = Deno.env.get("JEV_API_KEY") ?? "";
const API_URL = Deno.env.get("JEV_API_URL") ?? "https://api.defapi.org/v1/chat/completions";
const MODELOS = (Deno.env.get("JEV_MODELOS") ?? "jev-1.13").split(",").map((s) => s.trim()).filter(Boolean);
const ORIGENS = (Deno.env.get("ALLOWED_ORIGINS") ?? "https://rodrigosilvacio.github.io,http://localhost:3000")
  .split(",").map((s) => s.trim());
const LIMITE_POR_HORA = Number(Deno.env.get("LIMITE_POR_HORA") ?? "60");

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

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

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(origin) });

  if (req.method === "GET") {
    return json({ modelos: MODELOS, configurado: Boolean(API_KEY) }, 200, origin);
  }
  if (req.method !== "POST") return json({ erro: "Método não permitido" }, 405, origin);
  if (origin && !ORIGENS.includes(origin)) return json({ erro: "Origem não autorizada" }, 403, origin);

  let payload: { modelo?: string; vendedores?: unknown };
  try {
    payload = await req.json();
  } catch {
    return json({ erro: "JSON inválido." }, 400, origin);
  }

  const modelo = payload.modelo || MODELOS[0];
  if (!MODELOS.includes(modelo)) return json({ erro: `Modelo não permitido: ${modelo}` }, 400, origin);

  const { vendedores, erro } = validar({ vendedores: payload.vendedores });
  if (erro) return json({ erro }, 400, origin);

  if (!API_KEY) {
    return json({ jev: null, jevErro: { codigo: "NAO_CONFIGURADO", mensagem: "A chave do jev ainda não foi cadastrada nos secrets do Supabase (JEV_API_KEY)." } }, 200, origin);
  }

  // Limite simples por origem para proteger os créditos do jev.
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

  let jev = null;
  let jevErro = null;
  try {
    jev = await callJev(vendedores, { apiKey: API_KEY, url: API_URL, model: modelo, timeoutMs: 30000 });
  } catch (e) {
    // deno-lint-ignore no-explicit-any
    const err = e as any;
    jevErro = { codigo: err.code ?? "ERRO", mensagem: err.message, bruto: err.bruto };
  }

  const { error: logErro } = await supabase.from("jev_decisoes").insert({
    modelo,
    vendedores,
    probabilidades: jev?.probabilidades ?? null,
    vencedor: jev?.vencedor ?? null,
    justificativa: jev?.justificativa ?? null,
    latencia_ms: jev?.latenciaMs ?? null,
    erro: jevErro?.mensagem ?? null,
    origem_hash: origemHash,
  });
  if (logErro) console.error("Falha ao registrar decisão:", logErro.message);

  return json({ jev, jevErro }, 200, origin);
});
