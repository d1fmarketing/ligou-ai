export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}

function safeReturnUrl(value: string): string {
  if (/[\s"'<>]/.test(value)) return "/";
  try {
    const parsed = new URL(value);
    const localHttp = parsed.protocol === "http:" && ["127.0.0.1", "localhost"].includes(parsed.hostname);
    if (parsed.protocol !== "https:" && !localHttp) return "/";
    return parsed.toString();
  } catch {
    return "/";
  }
}

export function renderCallbackPage(input: { title: string; body: string; returnUrl: string; ok: boolean }): string {
  const title = escapeHtml(input.title);
  const body = escapeHtml(input.body);
  const returnUrl = escapeHtml(safeReturnUrl(input.returnUrl));
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>`
    + `<style>body{font-family:system-ui;margin:0;display:grid;place-items:center;height:100vh;background:#faf9f7;color:#1c1917}`
    + `.c{max-width:28rem;padding:2rem;border-radius:1rem;background:#fff;box-shadow:0 1px 3px #0001;text-align:center}`
    + `h1{font-size:1.25rem;margin:0 0 .5rem}p{color:#57534e;line-height:1.5}`
    + `.b{display:inline-block;margin-top:1rem;padding:.6rem 1rem;border-radius:.6rem;background:#e2703a;color:#fff;text-decoration:none}</style>`
    + `<div class="c"><h1>${input.ok ? "✅" : "⚠️"} ${title}</h1><p>${body}</p>`
    + `<a class="b" href="${returnUrl}">Voltar ao painel</a></div>`;
}
