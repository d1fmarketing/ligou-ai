export function extractAllowedSipHeaders(headers: Array<{ name?: string; value?: string }>) {
  let calledNumber: string | null = null;
  let callerContact: string | null = null;
  for (const header of Array.isArray(headers) ? headers.slice(0, 64) : []) {
    const name = typeof header?.name === "string" ? header.name.trim().toLowerCase() : "";
    const value = typeof header?.value === "string"
      ? header.value.replace(/[\r\n\u0000]/g, "").trim().slice(0, 120)
      : "";
    if (!value) continue;
    if (name === "to" && calledNumber === null) calledNumber = value;
    if (name === "from" && callerContact === null) callerContact = value;
  }
  return {
    calledNumber,
    callerContact,
    storedHeaders: calledNumber ? { to: calledNumber } : {},
  };
}
