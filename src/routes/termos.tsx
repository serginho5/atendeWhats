import { createFileRoute, Link } from "@tanstack/react-router";
import { brand } from "@/config/brand";

export const Route = createFileRoute("/termos")({
  head: () => ({
    meta: [
      { title: `Termos e Condições — ${brand.name}` },
      { name: "description", content: `Termos e Condições de uso do ${brand.name}.` },
    ],
  }),
  component: TermosPage,
});

function TermosPage() {
  return (
    <main className="min-h-screen bg-white text-slate-900">
      <div className="max-w-3xl mx-auto px-6 py-16">
        <Link to="/" className="text-sm text-slate-500 hover:text-slate-900">← Voltar</Link>
        <h1 className="mt-6 text-4xl font-bold">Termos e Condições</h1>
        <p className="mt-2 text-sm text-slate-500">Última atualização: 17 de junho de 2026</p>

        <div className="mt-10 space-y-8 leading-relaxed text-slate-700">
          <section>
            <h2 className="text-xl font-semibold text-slate-900">1. Quem somos</h2>
            <p className="mt-2">
              Estes Termos regulam o uso do serviço {brand.name} ("Serviço"), fornecido por
              <strong> {brand.name}</strong> ("nós", "nosso"). Ao usar o Serviço, você concorda com
              estes Termos. Se não concordar, não utilize o Serviço.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-slate-900">2. Aceitação</h2>
            <p className="mt-2">
              Ao criar uma conta, contratar um plano ou continuar usando o Serviço, você
              declara ter capacidade legal para celebrar este contrato e concorda integralmente
              com estes Termos.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-slate-900">3. Descrição do Serviço</h2>
            <p className="mt-2">
              O {brand.name} oferece automação e gestão de atendimento via WhatsApp, incluindo
              recursos de mensageria, fluxos automatizados e integrações.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-slate-900">4. Uso aceitável</h2>
            <p className="mt-2">Você concorda em não:</p>
            <ul className="mt-2 list-disc pl-6 space-y-1">
              <li>usar o Serviço para fins ilegais, fraudulentos ou abusivos;</li>
              <li>enviar spam ou mensagens não solicitadas em violação às leis aplicáveis;</li>
              <li>violar direitos de propriedade intelectual de terceiros;</li>
              <li>interferir na segurança do Serviço (malware, scraping, engenharia reversa);</li>
              <li>revender ou redistribuir o Serviço sem autorização.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-slate-900">5. Propriedade intelectual</h2>
            <p className="mt-2">
              Todo o software, marca, documentação e materiais do Serviço são de propriedade
              do {brand.name}. Concedemos a você uma licença limitada, não exclusiva e
              intransferível para usar o Serviço conforme o plano contratado.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-slate-900">6. Pagamentos e assinaturas</h2>
            <p className="mt-2">
              As cobranças do Serviço — a taxa única de implementação e a mensalidade do plano
              contratado — são processadas pela <strong>Kiwify</strong>, nossa plataforma de
              pagamentos, por cartão, Pix ou boleto. A Kiwify é responsável pelo processamento
              da transação e pela emissão de nota fiscal, quando aplicável.
            </p>
            <p className="mt-2">
              Assinaturas são renovadas automaticamente conforme a periodicidade contratada,
              até que sejam canceladas. Você pode cancelar sua assinatura a qualquer momento
              pela sua conta ou entrando em contato com nosso suporte.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-slate-900">7. Reembolsos</h2>
            <p className="mt-2">
              Reembolsos seguem nossa <Link to="/reembolso" className="underline">Política de Reembolso</Link>.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-slate-900">8. Nível de serviço</h2>
            <p className="mt-2">
              Empenhamo-nos em manter o Serviço disponível, porém não garantimos operação
              ininterrupta ou livre de erros. Garantias implícitas são excluídas na máxima
              extensão permitida pela legislação aplicável.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-slate-900">9. Suspensão e encerramento</h2>
            <p className="mt-2">
              Podemos suspender ou encerrar o acesso em caso de: violação material destes
              Termos, inadimplência, risco de fraude ou segurança, ou violações repetidas das
              nossas políticas.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-slate-900">10. Limitação de responsabilidade</h2>
            <p className="mt-2">
              Na máxima extensão permitida em lei, nossa responsabilidade total será limitada
              aos valores efetivamente pagos por você nos 12 meses anteriores ao evento.
              Não respondemos por danos indiretos, lucros cessantes ou perda de dados.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-slate-900">11. Lei aplicável</h2>
            <p className="mt-2">
              Estes Termos são regidos pelas leis do Brasil. Fica eleito o foro do domicílio
              do {brand.name} para dirimir controvérsias, salvo disposição legal em contrário.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-slate-900">12. Contato</h2>
            <p className="mt-2">
              Dúvidas sobre estes Termos: entre em contato pelos canais do Serviço. Para
              questões de cobrança, você também pode falar com o suporte da Kiwify pelo link
              recebido no e-mail de confirmação da compra.
            </p>
          </section>
        </div>
      </div>
    </main>
  );
}
