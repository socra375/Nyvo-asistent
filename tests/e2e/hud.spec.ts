import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

const OWNER = 'ianovasystem3@gmail.com';
const PASSWORD = 'clave-e2e-segura-123';
const SHOTS = 'test-results/capturas';
mkdirSync(SHOTS, { recursive: true });

/** Entra y se queda en la pantalla del orbe (la principal). */
async function loginOrb(page: Page, base = '') {
  await page.goto(`${base}/`);
  await page.getByLabel('Correo').fill(OWNER);
  await page.getByLabel('Contraseña').fill(PASSWORD);
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page.getByTestId('orbscreen')).toBeVisible();
}

/** Entra y abre el panel completo («Centro de mando»). */
async function login(page: Page, base = '') {
  await loginOrb(page, base);
  await page.getByRole('button', { name: 'Panel', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Centro de mando' })).toBeVisible();
}

async function sendChat(page: Page, text: string) {
  await page.getByLabel('Mensaje para Nyvo').fill(text);
  await page.getByRole('button', { name: 'Enviar' }).click();
}

const chat = (page: Page) => page.getByTestId('panel-chat');
const lastAssistant = (page: Page) => page.getByTestId('msg-assistant').last();

test.describe.configure({ mode: 'serial' });

test('inicio de sesión: rechaza contraseña incorrecta y entra con la correcta', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'NYVO' })).toBeVisible();
  await page.getByLabel('Correo').fill(OWNER);
  await page.getByLabel('Contraseña').fill('incorrecta');
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Correo o contraseña incorrectos');
  await expect(page.getByRole('link', { name: 'Entrar con Google' })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/login.png` });
  await login(page);
  await expect(page.getByText(OWNER)).toBeVisible();
});

test('logo y PWA: el logo se ve de verdad y el navegador puede leer manifest e iconos', async ({ page }) => {
  await page.goto('/');
  const loginLogo = page.getByRole('img', { name: 'Logo de Nyvo' });
  await expect(loginLogo).toBeVisible();
  expect(await loginLogo.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
  await page.screenshot({ path: `${SHOTS}/login-logo.png` });

  // Enlaces del <head> que usan el navegador y el sistema para el icono y la instalación.
  const links = await page.evaluate(() => Object.fromEntries(
    [...document.querySelectorAll('link[rel]')].map(l => [l.getAttribute('rel') + (l.getAttribute('sizes') ? `:${l.getAttribute('sizes')}` : ''), l.getAttribute('href')])));
  expect(links['manifest']).toBe('/manifest.webmanifest');
  expect(links['apple-touch-icon']).toBe('/apple-touch-icon.png');
  expect(links['icon:32x32']).toBe('/favicon-32.png');

  const res = await page.request.get('/manifest.webmanifest');
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('manifest+json');
  const manifest = await res.json() as { icons: { src: string; sizes: string; purpose?: string }[] };
  expect(manifest.icons.map(i => `${i.sizes}:${i.purpose}`)).toEqual(['192x192:any', '512x512:any', '192x192:maskable', '512x512:maskable']);
  for (const icon of manifest.icons) {
    const r = await page.request.get(icon.src);
    expect(r.status(), icon.src).toBe(200);
    expect(r.headers()['content-type'], icon.src).toContain('image/png');
  }
  for (const f of ['/favicon.ico', '/apple-touch-icon.png', '/favicon-32.png']) {
    expect((await page.request.get(f)).status(), f).toBe(200);
  }

  // Dentro de la app, el logo aparece también en la barra superior.
  await login(page);
  const brand = page.locator('.brand-logo');
  await expect(brand).toBeVisible();
  expect(await brand.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
});

test('centro de mando: clientes de AINova, KPIs y búsqueda', async ({ page }) => {
  await login(page);
  const clients = page.getByTestId('panel-clientes');
  await expect(clients.getByText('Laura Méndez')).toBeVisible();
  await expect(clients.getByText('Pedro Ruiz')).toBeVisible();
  await expect(clients.getByText('450,00 USD')).toBeVisible();
  await clients.getByLabel('Buscar cliente').fill('pedro');
  await expect(clients.getByText('Laura Méndez')).toBeHidden();
  await expect(clients.getByText('Pedro Ruiz')).toBeVisible();
  await clients.getByRole('button', { name: 'Actualizar clientes' }).click();
  await expect(clients.getByText('Pedro Ruiz')).toBeVisible();
  await expect(page.getByTestId('core')).toHaveAttribute('data-state', 'reposo');
  await expect(page.getByTestId('panel-notion')).toContainText('Aún no hay notas');
});

test('Drive: «falta conectar» → conectar con Google (permiso solo de Drive) → archivos principales', async ({ page }) => {
  await login(page);
  const drive = page.getByTestId('panel-drive');
  await expect(drive).toContainText('Falta conectar');
  const [req] = await Promise.all([
    page.waitForRequest(r => r.url().includes('/google/auth')),
    drive.getByRole('link', { name: 'Conectar con Google' }).click()
  ]);
  const scope = new URL(req.url()).searchParams.get('scope')!;
  expect(scope).toContain('drive.metadata.readonly');
  expect(scope).not.toContain('gmail');
  await expect(page.getByRole('status').filter({ hasText: 'Conectado: google-drive' })).toBeVisible();
  await expect(drive.getByRole('link', { name: 'Plan comercial 2026' })).toHaveAttribute('href', 'https://docs.google.com/document/d/f1');
  await expect(drive.getByText('★ Doc')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/centro-de-mando.png`, fullPage: true });
});

test('chat: delega en Negocios y responde con datos reales de AINova', async ({ page }) => {
  await login(page);
  await sendChat(page, '¿Qué clientes tengo?');
  await expect(chat(page).getByTestId('msg-user').last()).toContainText('¿Qué clientes tengo?');
  await expect(lastAssistant(page)).toContainText('Laura Méndez');
});

test('tarjeta de confirmación: cancelar no cambia nada; confirmar ejecuta en AINova', async ({ page }) => {
  await login(page);
  await sendChat(page, 'Marca como pagado el cobro de Café Brisa');
  const card = chat(page).getByTestId('action-card').last();
  await expect(card).toContainText('Requiere tu confirmación');
  await expect(card).toContainText('mark payment paid');
  await card.getByRole('button', { name: 'Cancelar' }).click();
  await expect(card).toHaveAttribute('data-status', 'cancelled');
  await expect(page.getByTestId('panel-clientes').getByText('450,00 USD')).toBeVisible();

  await sendChat(page, 'Marca como pagado el cobro de Café Brisa');
  const card2 = chat(page).getByTestId('action-card').last();
  await expect(card2).toHaveAttribute('data-status', 'pending');
  await card2.getByText(/Detalles/).click();
  await expect(card2.locator('pre')).toContainText('paymentId');
  await card2.getByRole('button', { name: 'Confirmar' }).click();
  await expect(card2).toHaveAttribute('data-status', 'done');
  await expect(page.getByTestId('panel-clientes').getByText('0,00 USD').first()).toBeVisible();
});

test('Notion: «anota…» se guarda solo, aparece en el panel y se puede deshacer', async ({ page }) => {
  await login(page);
  await sendChat(page, 'Anota que el proveedor sube precios en enero');
  const card = chat(page).getByTestId('action-card').last();
  await expect(card).toContainText('Hecho automáticamente');
  await expect(card).toContainText('Guardar nota en Notion');
  const notion = page.getByTestId('panel-notion');
  await expect(notion.getByText(/Nota del usuario/)).toBeVisible();
  await card.getByRole('button', { name: 'Deshacer' }).click();
  await expect(card).toHaveAttribute('data-status', 'undone');
  await notion.getByRole('button', { name: 'Actualizar Notion' }).click();
  await expect(notion.getByText(/Nota del usuario/)).toBeHidden();
});

test('trabajo en segundo plano: aparece en Trabajos y su resultado llega al chat', async ({ page }) => {
  await login(page);
  await sendChat(page, 'Haz un reporte de cobros de noviembre');
  await expect(lastAssistant(page)).toBeVisible();
  const jobs = page.getByTestId('panel-trabajos');
  await expect(jobs.getByText('Crea un reporte de cobros')).toBeVisible();
  await expect(jobs.locator('.badge').first()).toHaveText(/hecho/, { timeout: 20_000 });
  await expect(chat(page).getByText(/Trabajo terminado/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('panel-notion').getByText(/Cobros de noviembre/)).toBeVisible();
});

test('voz: pulsar para hablar (micrófono falso), transcribe y envía; lectura en voz alta pide audio WAV', async ({ page }) => {
  await login(page);
  await page.getByText('Leer respuestas en voz alta').click();
  await page.getByRole('button', { name: 'Hablar con Nyvo' }).click();
  await expect(page.getByTestId('core')).toHaveAttribute('data-state', 'escuchando');
  await page.waitForTimeout(800);
  const tts = page.waitForResponse(r => r.url().endsWith('/api/voice/tts'));
  await page.getByRole('button', { name: 'Detener grabación' }).click();
  await expect(chat(page).getByTestId('msg-user').last()).toContainText('muéstrame mis clientes');
  await expect(lastAssistant(page)).toContainText('Laura Méndez');
  const res = await tts;
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toBe('audio/wav');
});

test('palabra clave: ignora «oye nuevo» y responde a «Oye Nyvo» tras 2 s de confirmación', async ({ page }) => {
  await page.addInitScript(() => {
    class FakeSR {
      lang = ''; continuous = false; interimResults = false;
      onresult: ((e: unknown) => void) | null = null; onend: (() => void) | null = null; onerror: ((e: unknown) => void) | null = null;
      static started = 0;
      start() {
        if (FakeSR.started++) return;
        const say = (t: string, ms: number) => setTimeout(() => this.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript: t }], { isFinal: true })] }), ms);
        say('oye nuevo, ¿viste eso?', 200);
        say('Oye Nyvo, qué clientes tengo', 700);
      }
      stop() {}
      abort() {}
    }
    Object.assign(window, { SpeechRecognition: FakeSR, webkitSpeechRecognition: FakeSR });
  });
  await login(page);
  await page.getByText('Palabra clave «Oye Nyvo»').click();
  const dialog = page.getByRole('dialog', { name: 'Palabra clave detectada' });
  await expect(dialog).toContainText('Voy a enviar: «que clientes tengo»');
  await expect(dialog).toBeHidden({ timeout: 5000 });
  await expect(lastAssistant(page)).toContainText('Laura Méndez');
  await expect(chat(page).getByTestId('msg-user').filter({ hasText: 'nuevo' })).toHaveCount(0);
});

test('palabra clave: se puede cancelar durante la confirmación', async ({ page }) => {
  await page.addInitScript(() => {
    class FakeSR {
      onresult: ((e: unknown) => void) | null = null; onend: (() => void) | null = null; onerror: ((e: unknown) => void) | null = null;
      lang = ''; continuous = false; interimResults = false;
      start() { setTimeout(() => this.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript: 'oye nyvo borra todo' }], { isFinal: true })] }), 200); }
      stop() {}
      abort() { this.onresult = null; }
    }
    Object.assign(window, { SpeechRecognition: FakeSR, webkitSpeechRecognition: FakeSR });
  });
  await login(page);
  const before = await chat(page).getByTestId('msg-user').count();
  await page.getByText('Palabra clave «Oye Nyvo»').click();
  const dialog = page.getByRole('dialog', { name: 'Palabra clave detectada' });
  await dialog.getByRole('button', { name: 'Cancelar' }).click();
  await expect(dialog).toBeHidden();
  await page.waitForTimeout(2500);
  await expect(chat(page).getByTestId('msg-user')).toHaveCount(before);
});

test('conversaciones: se listan y se pueden reabrir; «Nueva» limpia el chat', async ({ page }) => {
  await login(page);
  const select = page.getByLabel('Elegir conversación');
  // La lista llega después de pintar el chat: se espera con reintentos en vez de contar una sola vez.
  await expect.poll(() => select.locator('option').count()).toBeGreaterThan(2);
  await select.selectOption({ index: 1 });
  await expect(chat(page).getByTestId('msg-user').first()).toBeVisible();
  await chat(page).getByRole('button', { name: 'Nueva' }).click();
  await expect(page.getByTestId('chat-empty')).toBeVisible();
});

test('conectores: estados, variables y ajuste de Notion', async ({ page }) => {
  await login(page);
  await page.getByRole('tab', { name: 'Conectores' }).click();
  await expect(page.getByRole('heading', { name: 'Conectores', level: 1 })).toBeVisible();
  for (const id of ['ainova', 'notion', 'google-drive', 'memoria', 'gemini', 'voz']) {
    await expect(page.getByTestId(`conector-${id}`)).toContainText('Listo');
  }
  const notion = page.getByTestId('conector-notion');
  await expect(notion.getByText('✓ NOTION_TOKEN')).toBeVisible();
  await notion.getByText('Guardar notas y reportes sin preguntar').click();
  await expect(page.getByRole('status').filter({ hasText: 'Ajuste guardado' })).toBeVisible();
  await expect(notion.getByRole('checkbox', { name: /Guardar notas/ })).not.toBeChecked();
  await notion.getByText('Guardar notas y reportes sin preguntar').click();
  await expect(notion.getByRole('checkbox', { name: /Guardar notas/ })).toBeChecked();
  const ainova = page.getByTestId('conector-ainova');
  await ainova.getByText('Activo').click();
  await expect(ainova).toContainText('Desactivado');
  await page.getByRole('tab', { name: 'Centro de mando' }).click();
  await expect(page.getByTestId('panel-clientes')).toContainText('Conector desactivado');
  await page.getByRole('tab', { name: 'Conectores' }).click();
  await page.getByTestId('conector-ainova').getByText('Activo').click();
  await expect(page.getByTestId('conector-ainova')).toContainText('Listo');
  await page.screenshot({ path: `${SHOTS}/conectores.png`, fullPage: true });
});

test('memoria: añadir, borrar, estilo, exportar y borrar todo', async ({ page }) => {
  await login(page);
  await page.getByRole('tab', { name: 'Memoria' }).click();
  await page.getByLabel('Nueva nota').fill('Prefiero correos breves');
  await page.getByRole('button', { name: 'Añadir' }).click();
  await expect(page.getByText('Prefiero correos breves')).toBeVisible();
  await page.getByLabel('Cómo escribes').fill('Directo y cordial, tuteo');
  await page.getByRole('button', { name: 'Guardar estilo' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Estilo guardado' })).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Exportar memoria (JSON)' }).click()]);
  const data = JSON.parse(await readFile((await download.path())!, 'utf8')) as { notas: { content: string }[]; estilo: { description: string } };
  expect(data.notas[0]!.content).toBe('Prefiero correos breves');
  expect(data.estilo.description).toBe('Directo y cordial, tuteo');
  await page.getByRole('button', { name: 'Borrar nota: Prefiero correos breves' }).click();
  await expect(page.getByText('Prefiero correos breves')).toBeHidden();
  await page.getByLabel('Nueva nota').fill('Otra nota');
  await page.getByRole('button', { name: 'Añadir' }).click();
  await page.getByRole('button', { name: 'Borrar toda la memoria' }).click();
  await page.getByRole('button', { name: 'Sí, borrar todo' }).click();
  await expect(page.getByText('Sin notas.')).toBeVisible();
  await expect(page.getByLabel('Cómo escribes')).toHaveValue('');
});

test('salir cierra la sesión', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: 'Salir' }).click();
  await expect(page.getByLabel('Contraseña')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Contraseña')).toBeVisible();
});

test('sin conectores configurados: cada panel dice qué variable falta, sin errores', async ({ page }) => {
  const base = 'http://localhost:3101';
  await login(page, base);
  await expect(page.getByTestId('panel-clientes')).toContainText('Falta configurar');
  await expect(page.getByTestId('panel-clientes').getByText('AINOVA_API_KEY')).toBeVisible();
  await expect(page.getByTestId('panel-drive').getByText('GOOGLE_CLIENT_ID')).toBeVisible();
  await expect(page.getByTestId('panel-notion').getByText('NOTION_TOKEN')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Entrar con Google' })).toHaveCount(0);
  await expect(page.getByText(/Voz: falta configurar GEMINI_API_KEY/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Hablar con Nyvo' })).toBeDisabled();
  await sendChat(page, 'hola');
  await expect(lastAssistant(page)).toContainText('Falta configurar un motor de IA');
  await page.getByTestId('panel-clientes').getByRole('button', { name: 'Ver conectores →' }).click();
  await expect(page.getByTestId('conector-ainova')).toContainText('Falta configurar');
  await expect(page.getByTestId('conector-ainova').getByText('✗ AINOVA_API_URL')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/falta-configurar.png`, fullPage: true });
});

test('móvil: el HUD cabe sin desplazamiento horizontal @movil', async ({ page }) => {
  await login(page);
  await expect(page.getByTestId('panel-chat')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: `${SHOTS}/movil.png`, fullPage: true });
});

test('estados hover y foco: pestañas, botones y filas responden al puntero y al teclado', async ({ page }) => {
  await login(page);
  const bg = (loc: ReturnType<Page['locator']>) => loc.evaluate(el => getComputedStyle(el).backgroundColor);
  const tab = page.getByRole('tab', { name: 'Memoria' });
  const before = await bg(tab);
  await tab.hover();
  await expect.poll(() => bg(tab)).not.toBe(before);

  const row = page.getByTestId('panel-clientes').locator('li').first();
  const rowBefore = await bg(row);
  await row.hover();
  await expect.poll(() => bg(row)).not.toBe(rowBefore);

  // Botón: al pasar el puntero sube 1 px y con el teclado muestra el anillo de foco.
  const nueva = page.getByRole('button', { name: 'Nueva' });
  await nueva.hover();
  await expect.poll(() => nueva.evaluate(el => getComputedStyle(el).transform)).not.toBe('none');
  await page.mouse.move(0, 0);
  await nueva.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(nueva).toBeFocused();
  expect(await nueva.evaluate(el => getComputedStyle(el).boxShadow)).not.toBe('none');
});
