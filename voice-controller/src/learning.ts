// Local deterministic learning validators remain available, but the post-call model channel is disabled.
import { minimizeAndRedact } from "../../supabase/functions/_shared/privacy.ts";

const VALID_CATEGORY = new Set(["preco", "area", "agenda", "emergencia", "negociacao", "cliente", "procedimento", "geral"]);
const VALID_ESCOPO = new Set(["geral", "servico", "localizacao", "cliente"]);

export function redactEvidence(turns: Array<{ role: string; text: string }>): Array<{ role: string; text: string }> {
  return turns
    .filter((t) => t.role === "caller" || t.role === "agent")
    .map((t) => ({
      role: t.role,
      text: minimizeAndRedact(t.text, 600),
    }))
    .slice(0, 60);
}

interface Proposal { text: string; category: string; escopo: string; structured?: Record<string, unknown>; evidence?: string }

const MONETARY = /[$€£]|\b\d+(?:[,.]\d+)?\s*(?:usd|dollars?|euros?|reais|brl|gbp)\b/i;

export function validateProposals(raw: unknown): Proposal[] {
  if (!Array.isArray(raw)) return [];
  const out: Proposal[] = [];
  for (const p of raw.slice(0, 8)) {
    if (typeof p !== "object" || p === null) continue;
    const rawText = typeof (p as any).text === "string" ? (p as any).text.trim().slice(0, 500) : "";
    const text = minimizeAndRedact(rawText, 500);
    const category = String((p as any).category ?? "geral");
    const escopo = String((p as any).escopo ?? "geral");
    if (!text || MONETARY.test(rawText) || !VALID_CATEGORY.has(category) || !VALID_ESCOPO.has(escopo)) continue;
    const evidence = typeof (p as any).evidence === "string" ? minimizeAndRedact((p as any).evidence, 800) : undefined;
    out.push({ text, category, escopo, evidence });
  }
  return out;
}

export async function tickLearning(): Promise<number> {
  return 0;
}
