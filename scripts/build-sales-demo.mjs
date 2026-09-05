import {copyFile, mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await mkdir(path.join(root,'assets/js'), {recursive:true});
const result = await Bun.build({entrypoints:[path.join(root,'src/sales-demo/panel.js')],outdir:path.join(root,'assets/js'),naming:'sales-demo.js',target:'browser',format:'esm',minify:true});
if (!result.success) throw new Error(result.logs.map(String).join('\n'));
await copyFile(path.join(root,'src/sales-demo/styles.css'),path.join(root,'assets/sales-demo.css'));
console.log('Sales demo: browser module and scoped CSS built.');
