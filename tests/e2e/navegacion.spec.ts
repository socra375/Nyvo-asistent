import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const OWNER = 'ianovasystem3@gmail.com';
const PASSWORD = 'clave-e2e-segura-123';
const SHOTS = 'test-results/capturas';
mkdirSync(SHOTS, { recursive: true });

async function loginOrb(page: Page, base = '') {
  await page.goto(`${base}/`);
  await page.getByLabel('Correo').fill(OWNER);
  await page.getByLabel('Contraseña').fill(PASSWORD);
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page.getByTestId('orbscreen')).toBeVisible();
}

/** Botón de la barra; en móvil abre antes el menú desplegable si está cerrado. */
async function nav(page: Page, name: string) {
  const menu = page.getByRole('button', { name: 'Menú', exact: true });
  if ((await menu.isVisible()) && (await menu.getAttribute('aria-expanded')) !== 'true') await menu.click();
  return page.getByRole('navigation', { name: 'Tarjetas' }).getByRole('button', { name, exact: true });
}
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

const GRUPOS: Record<string, string[]> = {
  Centro: ['Vista principal', 'Actividad'],
  Negocios: ['Clientes', 'Trabajos', 'Conversación'],
  Conocimiento: ['Archivos', 'Notion', 'Memoria'],
  Sistemas: ['Conectores', 'Voces']
};
const TARJETAS: [string, string][] = [
  ['Clientes', 'clientes'], ['Trabajos', 'trabajos'], ['Conversación', 'conversacion'], ['Archivos', 'archivos'],
  ['Notion', 'notion'], ['Memoria', 'memoria'], ['Conectores', 'conectores'], ['Voces', 'voces'], ['Actividad', 'actividad']
];

test('barra lateral: cuatro grupos con sus botones, sección activa y colapsar', async ({ page }) => {
  await loginOrb(page);
  const side = page.getByRole('navigation', { name: 'Tarjetas' });
  for (const [grupo, botones] of Object.entries(GRUPOS)) {
    const g = side.getByRole('group', { name: grupo, exact: true });
    await expect(g).toBeVisible();
    for (const b of botones) await expect(g.getByRole('button', { name: b, exact: true })).toBeVisible();
  }
  await expect(page.getByTestId('grupo-centro').getByRole('button', { name: 'Vista principal' })).toHaveAttribute('aria-current', 'page');
  await (await nav(page, 'Clientes')).click();
  await expect(await nav(page, 'Clientes')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Vista principal' })).not.toHaveAttribute('aria-current', 'page');
  await page.getByRole('button', { name: 'Vista principal' }).click();
  await expect(page.getByTestId('win-clientes')).toHaveCount(0);
  // Colapsar: los botones siguen ahí (con su nombre) pero la barra se estrecha.
  const w = async () => (await page.getByTestId('sidebar').boundingBox())!.width;
  const ancha = await w();
  await page.getByRole('button', { name: 'Contraer barra lateral' }).click();
  await expect(page.getByTestId('orbscreen')).toHaveAttribute('data-side', 'colapsada');
  await expect.poll(w).toBeLessThan(ancha - 80);
  await expect(side.getByRole('button', { name: 'Clientes', exact: true })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/nav-colapsada.png` });
  await page.getByRole('button', { name: 'Expandir barra lateral' }).click();
  await expect(page.getByTestId('orbscreen')).toHaveAttribute('data-side', 'expandida');
});

test('cada tarjeta se abre desde la barra y se cierra con ✕', async ({ page }) => {
  await loginOrb(page);
  for (const [label, id] of TARJETAS) {
    await (await nav(page, label)).click();
    await expect(page.getByTestId(`win-${id}`), `abre ${label}`).toBeVisible();
    await expect(await nav(page, label)).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: `Cerrar ${label}` }).click();
    await expect(page.getByTestId(`win-${id}`), `cierra ${label}`).toHaveCount(0);
    await expect(await nav(page, label)).toHaveAttribute('aria-pressed', 'false');
  }
});

test('especialistas: la tarjeta muestra el estado real y no ejecuta nada externo', async ({ page }) => {
  const mutaciones: string[] = [];
  await loginOrb(page);
  page.on('request', r => { if (r.url().includes('/api/') && r.method() !== 'GET') mutaciones.push(`${r.method()} ${r.url()}`); });
  await page.getByTestId('sec-rose').click();
  const rose = page.getByTestId('spec-rose');
  await expect(rose).toContainText('Rose');
  await expect(rose).toContainText('Mensajes');
  await expect(page.getByTestId('spec-rose-estado')).toHaveText('Disponible');
  await page.getByTestId('sec-johan').click();   // cambia de especialista
  await expect(page.getByTestId('spec-rose')).toHaveCount(0);
  await expect(page.getByTestId('spec-johan')).toContainText('Clientes y cobros');
  await expect(page.getByTestId('spec-johan-estado')).toHaveText('Disponible');
  await page.getByTestId('sec-mia').click();
  await expect(page.getByTestId('spec-mia')).toContainText('NO está conectada');
  await expect(page.getByTestId('spec-mia-estado')).toHaveText('Sin conectar');
  await page.getByTestId('sec-nyvo').click();
  await expect(page.getByTestId('spec-nyvo')).toContainText('Notion');
  await expect(page.getByTestId('spec-nyvo')).toContainText('Drive');
  await expect(page.getByTestId('spec-nyvo-estado')).toHaveText('Disponible');
  await page.getByRole('button', { name: 'Cerrar Nyvo' }).click();
  await expect(page.getByTestId('spec-nyvo')).toHaveCount(0);
  await page.getByTestId('sec-rose').click();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('spec-rose')).toHaveCount(0);
  await expect(page.getByTestId('orb')).toHaveAttribute('data-state', 'reposo');   // no inició ninguna conversación
  expect(mutaciones).toEqual([]);
});

test('especialistas: sin conectores configurados dicen «No configurado» (Mia sigue sin agenda)', async ({ page }) => {
  await loginOrb(page, 'http://localhost:3101');
  for (const s of ['rose', 'johan', 'nyvo']) {
    await page.getByTestId(`sec-${s}`).click();
    await expect(page.getByTestId(`spec-${s}-estado`)).toHaveText('No configurado');
  }
  await page.getByTestId('sec-mia').click();
  await expect(page.getByTestId('spec-mia-estado')).toHaveText('Sin conectar');
});

test('móvil: menú desplegable accesible y sin desplazamiento horizontal @movil', async ({ page }) => {
  await loginOrb(page);
  const menu = page.getByRole('button', { name: 'Menú', exact: true });
  await expect(menu).toBeVisible();
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('button', { name: 'Clientes', exact: true })).toBeHidden();
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await menu.click();
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
  for (const grupo of Object.keys(GRUPOS)) await expect(page.getByRole('group', { name: grupo, exact: true })).toBeVisible();
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  const caja = await page.getByRole('navigation', { name: 'Tarjetas' }).boundingBox();
  expect(caja!.x + caja!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.screenshot({ path: `${SHOTS}/nav-movil-menu.png` });
  await page.getByRole('button', { name: 'Clientes', exact: true }).click();
  await expect(page.getByTestId('win-clientes')).toBeVisible();
  await expect(menu).toHaveAttribute('aria-expanded', 'false');   // se cierra al elegir
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await page.getByRole('button', { name: 'Cerrar Clientes' }).click();
  await page.getByTestId('sec-mia').click();
  await expect(page.getByTestId('spec-mia')).toBeVisible();
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  const spec = await page.getByTestId('spec-mia').boundingBox();
  expect(spec!.x).toBeGreaterThanOrEqual(0);
  expect(spec!.x + spec!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.screenshot({ path: `${SHOTS}/especialista-movil.png` });
});

test.describe('capturas a doble resolución', () => {
  test.use({ deviceScaleFactor: 2 });
  test('escritorio: barra lateral y tarjeta de especialista', async ({ page }) => {
    await loginOrb(page);
    await (await nav(page, 'Notion')).click();
    await expect(page.getByTestId('win-notion')).toBeVisible();
    await page.getByTestId('sec-johan').click();
    await expect(page.getByTestId('spec-johan')).toBeVisible();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SHOTS}/nav-escritorio@2x.png` });
  });
  test('móvil: orbe con menú y tarjeta @movil', async ({ page }) => {
    await loginOrb(page);
    await page.getByTestId('sec-rose').click();
    await expect(page.getByTestId('spec-rose')).toBeVisible();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SHOTS}/nav-movil@2x.png` });
  });
});

test('móvil: Escape con el menú abierto cierra solo el menú y no las tarjetas @movil', async ({ page }) => {
  await loginOrb(page);
  const menu = page.getByRole('button', { name: 'Menú', exact: true });
  await menu.click();
  await page.getByRole('button', { name: 'Clientes', exact: true }).click();
  await expect(page.getByTestId('win-clientes')).toBeVisible();
  await menu.click();
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('win-clientes')).toBeVisible();   // la tarjeta sigue abierta
  await page.keyboard.press('Escape');                              // con el menú cerrado, cierra la tarjeta
  await expect(page.getByTestId('win-clientes')).toHaveCount(0);
});
