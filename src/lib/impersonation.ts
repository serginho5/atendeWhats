// "Entrar como" do /master: a empresa escolhida fica no sessionStorage DESTA aba
// (master_impersonate_company). Este middleware global manda esse id em toda chamada
// de server function, para o servidor agir na empresa certa (antes ele sempre usava
// a empresa mais antiga do login, e "Conectar WhatsApp" numa subconta mexia na conta-mãe).
import { createMiddleware } from "@tanstack/react-start";

export const IMPERSONATE_HEADER = "x-master-impersonate";

export const attachImpersonation = createMiddleware({ type: "function" }).client(async ({ next }) => {
  let id: string | null = null;
  try { id = sessionStorage.getItem("master_impersonate_company"); } catch {}
  return next({ headers: id ? { [IMPERSONATE_HEADER]: id } : {} });
});
