// "Esperar antes de responder" (segundos_buffer) do agente de UMA instância, 2026-11-26.
// Sem o 3º argumento só mostra o valor atual.
// Uso, na VPS:  docker exec -i atendezap-app-1 node --input-type=module - <instancia> [segundos] < scripts/espera-agente.mjs
const [instancia, segundos] = process.argv.slice(2)
const URL = String(process.env.SUPABASE_URL || "").replace(/\/+$/, "") + "/rest/v1/"
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ""
const h = { apikey: KEY, Authorization: "Bearer " + KEY, "Content-Type": "application/json" }
const get = async (q) => (await fetch(URL + q, { headers: h })).json()
const inst = (await get(`whatsapp_instances?instance_name=eq.${encodeURIComponent(instancia || "")}&select=company_id`))[0]
if (!inst) { console.log("instância não encontrada:", instancia); process.exit(1) }
const antes = (await get(`agent_config?company_id=eq.${inst.company_id}&select=company_id,segundos_buffer,nome_agente`))[0]
console.log(`empresa ${inst.company_id} · agente: ${antes?.nome_agente ?? "-"} · espera atual: ${antes?.segundos_buffer ?? "(padrão 8)"} s`)
if (segundos === undefined) process.exit(0)
const n = Math.max(0, Math.min(20, Number(segundos)))
const r = await fetch(URL + `agent_config?company_id=eq.${inst.company_id}`, { method: "PATCH", headers: { ...h, Prefer: "return=representation" }, body: JSON.stringify({ segundos_buffer: n }) })
const j = await r.json().catch(() => [])
console.log(`atualizado: ${r.status} · espera agora: ${Array.isArray(j) && j[0] ? j[0].segundos_buffer : JSON.stringify(j).slice(0, 200)} s`)
