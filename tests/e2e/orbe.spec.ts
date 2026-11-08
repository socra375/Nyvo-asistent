import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const OWNER = 'ianovasystem3@gmail.com';
const PASSWORD = 'clave-e2e-segura-123';
const SHOTS = 'test-results/capturas';
mkdirSync(SHOTS, { recursive: true });

async function loginOrb(page: Page) {
  await page.goto('/');
  await page.getByLabel('Correo').fill(OWNER);
  await page.getByLabel('Contraseña').fill(PASSWORD);
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page.getByTestId('orbscreen')).toBeVisible();
}

/** Píxeles con color en el canvas: demuestra que el orbe se dibuja de verdad y con los colores de cada sección. */
const paintedPixels = (page: Page) => page.getByTestId('orb-canvas').evaluate((c: HTMLCanvasElement) => {
  const g = c.getContext('2d')!;
  const d = g.getImageData(0, 0, c.width, c.height).data;
  let n = 0, orange = 0, blue = 0, pink = 0;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i]!, gr = d[i + 1]!, b = d[i + 2]!;
    if (d[i + 3]! < 60) continue;
    n++;
    if (r > 150 && gr > 90 && gr < 190 && b < 130) orange++;
    else if (b > 140 && b > r + 40) blue++;
    else if (r > 150 && b > 90 && gr < 130) pink++;
  }
  return { n, orange, blue, pink, total: d.length / 4 };
});

test('orbe: es la pantalla principal, con cuatro secciones, grafo de red y en movimiento', async ({ page }) => {
  await loginOrb(page);
  await expect(page.getByTestId('orb')).toHaveAttribute('data-state', 'reposo');
  for (const s of ['rose', 'johan', 'mia', 'nyvo']) await expect(page.getByTestId(`sec-${s}`)).toBeVisible();
  await expect(page.getByTestId('sec-rose')).toContainText('Rose');
  await expect(page.getByTestId('sec-mia')).toContainText('Mia');
  // Solo el orbe: no hay paneles ni barra superior en esta pantalla.
  await expect(page.getByTestId('panel-chat')).toHaveCount(0);
  await expect(page.getByRole('tablist')).toHaveCount(0);

  const px = await paintedPixels(page);
  expect(px.n).toBeGreaterThan(8000);
  // Los tres clústeres grandes se ven con su color: naranja (Johan), azul (Mia) y rosa (Rose).
  expect(px.orange).toBeGreaterThan(150);
  expect(px.blue).toBeGreaterThan(100);
  expect(px.pink).toBeGreaterThan(60);

  // Movimiento: la fase avanza y los fotogramas cambian.
  const yaw = () => page.getByTestId('orb-canvas').getAttribute('data-yaw').then(Number);
  const a = await yaw();
  const shotA = await page.getByTestId('orb-canvas').screenshot();
  await page.waitForTimeout(700);
  expect(await yaw()).toBeGreaterThan(a + 0.05);
  // Giro continuo en un solo sentido (nunca vuelve atrás): tres lecturas seguidas, siempre mayores.
  const y1 = await yaw(); await page.waitForTimeout(400); const y2 = await yaw(); await page.waitForTimeout(400); const y3 = await yaw();
  expect(y2).toBeGreaterThan(y1); expect(y3).toBeGreaterThan(y2);
  expect((await page.getByTestId('orb-canvas').screenshot()).equals(shotA)).toBe(false);
  await page.screenshot({ path: `${SHOTS}/orbe.png` });
});

test('orbe: teclado → piensa, se enciende la sección que trabaja y llegan subtítulos; panel y vuelta', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __modes: string[] };
    w.__modes = [];
    const watch = () => {
      const el = document.querySelector('[data-testid="sec-johan"]');
      if (!el) return setTimeout(watch, 50);
      new MutationObserver(() => w.__modes.push(el.getAttribute('data-mode') ?? '')).observe(el, { attributes: true, attributeFilter: ['data-mode'] });
    };
    watch();
  });
  await loginOrb(page);
  await page.getByRole('button', { name: 'Voz', exact: true }).click();   // sin voz: solo texto
  await expect(page.getByRole('button', { name: 'Voz', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: 'Teclado' }).click();
  await page.getByLabel('Mensaje para Nyvo').fill('¿Qué clientes tengo?');
  await page.getByRole('button', { name: 'Enviar' }).click();
  await expect(page.getByTestId('captions')).toContainText('Laura Méndez', { timeout: 15_000 });
  await expect(page.getByTestId('captions')).toContainText('¿Qué clientes tengo?');
  // Johan (CRM) trabajó: pasó por «activo» y quedó «listo» antes de apagarse.
  const modes = () => page.evaluate(() => (window as unknown as { __modes: string[] }).__modes);
  expect(await modes()).toContain('activo');
  await expect.poll(modes, { timeout: 4000 }).toContain('listo');
  await expect(page.getByTestId('sec-johan')).toHaveAttribute('data-mode', 'reposo', { timeout: 6000 });
  // Con la voz apagada, lo escrito no se lee en voz alta.
  await expect(page.getByTestId('orb')).toHaveAttribute('data-state', 'reposo');

  await page.getByRole('button', { name: 'Subtítulos' }).click();
  await expect(page.getByTestId('captions')).toHaveCount(0);

  await page.getByRole('button', { name: 'Panel', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Centro de mando' })).toBeVisible();
  await expect(page.getByTestId('panel-chat')).toBeVisible();
  await page.getByRole('tab', { name: 'Orbe' }).click();
  await expect(page.getByTestId('orbscreen')).toBeVisible();
});

test('orbe: lo que se pide por teclado también se lee en voz alta (voz activada por defecto), sin nombrar las partes internas', async ({ page }) => {
  await loginOrb(page);
  await expect(page.getByRole('button', { name: 'Voz', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const tts = page.waitForRequest(r => r.url().endsWith('/api/voice/tts'));
  await page.getByRole('button', { name: 'Teclado' }).click();
  await page.getByLabel('Mensaje para Nyvo').fill('¿Qué clientes tengo?');
  await page.getByRole('button', { name: 'Enviar' }).click();
  await tts;                                                     // pidió la voz de la respuesta
  await expect(page.getByTestId('orb')).toHaveAttribute('data-state', 'hablando', { timeout: 15_000 });
  await expect(page.getByTestId('captions')).toContainText('Laura Méndez');
  await expect(page.getByTestId('captions')).not.toContainText(/Johan|Rose|Mia\b/);   // sin nombrar las partes internas
  // «Callar» corta la voz y el orbe vuelve al reposo
  await page.getByRole('button', { name: 'Callar' }).click();
  await expect(page.getByTestId('orb')).toHaveAttribute('data-state', 'reposo');
  // Se recuerda la preferencia
  await page.getByRole('button', { name: 'Voz', exact: true }).click();
  await page.reload();
  await expect(page.getByTestId('orbscreen')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Voz', exact: true })).toHaveAttribute('aria-pressed', 'false');
});

test('orbe: una acción que cambia datos sale como tarjeta sobre el orbe y no se ejecuta sin confirmar', async ({ page }) => {
  await loginOrb(page);
  await page.getByRole('button', { name: 'Voz', exact: true }).click();   // sin voz: la prueba es de la tarjeta
  await page.getByRole('button', { name: 'Teclado' }).click();
  await page.getByLabel('Mensaje para Nyvo').fill('Marca como pagado el cobro');
  await page.getByRole('button', { name: 'Enviar' }).click();
  const card = page.getByTestId('action-card').first();
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card).toHaveAttribute('data-status', 'pending');
  await expect(page.getByTestId('captions')).toContainText('tarjeta');
  await page.screenshot({ path: `${SHOTS}/orbe-tarjeta.png` });
  await card.getByRole('button', { name: 'Confirmar' }).click();
  await expect(page.getByTestId('action-card')).toHaveCount(0);   // confirmada: sale de las pendientes
});

test('orbe por voz: escucha, transcribe, responde en voz y se deja interrumpir @voz', async ({ page }) => {
  test.setTimeout(75_000);
  await page.addInitScript(() => {
    const w = window as unknown as { __states: [string, number][]; __tts: number };
    w.__states = []; w.__tts = 0;
    const origFetch = window.fetch.bind(window);
    window.fetch = (...a: Parameters<typeof fetch>) => { if (String(a[0]).endsWith('/api/voice/tts')) w.__tts++; return origFetch(...a); };
    const watch = () => {
      const el = document.querySelector('[data-testid="orb"]');
      if (!el) return setTimeout(watch, 30);
      w.__states.push([el.getAttribute('data-state') ?? '', performance.now()]);
      new MutationObserver(() => w.__states.push([el.getAttribute('data-state') ?? '', performance.now()])).observe(el, { attributes: true, attributeFilter: ['data-state'] });
    };
    watch();
  });
  await loginOrb(page);
  await page.getByRole('button', { name: 'Hablar con Nyvo' }).click();   // abre el micrófono (el WAV falso empieza a sonar)
  await expect(page.getByTestId('orb')).toHaveAttribute('data-state', 'escuchando');
  await expect(page.getByRole('button', { name: 'Detener la conversación por voz' })).toBeVisible();
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${SHOTS}/orbe-escuchando.png` });

  // Frase 1 → transcripción → respuesta con datos reales → Nyvo habla.
  await expect(page.getByTestId('orb')).toHaveAttribute('data-state', 'hablando', { timeout: 20_000 });
  await expect(page.getByTestId('captions')).toContainText('muéstrame mis clientes');
  await expect(page.getByTestId('captions')).toContainText('Laura Méndez');
  await page.screenshot({ path: `${SHOTS}/orbe-hablando.png` });

  // Frase 2 cae encima de su voz (que dura 10 s): la corta y vuelve a escuchar → piensa → habla otra vez.
  await expect.poll(async () => {
    const st = await page.evaluate(() => (window as unknown as { __states: [string, number][] }).__states);
    const seq = st.map(s => s[0]).join('>');
    return /escuchando>pensando>hablando>escuchando>pensando>hablando/.test(seq.replace(/(\w+)(>\1)+/g, '$1'));
  }, { timeout: 40_000, intervals: [300] }).toBe(true);

  const st = await page.evaluate(() => (window as unknown as { __states: [string, number][] }).__states);
  const firstSpeak = st.find(s => s[0] === 'hablando')![1];
  const cut = st.slice(st.findIndex(s => s[0] === 'hablando') + 1).find(s => s[0] === 'escuchando')![1];
  expect(cut - firstSpeak).toBeLessThan(6000);   // se cortó mucho antes de que acabaran sus 10 s
  expect(await page.evaluate(() => (window as unknown as { __tts: number }).__tts)).toBeGreaterThanOrEqual(2);

  // Detener: cierra el micrófono y vuelve al reposo.
  await page.getByRole('button', { name: 'Detener la conversación por voz' }).click();
  await expect(page.getByTestId('orb')).toHaveAttribute('data-state', 'reposo');
  await expect(page.getByRole('button', { name: 'Hablar con Nyvo' })).toBeVisible();
});

test('orbe en móvil: cabe sin desplazamiento y las cuatro secciones se ven @movil', async ({ page }) => {
  await loginOrb(page);
  for (const s of ['rose', 'johan', 'mia', 'nyvo']) await expect(page.getByTestId(`sec-${s}`)).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const box = await page.getByTestId('orb').boundingBox();
  const vp = page.viewportSize()!;
  expect(box!.width).toBeLessThanOrEqual(vp.width);
  expect((await paintedPixels(page)).n).toBeGreaterThan(3000);
  await page.screenshot({ path: `${SHOTS}/orbe-movil.png` });
});
