import { createFileRoute } from "@tanstack/react-router";
import { HelpTip } from "@/components/help-tip";
import { useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Loader2, RefreshCw, Power, QrCode, KeyRound } from "lucide-react";
import { brand } from "@/config/brand";
import { connectWhatsapp, checkWhatsappStatus, disconnectWhatsapp } from "@/lib/evolution.functions";
import { usePlanFeatures } from "@/hooks/use-plan-features";
import { PlanUsageBadge } from "@/components/plan-usage-badge";

export const Route = createFileRoute("/app/conexao")({
  head: () => ({ meta: [{ title: `${brand.name} — Conexão` }] }),
  component: ConexaoPage,
});

function ConexaoPage() {
  const connect = useServerFn(connectWhatsapp);
  const check = useServerFn(checkWhatsappStatus);
  const disconnect = useServerFn(disconnectWhatsapp);
  const plan = usePlanFeatures();

  const [loading, setLoading] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("disconnected");
  const [numero, setNumero] = useState<string | null>(null);
  const [pairMode, setPairMode] = useState(false);
  const [pairPhone, setPairPhone] = useState("");
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    void doCheck();
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  function startPolling() {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(() => { void doCheck(true); }, 5000);
  }
  function stopPolling() {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
  }

  async function doCheck(silent = false) {
    try {
      const r: any = await check();
      setStatus(r.status);
      setNumero(r.numero ?? null);
      if (r.qrBase64 && r.status !== "connected") {
        setQr(r.qrBase64);
        if (!pollRef.current) startPolling();
      }
      if (r.status === "connected") { setQr(null); setPairingCode(null); stopPolling(); if (!silent) toast.success("WhatsApp conectado!"); }
    } catch (e: any) { if (!silent) toast.error(e?.message || "Erro ao consultar status"); }
  }

  async function doConnectWithCode(e: React.FormEvent) {
    e.preventDefault();
    if (pairPhone.replace(/\D/g, "").length < 10) return toast.error("Informe o número com DDD.");
    setLoading(true); setQr(null); setPairingCode(null);
    try {
      const r: any = await connect({ data: { numero: pairPhone } });
      setStatus(r.state === "open" ? "connected" : "connecting");
      if (r.state === "open") toast.success("Já está conectado!");
      else if (r.pairingCode) { setPairingCode(r.pairingCode); toast.message("Código gerado. Digite no WhatsApp."); startPolling(); }
    } catch (e: any) { toast.error(e?.message || "Falha ao gerar o código"); }
    finally { setLoading(false); }
  }

  async function doConnect() {
    setLoading(true); setQr(null); setPairingCode(null);
    try {
      const r = await connect();
      setQr(r.qrBase64 ?? null);
      setStatus(r.state === "open" ? "connected" : "connecting");
      if (r.state === "open") toast.success("Já está conectado!");
      else if (r.qrBase64) { toast.message("QR Code gerado. Escaneie no WhatsApp."); startPolling(); }
      else { toast.message("Instância criada. Buscando QR…"); startPolling(); }
    } catch (e: any) { toast.error(e?.message || "Falha ao conectar"); }
    finally { setLoading(false); }
  }

  async function doDisconnect() {
    setLoading(true);
    try {
      await disconnect();
      setStatus("disconnected"); setNumero(null); setQr(null); setPairingCode(null); stopPolling();
      toast.success("Desconectado");
    } catch (e: any) { toast.error(e?.message || "Falha ao desconectar"); }
    finally { setLoading(false); }
  }

  const statusBadge =
    status === "connected" ? <Badge className="bg-primary">Conectado</Badge>
    : status === "connecting" ? <Badge variant="secondary" className="bg-amber-500/15 text-amber-700">Conectando…</Badge>
    : <Badge variant="outline">Desconectado</Badge>;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">Conexão WhatsApp <HelpTip text="Pareie seu número escaneando o QR Code no celular. Depois disso, o agente passa a responder automaticamente as mensagens recebidas." /></h1>
          <p className="text-sm text-muted-foreground">Conecte sua linha via Evolution API.</p>
        </div>
        {!plan.loading && (
          <PlanUsageBadge label="números" used={plan.usage.instancias} limit={plan.limites.instancias} />
        )}
      </div>


      <Card className="p-6">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div>
            <div className="text-sm text-muted-foreground">Status</div>
            <div className="flex items-center gap-3 mt-1">
              {statusBadge}
              {numero && <span className="text-sm text-muted-foreground">· {numero}</span>}
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => doCheck()} disabled={loading}>
              <RefreshCw className="size-4 mr-1.5" /> Atualizar
            </Button>
            {status === "connected" ? (
              <Button variant="destructive" size="sm" onClick={doDisconnect} disabled={loading}>
                <Power className="size-4 mr-1.5" /> Desconectar
              </Button>
            ) : (
              <Button size="sm" onClick={doConnect} disabled={loading}>
                {loading ? <Loader2 className="size-4 mr-1.5 animate-spin" /> : <QrCode className="size-4 mr-1.5" />}
                {qr ? "Gerar novo QR" : "Conectar WhatsApp"}
              </Button>
            )}
          </div>
        </div>

        {qr ? (
          <div className="grid md:grid-cols-2 gap-6 items-center">
            <div className="bg-white p-4 rounded-xl border border-border w-fit mx-auto">
              <img src={qr} alt="QR Code WhatsApp" className="size-72 object-contain" />
            </div>
            <div className="space-y-3 text-sm">
              <h3 className="font-semibold text-base">Como escanear</h3>
              <ol className="list-decimal pl-5 space-y-1.5 text-muted-foreground">
                <li>Abra o WhatsApp no celular.</li>
                <li>Toque em <b>Aparelhos conectados</b>.</li>
                <li>Toque em <b>Conectar um aparelho</b>.</li>
                <li>Aponte para esta tela.</li>
              </ol>
              <p className="text-xs text-muted-foreground">Verificando a cada 5 s.</p>
            </div>
          </div>
        ) : pairingCode ? (
          <div className="grid md:grid-cols-2 gap-6 items-center">
            <div className="mx-auto text-center">
              <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2">Seu código</div>
              <div className="font-mono text-4xl font-bold tracking-[0.25em] rounded-xl border border-border px-6 py-5 bg-[color:var(--panel-2)] select-all">
                {pairingCode.length === 8 ? `${pairingCode.slice(0, 4)}-${pairingCode.slice(4)}` : pairingCode}
              </div>
            </div>
            <div className="space-y-3 text-sm">
              <h3 className="font-semibold text-base">Como usar o código</h3>
              <ol className="list-decimal pl-5 space-y-1.5 text-muted-foreground">
                <li>Abra o WhatsApp no celular.</li>
                <li>Toque em <b>Aparelhos conectados</b> → <b>Conectar um aparelho</b>.</li>
                <li>Toque em <b>Conectar com número de telefone</b>.</li>
                <li>Digite o código ao lado.</li>
              </ol>
              <p className="text-xs text-muted-foreground">O código expira em cerca de 1 minuto. Verificando a cada 5 s.</p>
            </div>
          </div>
        ) : status === "connected" ? (
          <div className="text-sm text-muted-foreground">Tudo certo! As mensagens serão respondidas automaticamente.</div>
        ) : (
          <div className="text-sm text-muted-foreground">Clique em <b>Conectar WhatsApp</b> para gerar o QR Code.</div>
        )}

        {status !== "connected" && (
          <div className="mt-5 pt-4 border-t border-border">
            {!pairMode ? (
              <button type="button" onClick={() => setPairMode(true)} className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 underline underline-offset-2">
                <KeyRound className="size-3.5" /> QR Code não funciona? Conectar com código de 8 dígitos
              </button>
            ) : (
              <form onSubmit={doConnectWithCode} className="flex flex-wrap items-end gap-2">
                <div className="space-y-1.5 flex-1 min-w-[200px]">
                  <Label htmlFor="pair-phone">Número do WhatsApp que vai conectar</Label>
                  <Input id="pair-phone" inputMode="tel" placeholder="(11) 91234-5678" value={pairPhone} onChange={(e) => setPairPhone(e.target.value)} />
                </div>
                <Button type="submit" size="sm" disabled={loading} className="h-9">
                  {loading ? <Loader2 className="size-4 mr-1.5 animate-spin" /> : <KeyRound className="size-4 mr-1.5" />}
                  {pairingCode ? "Gerar novo código" : "Gerar código"}
                </Button>
              </form>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
