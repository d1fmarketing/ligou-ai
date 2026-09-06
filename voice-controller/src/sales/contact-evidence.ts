const escapeRegex = (text:string) => text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');

/** Match a complete contact in speech evidence. Keep email accents intact and
 * distinguish address separators from ordinary spaces between spoken words. */
export function hasCompleteContact(text:string,value:string,channel:string):boolean {
  if(channel==='phone') {
    const wanted=value.replace(/\D/g,'');
    if(!wanted)return false;
    const numbers=text.match(/\+?\d(?:(?:[\d\s()-]|\.(?=\d))*\d)?/g)??[];
    return numbers.some(number=>number.replace(/\D/g,'')===wanted);
  }
  if(channel!=='email'||!value.includes('@'))return false;
  const address=value.normalize('NFC').toLowerCase();
  const spoken=text.normalize('NFC').toLowerCase();
  const separators:Record<string,string>={
    '@':'(?:\\s*@\\s*|\\s+(?:arroba|at)\\s+)',
    '.':'(?:\\s*\\.\\s*|\\s+(?:ponto|punto|dot)\\s+)',
    '+':'(?:\\s*\\+\\s*|\\s+(?:plus|mais)\\s+)',
    '-':'(?:\\s*-\\s*|\\s+(?:hyphen|hífen|hifen|traço)\\s+)',
    '_':'(?:\\s*_\\s*|\\s+(?:underscore|under score)\\s+)',
  };
  const pattern=[...address].map(char=>separators[char]||escapeRegex(char)).join('');
  // Apply the separator grammar at both boundaries too. A spaced dot followed
  // by another word is ambiguous; require a clearer readback, never truncate it.
  const separator=`(?:${Object.entries(separators).filter(([char])=>char!=='@').map(([,pattern])=>pattern).join('|')}|\\s*[.!#$%&'*+/=?^_\x60{|}~@-]\\s*)`;
  const prefix="(?<![\\p{L}\\p{N}.!#$%&'*+/=?^_\\x60{|}~@-])"+`(?<![\\p{L}\\p{N}]${separator})`;
  const suffix=`(?![\\p{L}\\p{N}_@-]|${separator}[\\p{L}\\p{N}])`;
  return new RegExp(prefix+pattern+suffix,'u').test(spoken);
}
