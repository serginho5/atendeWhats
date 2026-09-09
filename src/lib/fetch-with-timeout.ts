// SERVER ONLY. `fetch()` puro no Node não tem timeout — uma chamada externa
// lenta (IA, Google, Evolution API) fica pendurada até o watchdog do próprio
// framework matar a resposta em 120s, o que aparece pro usuário como a tela
// de erro genérica. Usar isso em toda chamada externa server-side garante que
// ela falhe rápido (erro tratável) em vez de travar a resposta inteira.
export async function fetchWithTimeout(
  input: string | URL,
  init: RequestInit = {},
  timeoutMs = 15000,
): Promise<Response> {
  try {
    return await fetch(input, { ...init, signal: init.signal ?? AbortSignal.timeout(timeoutMs) });
  } catch (e: any) {
    if (e?.name === "TimeoutError" || e?.name === "AbortError") {
      throw new Error(`Tempo esgotado (${Math.round(timeoutMs / 1000)}s) ao chamar ${String(input)}`);
    }
    throw e;
  }
}
