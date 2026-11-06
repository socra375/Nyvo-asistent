import { buildDeps } from '../server/app.js';
import { handle } from '../server/http/routes.js';
import type { Req, Res } from '../server/http/http.js';

/** Única función serverless de Nyvo: todas las rutas /api/* llegan aquí (ver vercel.json). */
export default async function handler(req: Req, res: Res): Promise<void> {
  await handle(req, res, buildDeps());
}
