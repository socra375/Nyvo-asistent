/**
 * Configuración del servidor. Todas las claves viven solo aquí (variables de entorno del servidor);
 * nunca se envían al navegador. Las URL base se pueden cambiar para pruebas (servidores falsos locales).
 */
export type Env = Record<string, string | undefined>;

export interface Config {
  env: Env;
  production: boolean;
  appUrl: string | undefined;
  databaseUrl: string | undefined;
  sessionSecret: string | undefined;
  ownerEmails: string[];
  cronSecret: string | undefined;
  urls: {
    gemini: string;
    notion: string;
    googleAuth: string;
    googleToken: string;
    googleDrive: string;
    elevenlabs: string;
    speechify: string;
  };
  limits: {
    ttsMaxChars: number;
    sttMaxBytes: number;
    specialistDeadlineMs: number;
    specialistMaxCalls: number;
    jobsTickBudgetMs: number;
  };
}

const int = (v: string | undefined, def: number) => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : def;
};

export function loadConfig(env: Env = process.env): Config {
  return {
    env,
    production: env.NODE_ENV === 'production' || Boolean(env.VERCEL),
    appUrl: env.APP_URL?.replace(/\/$/, ''),
    databaseUrl: env.DATABASE_URL,
    sessionSecret: env.SESSION_SECRET,
    ownerEmails: (env.NYVO_OWNER_EMAIL ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
    cronSecret: env.CRON_SECRET,
    urls: {
      gemini: env.GEMINI_API_URL ?? 'https://generativelanguage.googleapis.com',
      notion: env.NOTION_API_URL ?? 'https://api.notion.com',
      googleAuth: env.GOOGLE_AUTH_URL ?? 'https://accounts.google.com/o/oauth2/v2/auth',
      googleToken: env.GOOGLE_TOKEN_URL ?? 'https://oauth2.googleapis.com/token',
      googleDrive: env.GOOGLE_DRIVE_API_URL ?? 'https://www.googleapis.com',
      elevenlabs: env.ELEVENLABS_API_URL ?? 'https://api.elevenlabs.io',
      speechify: env.SPEECHIFY_API_URL ?? 'https://api.sws.speechify.com'
    },
    limits: {
      ttsMaxChars: int(env.TTS_MAX_CHARS, 1500),
      sttMaxBytes: int(env.STT_MAX_BYTES, 3_000_000),
      specialistDeadlineMs: int(env.SPECIALIST_DEADLINE_MS, 40_000),
      specialistMaxCalls: int(env.SPECIALIST_MAX_CALLS, 8),
      jobsTickBudgetMs: int(env.JOBS_TICK_BUDGET_MS, 45_000)
    }
  };
}

/** Devuelve los nombres de variables que faltan (vacías o ausentes). */
export function missingEnv(env: Env, names: readonly string[]): string[] {
  return names.filter(n => !env[n] || !String(env[n]).trim());
}
