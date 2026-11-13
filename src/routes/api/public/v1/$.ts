// API pública /api/public/v1/* — autenticação via Bearer token (tabela api_token)
import { createFileRoute } from "@tanstack/react-router";

async function authToken(request: Request): Promise<{ companyId: string; userId: string | null } | null> {
  const h = request.headers.get("authorization") || "";
  // O banco gera o token sem prefixo (64 caracteres hex). Antes a API exigia "azp_" e comparava
  // com o prefixo, então nenhum token era aceito. Agora vale "Bearer <token>" ou "Bearer azp_<token>".
  const m = h.match(/^Bearer\s+(?:azp_)?([a-z0-9]{16,})$/i);
  if (!m) return null;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await (supabaseAdmin as any)
    .from("api_token").select("id, company_id, criado_por, revogado").in("token", [m[1], `azp_${m[1]}`]).limit(1).maybeSingle();
  if (!data || data.revogado) return null;
  await (supabaseAdmin as any).from("api_token").update({ ultimo_uso_em: new Date().toISOString() }).eq("id", data.id);
  return { companyId: data.company_id as string, userId: data.criado_por as string | null };
}

async function handle(request: Request) {
  const auth = await authToken(request);
  if (!auth) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
  const { companyId, userId } = auth;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const url = new URL(request.url);
  const resource = url.searchParams.get("resource") || "contacts";

  if (request.method === "GET") {
    if (resource === "instance") {
      // Status do WhatsApp desta empresa (para a máquina de vendas saber se o chip está no ar)
      const { data: inst } = await (supabaseAdmin as any).from("whatsapp_instances")
        .select("numero, status").eq("company_id", companyId).maybeSingle();
      return Response.json({ numero: inst?.numero ?? null, status: inst?.status ?? "disconnected" });
    }
    if (resource === "contacts") {
      const { data } = await (supabaseAdmin as any).from("crm_cards")
        .select("id, numero, contato_nome, tags, stage_id, valor, utm_source, utm_medium, utm_campaign, created_at")
        .eq("company_id", companyId).order("created_at", { ascending: false }).limit(200);
      return Response.json({ data: data ?? [] });
    }
    if (resource === "messages") {
      const numero = url.searchParams.get("numero") || "";
      let q = (supabaseAdmin as any).from("mensagens")
        .select("id, numero, direcao, autor, texto, created_at")
        .eq("company_id", companyId).order("created_at", { ascending: false }).limit(100);
      if (numero) q = q.eq("numero", numero);
      const { data } = await q;
      return Response.json({ data: data ?? [] });
    }
    return new Response(JSON.stringify({ error: "Unknown resource" }), { status: 400 });
  }

  if (request.method === "POST") {
    const body = await request.json().catch(() => ({})) as any;
    if (resource === "checknumbers") {
      // Confere quais números têm WhatsApp (sem enviar mensagem)
      const { conferirNumeros, ProspectError } = await import("@/lib/prospect.server");
      try {
        return Response.json(await conferirNumeros(companyId, body));
      } catch (e: any) {
        const status = e instanceof ProspectError ? e.status : 500;
        return new Response(JSON.stringify({ error: String(e?.message ?? e) }), { status, headers: { "Content-Type": "application/json" } });
      }
    }
    if (resource === "reforco") {
      // Reforço da isca (só texto, 1 por contato, só para quem nunca respondeu)
      if (!userId) return new Response(JSON.stringify({ error: "Token sem owner; recrie o token." }), { status: 400 });
      const { enviarReforco, ProspectError } = await import("@/lib/prospect.server");
      try {
        return Response.json(await enviarReforco(companyId, userId, body));
      } catch (e: any) {
        const status = e instanceof ProspectError ? e.status : 500;
        const code = e instanceof ProspectError ? e.code : "erro_envio";
        return new Response(JSON.stringify({ error: String(e?.message ?? e), code }), { status, headers: { "Content-Type": "application/json" } });
      }
    }
    if (resource === "prospect") {
      // Primeiro contato de prospecção (imagens + texto), registrado no histórico do agente
      if (!userId) return new Response(JSON.stringify({ error: "Token sem owner; recrie o token." }), { status: 400 });
      const { enviarProspeccao, ProspectError } = await import("@/lib/prospect.server");
      try {
        return Response.json(await enviarProspeccao(companyId, userId, body));
      } catch (e: any) {
        const status = e instanceof ProspectError ? e.status : 500;
        const code = e instanceof ProspectError ? e.code : "erro_envio";
        return new Response(JSON.stringify({ error: String(e?.message ?? e), code }), { status, headers: { "Content-Type": "application/json" } });
      }
    }
    if (resource === "messages") {
      const numero = String(body.numero || "").replace(/\D/g, "");
      const texto = String(body.texto || "");
      if (!numero || !texto) return new Response(JSON.stringify({ error: "numero e texto obrigatórios" }), { status: 400 });
      const { data: inst } = await (supabaseAdmin as any).from("whatsapp_instances")
        .select("instance_name, status").eq("company_id", companyId).maybeSingle();
      if (!inst || inst.status !== "connected") return new Response(JSON.stringify({ error: "WhatsApp não conectado" }), { status: 400 });
      if (!userId) return new Response(JSON.stringify({ error: "Token sem owner; recrie o token." }), { status: 400 });
      try {
        const { evoSendText } = await import("@/lib/evolution.server");
        await evoSendText(inst.instance_name, numero, texto);
        await (supabaseAdmin as any).from("mensagens").insert({
          company_id: companyId, user_id: userId, numero, direcao: "saida", autor: "api", texto,
        });
        return Response.json({ ok: true });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: String(e?.message ?? e) }), { status: 500 });
      }
    }
    return new Response(JSON.stringify({ error: "Unknown resource" }), { status: 400 });
  }

  return new Response("Method Not Allowed", { status: 405 });
}

export const Route = createFileRoute("/api/public/v1/$")({
  server: {
    handlers: {
      GET: ({ request }) => handle(request),
      POST: ({ request }) => handle(request),
    },
  },
});
