// Diagnóstico do "digitando…" (2026-11-26): testa o envio de presença na Evolution nos dois formatos conhecidos
// e mostra a versão e as configurações da instância. Não manda mensagem nenhuma: só o sinal de digitando (4 s).
// Uso, na VPS:  docker exec -i atendezap-app-1 node --input-type=module - 5511975170775 < /docker/atendezap/scripts/diag-presenca.mjs
const U = String(process.env.EVOLUTION_API_URL || "").replace(/\/+$/, "")
const K = String(process.env.EVOLUTION_API_KEY || "")
const numero = process.argv[2] || process.argv[1]
const fim = (process.env.DIAG_FINAL || "32170285")
const h = { apikey: K, "Content-Type": "application/json" }
const ler = async (r) => { const t = await r.text(); return `${r.status} ${t.slice(0, 220).replace(/\s+/g, " ")}` }
try {
  console.log("Evolution:", await ler(await fetch(U + "/", { headers: h })))
  const lista = await (await fetch(U + "/instance/fetchInstances", { headers: h })).json()
  const insts = (Array.isArray(lista) ? lista : []).map((i) => ({ nome: i.name || i.instance?.instanceName, status: i.connectionStatus || i.instance?.status, dono: i.ownerJid || i.instance?.owner || "" }))
  for (const i of insts) console.log("instância:", i.nome, i.status, i.dono)
  const alvo = insts.find((i) => String(i.dono).includes(fim)) || insts[0]
  if (!alvo) { console.log("nenhuma instância"); process.exit(0) }
  console.log("\nTestando na instância", alvo.nome, "para", numero)
  console.log("config:", await ler(await fetch(U + "/settings/find/" + encodeURIComponent(alvo.nome), { headers: h })))
  const url = U + "/chat/sendPresence/" + encodeURIComponent(alvo.nome)
  console.log("formato v2 {number,presence,delay}:", await ler(await fetch(url, { method: "POST", headers: h, body: JSON.stringify({ number: numero, presence: "composing", delay: 4000 }) })))
  console.log("formato v1 {number,options}:", await ler(await fetch(url, { method: "POST", headers: h, body: JSON.stringify({ number: numero, options: { presence: "composing", delay: 4000 } }) })))
} catch (e) { console.log("erro:", e.message) }
