import { test } from 'node:test';
import assert from 'node:assert/strict';
import { specialistStatus } from '../../web/src/orb/specialists.js';

test('estado del especialista: el de su sección, y «No configurado» solo si falta configurar su conector', () => {
  assert.equal(specialistStatus('rose', 'reposo', null), 'Disponible');
  assert.equal(specialistStatus('rose', 'activo', { ainova: 'listo' }), 'Trabajando');
  assert.equal(specialistStatus('johan', 'listo', { ainova: 'listo' }), 'Listo');
  assert.equal(specialistStatus('johan', 'reposo', { ainova: 'falta_configurar' }), 'No configurado');
  assert.equal(specialistStatus('rose', 'reposo', { ainova: 'falta_conectar' }), 'Disponible');
  // Nyvo: Notion y Drive; solo si faltan ambos.
  assert.equal(specialistStatus('nyvo', 'reposo', { notion: 'falta_configurar', 'google-drive': 'listo' }), 'Disponible');
  assert.equal(specialistStatus('nyvo', 'reposo', { notion: 'falta_configurar', 'google-drive': 'falta_configurar' }), 'No configurado');
  // Mia no tiene conector: nunca «No configurado».
  assert.equal(specialistStatus('mia', 'reposo', { ainova: 'falta_configurar' }), 'Disponible');
});
