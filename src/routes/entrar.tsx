import { createFileRoute, redirect, useNavigate, Link, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { z } from "zod";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import {
  Sparkles,
  Loader2,
  Bot,
  KanbanSquare,
  ShieldCheck,
  Zap,
  ArrowLeft,
  CheckCircle2,
  MailCheck,
} from "lucide-react";
import { brand } from "@/config/brand";
import { createTrialAccount } from "@/lib/signup.functions";

type Search = { modo?: "login" | "signup"; plano?: string };

type PlanInfo = { nome: string; trialDays: number };

export const Route = createFileRoute("/entrar")({
  ssr: false,
  head: () => ({ meta: [{ title: `${brand.name} — Começar` }] }),
  validateSearch: (s: Record<string, unknown>): Search => ({
    modo: s.modo === "login" ? "login" : "signup",
    plano: typeof s.plano === "string" ? s.plano : undefined,
  }),
  beforeLoad: async ({ search }) => {
    const { data } = await supabase.auth.getUser();
    if (data.user) {
      const dest = search.plano ? `/app/checkout?plano=${encodeURIComponent(search.plano)}` : "/app/dashboard";
      throw redirect({ href: dest });
    }
  },
  component: EntrarPage,
});

const emailSchema = z.string().email("E-mail inválido");

function EntrarPage() {
  const navigate = useNavigate();
  const search = useSearch({ from: "/entrar" }) as Search;
  const signup = useServerFn(createTrialAccount);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [needsPassword, setNeedsPassword] = useState(search.modo === "login");
  const [loading, setLoading] = useState(false);
  const [planInfo, setPlanInfo] = useState<PlanInfo | null>(null);
  const [emailSent, setEmailSent] = useState(false);

  useEffect(() => {
    if (!search.plano) { setPlanInfo(null); return; }
    let cancelled = false;
    supabase
      .from("plan")
      .select("slug, nome, trial_days")
      .eq("slug", search.plano)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled || !data) return;
        setPlanInfo({ nome: data.nome, trialDays: data.trial_days });
      });
    return () => { cancelled = true; };
  }, [search.plano]);

  async function routeAfterAuth() {
    const { data: u } = await supabase.auth.getUser();
    if (!u.user) return;
    // Garante perfil criado e promove o primeiro usuário a Master
    await supabase.rpc("bootstrap_current_user");
    if (search.plano) {
      navigate({ to: "/app/checkout", search: { plano: search.plano } as any, replace: true });
      return;
    }
    const { data: roles } = await supabase.from("user_roles").select("role").eq("user_id", u.user.id);
    if (roles?.some((r) => r.role === "super_admin")) {
      navigate({ to: "/master/painel", replace: true });
      return;
    }
    const { data: cu } = await supabase.from("company_user").select("company_id").eq("user_id", u.user.id).eq("ativo", true).maybeSingle();
    navigate({ href: cu ? "/app/dashboard" : "/app/checkout", replace: true });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const v = emailSchema.safeParse(email);
    if (!v.success) return toast.error(v.error.issues[0].message);
    setLoading(true);

    if (needsPassword) {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      setLoading(false);
      if (error) {
        if (error.message.toLowerCase().includes("email not confirmed")) {
          return toast.error("Confirme seu e-mail antes de entrar.", { description: "Procure o e-mail com seu login e senha e clique no botão de confirmação." });
        }
        return toast.error("E-mail ou senha incorretos. Tente novamente ou recupere sua senha.");
      }
      toast.success("Bem-vindo de volta!");
      return routeAfterAuth();
    }

    // Conta + senha nascem no servidor (ver src/lib/signup.functions.ts), que
    // manda um único e-mail com e-mail+senha e o link real de confirmação.
    // O login só passa a funcionar depois que esse link é clicado.
    try {
      await signup({ data: { email, plano: search.plano } });
      setLoading(false);
      setEmailSent(true);
    } catch (err: any) {
      setLoading(false);
      const msg = (err?.message || "").toLowerCase();
      if (msg.includes("já existe") || msg.includes("already") || msg.includes("registered") || msg.includes("exists")) {
        setNeedsPassword(true);
        toast.message("Já existe uma conta com esse e-mail.", { description: "Digite sua senha para continuar." });
        return;
      }
      toast.error(err?.message || "Falha ao criar conta");
    }
  }

  return (
    <div className="min-h-screen w-full relative overflow-hidden bg-background text-foreground">
      {/* Ambient glows — same vibe as LP */}
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <div
          className="absolute -top-40 -left-40 h-[600px] w-[600px] rounded-full blur-3xl opacity-40"
          style={{ background: "radial-gradient(circle, #25D366 0%, transparent 60%)" }}
        />
        <div
          className="absolute top-[30%] -right-40 h-[700px] w-[700px] rounded-full blur-3xl opacity-25"
          style={{ background: "radial-gradient(circle, #06b6d4 0%, transparent 65%)" }}
        />
        <div
          className="absolute bottom-[-200px] left-1/3 h-[500px] w-[500px] rounded-full blur-3xl opacity-20"
          style={{ background: "radial-gradient(circle, #16A34A 0%, transparent 60%)" }}
        />
      </div>

      <div className="relative z-10 min-h-screen grid lg:grid-cols-[1.05fr_1fr]">
        {/* LEFT — brand pane (hidden on mobile) */}
        <aside className="hidden lg:flex flex-col justify-between p-10 xl:p-14 border-r border-[color:var(--hairline)] bg-[linear-gradient(160deg,rgba(22,163,74,.10),rgba(34,211,238,.04)_55%,transparent)]">
          <div className="flex items-center gap-3">
            <Link to="/" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors">
              <ArrowLeft className="size-4" />
              voltar ao site
            </Link>
          </div>

          <div className="space-y-8 max-w-lg">
            <div className="flex items-center gap-3">
              <img src="/logo-mascot.svg" alt="" className="size-12 rounded-2xl shadow-[0_10px_30px_-10px_rgba(22,163,74,.6)] ring-1 ring-white/20" />
              <div>
                <div className="font-display font-extrabold text-2xl text-gradient-brand leading-none">{brand.name}</div>
                <div className="text-[12px] text-muted-foreground mt-1">{brand.tagline}</div>
              </div>
            </div>

            <h1 className="font-display text-4xl xl:text-5xl font-extrabold leading-[1.05] tracking-tight">
              Sua IA atende o<br />
              <span className="text-gradient-brand">WhatsApp 24h</span> e<br />
              organiza o CRM sozinha.
            </h1>

            <p className="text-[15px] text-muted-foreground leading-relaxed">
              Conecte seu número em 2 minutos. A gente cuida do resto — respostas, qualificação e movimentação dos leads no funil, no automático.
            </p>

            <div className="grid gap-3">
              <Feature icon={<Bot className="size-4" />} title="IA treinada no seu negócio" desc="Responde no seu tom, sem parecer robô." />
              <Feature icon={<KanbanSquare className="size-4" />} title="CRM Kanban inteligente" desc="Cada lead se move sozinho pelo funil." />
              <Feature icon={<Zap className="size-4" />} title="Pronto em 2 minutos" desc="Escaneou o QR, já está atendendo." />
            </div>

            <div className="flex items-center gap-4 pt-2 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5"><ShieldCheck className="size-3.5 text-[color:var(--brand)]" /> LGPD-friendly</span>
              <span className="inline-flex items-center gap-1.5"><CheckCircle2 className="size-3.5 text-[color:var(--brand)]" /> Pronto em até 48h</span>
              <span className="inline-flex items-center gap-1.5"><CheckCircle2 className="size-3.5 text-[color:var(--brand)]" /> Cancele quando quiser</span>
            </div>
          </div>

          <div className="text-[12px] text-muted-foreground">
            © {new Date().getFullYear()} {brand.name}. Todos os direitos reservados.
          </div>
        </aside>

        {/* RIGHT — form */}
        <main className="flex flex-col items-center justify-center px-5 py-10 sm:px-10">
          {/* Mobile brand header */}
          <div className="lg:hidden w-full max-w-md mb-6 flex items-center justify-between">
            <Link to="/" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
              <ArrowLeft className="size-4" /> voltar
            </Link>
            <div className="flex items-center gap-2">
              <img src="/logo-mascot.svg" alt="" className="size-9 rounded-xl shadow-md" />
              <div className="font-display font-bold text-[15px] text-gradient-brand">{brand.name}</div>
            </div>
          </div>

          <div className="w-full max-w-md">
            <div className="relative panel p-7 sm:p-8 glow-brand overflow-hidden">
              {/* corner accent */}
              <div
                aria-hidden
                className="absolute -top-24 -right-24 size-56 rounded-full blur-3xl opacity-50"
                style={{ background: "radial-gradient(circle, rgba(22,163,74,.35) 0%, transparent 70%)" }}
              />

              <div className="relative">
                {emailSent ? (
                  <div className="text-center py-2">
                    <div className="size-14 mx-auto rounded-full bg-[color:var(--brand-soft)] grid place-items-center mb-4">
                      <MailCheck className="size-7 text-[color:var(--brand-text)]" />
                    </div>
                    <h1 className="font-display text-[24px] font-extrabold leading-tight tracking-tight">
                      Confira seu e-mail
                    </h1>
                    <p className="text-sm text-muted-foreground mt-2 leading-relaxed">
                      Mandamos um e-mail pra <span className="font-semibold text-foreground">{email}</span> com seu login, senha e um botão de confirmação.
                      Clique nele pra liberar o acesso — o login só funciona depois disso.
                    </p>
                    <button
                      type="button"
                      onClick={() => setEmailSent(false)}
                      className="text-[12.5px] text-muted-foreground hover:text-foreground underline underline-offset-2 mt-5"
                    >
                      Errei o e-mail, quero corrigir
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[color:var(--brand-soft)] border border-[color:var(--brand)]/20 text-[11px] font-semibold text-[color:var(--brand-text)] mb-3">
                      <span className="size-1.5 rounded-full bg-[color:var(--brand)] dot-pulse" />
                      {needsPassword ? "Acesso à conta" : "7 dias grátis, sem cartão"}
                    </div>

                    <h1 className="font-display text-[26px] sm:text-[28px] font-extrabold leading-tight tracking-tight">
                      {needsPassword ? "Bem-vindo de volta" : "Comece grátis agora"}
                    </h1>
                    <p className="text-sm text-muted-foreground mt-1.5 mb-6">
                      {needsPassword
                        ? `Entre com o e-mail e senha da sua conta ${brand.name}.`
                        : "Informe seu e-mail. A gente cria sua conta e manda o login por lá."}
                    </p>

                    {planInfo && (
                      <div className="mb-5 rounded-xl border border-[color:var(--brand)]/30 bg-[color:var(--brand-soft)] p-4">
                        <div className="flex items-center gap-2 text-[11px] uppercase font-bold tracking-[0.14em] text-[color:var(--brand-text)]">
                          <Sparkles className="size-3.5" /> Plano escolhido
                        </div>
                        <div className="mt-1 flex items-baseline justify-between">
                          <div className="font-display text-lg font-bold">{planInfo.nome}</div>
                          <div className="text-sm font-semibold">{planInfo.trialDays} dias grátis</div>
                        </div>
                      </div>
                    )}

                    <form onSubmit={handleSubmit} className="space-y-4">
                      <div className="space-y-1.5">
                        <Label htmlFor="email">E-mail</Label>
                        <Input
                          id="email"
                          type="email"
                          value={email}
                          onChange={(e) => setEmail(e.target.value)}
                          required
                          autoFocus
                          placeholder="voce@empresa.com"
                          className="h-11"
                        />
                      </div>

                      {needsPassword && (
                        <div className="space-y-1.5">
                          <div className="flex items-center justify-between">
                            <Label htmlFor="pwd">Senha</Label>
                            <Link to="/esqueci-senha" className="text-[11.5px] font-medium text-muted-foreground hover:text-[color:var(--brand-text)] transition-colors">
                              Esqueci minha senha
                            </Link>
                          </div>
                          <Input id="pwd" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required className="h-11" />
                        </div>
                      )}

                      <Button
                        type="submit"
                        disabled={loading}
                        size="lg"
                        className="w-full h-12 bg-gradient-brand text-primary-foreground hover:opacity-95 font-semibold text-[14.5px] shadow-[0_8px_24px_-10px_rgba(22,163,74,.6)]"
                      >
                        {loading && <Loader2 className="size-4 mr-2 animate-spin" />}
                        {needsPassword ? "Entrar" : "Começar grátis"}
                      </Button>

                      <p className="text-[11.5px] text-muted-foreground text-center pt-1 leading-relaxed">
                        {needsPassword ? (
                          <>Ainda não é cliente?{" "}
                            <button type="button" onClick={() => setNeedsPassword(false)} className="underline underline-offset-2 hover:text-foreground">
                              Comece seu teste grátis
                            </button>
                          </>
                        ) : (
                          <>Já tem conta?{" "}
                            <button type="button" onClick={() => setNeedsPassword(true)} className="underline underline-offset-2 hover:text-foreground">
                              Entrar
                            </button>
                          </>
                        )}
                      </p>
                    </form>
                  </>
                )}
              </div>
            </div>

            <p className="text-[11.5px] text-muted-foreground text-center mt-5">
              Ao continuar, você concorda com nossos{" "}
              <Link to="/termos" className="underline underline-offset-2 hover:text-foreground">Termos</Link>{" "}
              e{" "}
              <Link to="/privacidade" className="underline underline-offset-2 hover:text-foreground">Política de privacidade</Link>.
            </p>
          </div>
        </main>
      </div>
    </div>
  );
}

function Feature({ icon, title, desc }: { icon: React.ReactNode; title: string; desc: string }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-[color:var(--hairline)] bg-[color:var(--panel)]/60 backdrop-blur-sm p-3.5">
      <div className="size-9 rounded-lg grid place-items-center bg-[color:var(--brand-soft)] text-[color:var(--brand-text)] shrink-0 ring-1 ring-[color:var(--brand)]/15">
        {icon}
      </div>
      <div className="min-w-0">
        <div className="font-semibold text-[13.5px] leading-tight">{title}</div>
        <div className="text-[12px] text-muted-foreground mt-0.5">{desc}</div>
      </div>
    </div>
  );
}
