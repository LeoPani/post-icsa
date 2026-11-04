// Proxy do Post-Icsa para a Groq.
// A chave fica aqui no servidor, como secret, e nunca chega ao navegador.
// Deploy: Cloudflare Workers (plano gratuito).

const ORIGENS = [
  "https://leopani.github.io"
  // acrescente outros domínios seus aqui
];

const MODELO_TEXTO = "llama-3.3-70b-versatile";
const MODELO_VISAO = "qwen/qwen3.8-27b";   // aceita até 3 imagens por chamada
const LIMITE_POR_IP = 20;          // pedidos por janela
const JANELA_MS = 60 * 60 * 1000;  // uma hora

export default {
  async fetch(req, env, ctx) {
    const origem = req.headers.get("Origin") || "";
    const liberada = ORIGENS.includes(origem);
    const cors = {
      "Access-Control-Allow-Origin": liberada ? origem : ORIGENS[0],
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin"
    };

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (req.method !== "POST") return json({ erro: "use POST" }, 405, cors);
    if (!liberada) return json({ erro: "origem não autorizada" }, 403, cors);

    // limite simples por IP, para a cota não virar de todo mundo
    const ip = req.headers.get("CF-Connecting-IP") || "sem-ip";
    if (env.POSTICSA_KV) {
      const chave = "lim:" + ip;
      const atual = parseInt((await env.POSTICSA_KV.get(chave)) || "0", 10);
      if (atual >= LIMITE_POR_IP) return json({ erro: "limite por hora atingido" }, 429, cors);
      ctx.waitUntil(env.POSTICSA_KV.put(chave, String(atual + 1), { expirationTtl: JANELA_MS / 1000 }));
    }

    let corpo;
    try { corpo = await req.json(); } catch { return json({ erro: "json inválido" }, 400, cors); }
    const sistema = String(corpo.sistema || "").slice(0, 8000);
    const usuario = String(corpo.usuario || "").slice(0, 8000);
    if (!usuario) return json({ erro: "falta o campo usuario" }, 400, cors);

    // imagens opcionais, como data URL; o modelo de visão aceita até 3
    const imagens = Array.isArray(corpo.imagens)
      ? corpo.imagens.filter((u) => typeof u === "string" && u.startsWith("data:image/")).slice(0, 3)
      : [];
    const comVisao = imagens.length > 0;

    const conteudoUsuario = comVisao
      ? [{ type: "text", text: usuario }].concat(
          imagens.map((u) => ({ type: "image_url", image_url: { url: u } })))
      : usuario;

    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + env.GROQ_API_KEY
      },
      body: JSON.stringify({
        model: comVisao ? MODELO_VISAO : MODELO_TEXTO,
        temperature: 0.7,
        max_tokens: 600,
        messages: [
          { role: "system", content: sistema },
          { role: "user", content: conteudoUsuario }
        ]
      })
    });

    if (!r.ok) {
      const detalhe = await r.text().catch(() => "");
      return json({ erro: "groq respondeu " + r.status, detalhe: detalhe.slice(0, 200) }, 502, cors);
    }

    const j = await r.json();
    const texto = j?.choices?.[0]?.message?.content?.trim() || "";
    if (!texto) return json({ erro: "resposta vazia" }, 502, cors);
    return json({ texto }, 200, cors);
  }
};

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...cors }
  });
}
