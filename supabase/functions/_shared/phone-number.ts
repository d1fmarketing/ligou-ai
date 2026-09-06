/** Exact destination identity only. No digit stripping, percent decoding or fallback. */
export function canonicalPhoneNumber(value: unknown): string | null {
  if(typeof value!=='string'||value.length>256||/[,\r\n\0]/.test(value))return null;
  let raw=value.trim();
  if(raw.includes('<')||raw.includes('>')){
    const wrapped=raw.match(/^[^<>]*<([^<>]+)>(?:\s*;[a-z0-9_-]+=[a-z0-9._-]+)*$/i);
    if(!wrapped)return null;raw=wrapped[1];
  }
  if(/^\+[1-9]\d{6,14}$/.test(raw))return raw;
  const tel=raw.match(/^tel:(\+[1-9]\d{6,14})$/i);if(tel)return tel[1];
  const sip=raw.match(/^sips?:(\+[1-9]\d{6,14})@[a-z0-9.-]+(?::\d{1,5})?(?:;[a-z0-9_-]+(?:=[a-z0-9._+-]+)?)*$/i);
  return sip?.[1]??null;
}
