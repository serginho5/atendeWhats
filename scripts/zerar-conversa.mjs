// Zera a conversa de UM número com UMA instância (para repetir testes do zero), 2026-11-26.
// Apaga só desse número, nessa empresa: as mensagens, a pausa da IA (contact_pause) e o card do CRM (crm_cards).
// NÃO mexe na prospecção (prospeccao_pendente) nem em nenhuma outra conversa.
// Uso, na VPS (sem "apagar" só mostra o que seria apagado):
//   docker exec -i atendezap-app-1 node --input-type=module - 5511975170775 atendezap_7518ba51dece4c47 [apagar] < scripts/zerar-conversa.mjs
const [numero, instancia, modo] = process.argv.slice(2)
const URL = String(process.env.SUPABASE_URL || "").replace(/\/+$/, "") + "/rest/v1/"
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ""
const h = { apikey: KEY, Authorization: "Bearer " + KEY, "Content-Type": "application/json" }
const fim8 = String(numero || "").replace(/\D/g, "").slice(-8)
if (fim8.length < 8 || !instancia) { console.log("uso: <numero> <instancia> [apagar]"); process.exit(1) }
const get = async (q) => (await fetch(URL + q, { headers: h })).json()
const inst = (await get(`whatsapp_instances?instance_name=eq.${encodeURIComponent(instancia)}&select=company_id`))[0]
if (!inst) { console.log("instância não encontrada:", instancia); process.exit(1) }
const filtro = `company_id=eq.${inst.company_id}&numero=like.*${fim8}`
const msgs = await get(`mensagens?${filtro}&select=id,created_at,direcao,texto&order=created_at.asc`)
const pausas = await get(`contact_pause?${filtro}&select=*`)
const cards = await get(`crm_cards?${filtro}&select=id,nome,status,numero`)
console.log(`empresa ${inst.company_id} · número final ${fim8}`)
console.log(`mensagens: ${Array.isArray(msgs) ? msgs.length : JSON.stringify(msgs)}${Array.isArray(msgs) && msgs.length ? ` (de ${msgs[0].created_at.slice(0, 16)} a ${msgs.at(-1).created_at.slice(0, 16)})` : ""}`)
console.log(`pausas da IA: ${Array.isArray(pausas) ? pausas.length : JSON.stringify(pausas)}`)
console.log(`cards do CRM: ${Array.isArray(cards) ? cards.map((c) => `${c.nome || "-"} [${c.status}]`).join(", ") || 0 : JSON.stringify(cards)}`)
if (modo !== "apagar") { console.log('\nNada apagado. Para apagar, rode de novo com "apagar" no fim.'); process.exit(0) }
for (const t of ["mensagens", "contact_pause", "crm_cards"]) {
  const r = await fetch(URL + `${t}?${filtro}`, { method: "DELETE", headers: { ...h, Prefer: "return=representation" } })
  const j = await r.json().catch(() => [])
  console.log(`apagado em ${t}: ${r.status} · ${Array.isArray(j) ? j.length : JSON.stringify(j).slice(0, 200)}`)
}
console.log("\nConversa zerada. O próximo contato desse número começa do início.")
