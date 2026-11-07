/**
 * Convierte brain/nyvo_core_system.md (el cerebro de Nyvo) en un módulo TypeScript que el servidor importa.
 * Así el texto viaja dentro del código desplegado y no depende de leer archivos en tiempo de ejecución en Vercel.
 * Se ejecuta en cada build (`npm run build:brain`). Una prueba comprueba que el módulo generado coincide con el .md.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const md = readFileSync(path.join(root, 'brain', 'nyvo_core_system.md'), 'utf8');
const out = `// GENERADO por scripts/build-brain.ts a partir de brain/nyvo_core_system.md. No se edita a mano: edita el .md.\nexport const BRAIN_MD: string = ${JSON.stringify(md)};\n`;
writeFileSync(path.join(root, 'server', 'agents', 'brain.generated.ts'), out);
console.log(`Cerebro de Nyvo: ${md.length} caracteres → server/agents/brain.generated.ts`);
