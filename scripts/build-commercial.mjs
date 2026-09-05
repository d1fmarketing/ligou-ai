import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const result=await Bun.build({entrypoints:[path.join(root,'src/commercial/commercial.jsx')],outdir:path.join(root,'comercial'),naming:'app.js',target:'browser',format:'esm',minify:true});
if(!result.success){for(const log of result.logs)console.error(log);process.exit(1);}
console.log('Commercial viewer built; authenticated RLS remains required.');
