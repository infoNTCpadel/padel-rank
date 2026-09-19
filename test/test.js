'use strict';
// Tests de club-padel: unitarios + integración HTTP contra servidor real.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const elo = require('../src/lib/elo');
const rules = require('../src/lib/rules');

let passed = 0;
function ok(name, fn) {
  try { fn(); passed++; console.log('  ✓', name); }
  catch (e) { console.error('  ✗', name, '\n   ', e.message); process.exitCode = 1; }
}
function okAsync(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { passed++; console.log('  ✓', name); },
    e => { console.error('  ✗', name, '\n   ', e.message); process.exitCode = 1; });
}

// ---------- Unitarios ----------
console.log('Unitarios: ELO/niveles');
ok('18 niveles: 1800 (1) a 0 (18)', () => {
  assert.equal(elo.pointsForLevel(1), 1800);
  assert.equal(elo.pointsForLevel(18), 0);
  assert.equal(elo.levelForPoints(1800), 1);
  assert.equal(elo.levelForPoints(0), 18);
  assert.equal(elo.levelForPoints(1150), 7);
});
ok('categorías y etiquetas', () => {
  assert.equal(elo.categoryForLevel(2).name, 'Radical PRO');
  assert.equal(elo.categoryForLevel(8).name, 'Medio+');
  assert.equal(elo.categoryForLevel(17).name, 'Básico');
  assert.equal(elo.levelLabel(7), 'Medio+ alto');
  assert.equal(elo.levelLabel(18), 'Básico bajo');
});
ok('nivel inicial máximo = Medio+ (índice 7)', () => {
  assert.equal(elo.MAX_INITIAL_LEVEL, 7);
  assert.ok(elo.initialLevelOptions().every(o => o.index >= 7));
  assert.equal(elo.initialLevelOptions().length, 12);
});
ok('ELO: el favorito gana menos que la sorpresa', () => {
  const fav = elo.updateRatings([{ id: 1, points: 1500 }, { id: 2, points: 1500 }], [{ id: 3, points: 900 }, { id: 4, points: 900 }], 1);
  const upset = elo.updateRatings([{ id: 1, points: 900 }, { id: 2, points: 900 }], [{ id: 3, points: 1500 }, { id: 4, points: 1500 }], 1);
  assert.ok(fav[0].delta > 0 && fav[0].delta < upset[0].delta, `fav=${fav[0].delta} upset=${upset[0].delta}`);
  assert.ok(fav[2].delta < 0);
});
ok('ELO: empate no mueve puntos (normativa)', () => {
  const r = elo.updateRatings([{ id: 1, points: 1200 }, { id: 2, points: 1200 }], [{ id: 3, points: 800 }, { id: 4, points: 800 }], 0.5);
  assert.ok(r.every(x => x.delta === 0));
});
ok('ELO: puntos acotados 0..1800', () => {
  const r = elo.updateRatings([{ id: 1, points: 1795 }, { id: 2, points: 1795 }], [{ id: 3, points: 100 }, { id: 4, points: 100 }], 1);
  assert.ok(r[0].newPoints <= 1800);
  const r2 = elo.updateRatings([{ id: 1, points: 5 }, { id: 2, points: 5 }], [{ id: 3, points: 1700 }, { id: 4, points: 1700 }], 0);
  assert.ok(r2[0].newPoints >= 0);
});

console.log('Unitarios: reglas');
ok('edad mínima 14', () => {
  const today = new Date();
  const just14 = new Date(today); just14.setFullYear(just14.getFullYear() - 14);
  const almost14 = new Date(just14); almost14.setDate(almost14.getDate() + 1);
  const iso = d => d.toISOString().slice(0, 10);
  assert.ok(rules.ageOn(iso(just14)) >= 14);
  assert.ok(rules.ageOn(iso(almost14)) < 14);
});
ok('validación de sets', () => {
  assert.deepEqual(rules.validateSet(6, 4, false), { valid: true, winner: 'A' });
  assert.deepEqual(rules.validateSet(4, 6, false), { valid: true, winner: 'B' });
  assert.deepEqual(rules.validateSet(7, 5, false), { valid: true, winner: 'A' });
  assert.equal(rules.validateSet(6, 6, false).valid, false);
  assert.deepEqual(rules.validateSet(7, 6, true), { valid: true, winner: 'A' });
  assert.equal(rules.validateSet(6, 5, false).valid, false);
});
ok('ventana de resultados: día del partido + siguiente', () => {
  const p = n => String(n).padStart(2, '0');
  const now = new Date();
  const recent = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}T12:00`;
  const old = new Date(now.getTime() - 5 * 864e5);
  const oldS = `${old.getFullYear()}-${p(old.getMonth() + 1)}-${p(old.getDate())}T12:00`;
  assert.equal(rules.canRegisterResult({ starts_at: recent, status: 'full' }), true);
  assert.equal(rules.canRegisterResult({ starts_at: oldS, status: 'full' }), false);
});
ok('sorteo: mixto 2M+2F y ranking', () => {
  const ps = [
    { id: 1, name: 'A', gender: 'M', points: 1200 }, { id: 2, name: 'B', gender: 'M', points: 1100 },
    { id: 3, name: 'C', gender: 'F', points: 1000 }, { id: 4, name: 'D', gender: 'F', points: 900 },
  ];
  const s = rules.suggestPairs(ps);
  assert.equal(s.mode, 'mixed');
  for (const pr of s.pairs) assert.ok(pr[0].gender !== pr[1].gender);
  const s2 = rules.suggestPairs(ps.map(p => ({ ...p, gender: 'M' })));
  assert.equal(s2.mode, 'ranked');
  assert.equal(s2.bestId, 1); assert.equal(s2.worstId, 4);
});

// ---------- Integración HTTP ----------
console.log('Integración: arranque del servidor');
// Reloj fake: hoy a las 09:00. Todos los partidos se programan desde esa base,
// así los tests son deterministas (ventana de resultados, bajas, etc.).
const fakeBase = new Date(); fakeBase.setHours(9, 0, 0, 0);
const PORT = 4123;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'clubpadel-'));
const child = spawn('node', [path.join(__dirname, '..', 'src', 'index.js')], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR, FAKE_NOW: fakeBase.toISOString(), ADMIN_EMAIL: 'admin@club.test', ADMIN_PASSWORD: 'admin123' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stderr.on('data', d => process.stderr.write('[srv] ' + d));
const BASE = `http://127.0.0.1:${PORT}`;

function localDT(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
const atHours = h => localDT(new Date(fakeBase.getTime() + h * 3600e3));
const atDays = d => localDT(new Date(fakeBase.getTime() + d * 864e5));

function jar() { return { cookie: '' }; }
async function req(j, method, url, body) {
  const headers = {};
  if (j.cookie) headers.cookie = j.cookie;
  let payload;
  if (body) { payload = new URLSearchParams(body); headers['content-type'] = 'application/x-www-form-urlencoded'; }
  const r = await fetch(BASE + url, { method, headers, body: payload, redirect: 'manual' });
  const sc = r.headers.get('set-cookie');
  if (sc) { const m = sc.match(/sid=([^;]+)/); if (m) j.cookie = 'sid=' + m[1]; }
  return { status: r.status, location: r.headers.get('location') || '', text: await r.text() };
}
const get = (j, url) => req(j, 'GET', url);
const post = (j, url, body) => req(j, 'POST', url, body);

let n = 0;
const phones = {};
async function register(j, key, overrides = {}) {
  n++;
  const birth = new Date(); birth.setFullYear(birth.getFullYear() - 20);
  const phone = '600100' + (100 + n);
  phones[key] = phone;
  return post(j, '/registro', {
    name: 'User' + key, email: `u${n}@test.es`, phone, password: 'secreto1',
    birthdate: birth.toISOString().slice(0, 10), gender: 'M', level_index: '10', ...overrides,
  });
}
const matchId = r => (r.location.match(/\/partido\/(\d+)/) || [])[1];

(async () => {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/login'); if (r.status === 200) break; } catch {}
    await new Promise(r => setTimeout(r, 200));
  }

  const jA = jar(), jB = jar(), jC = jar(), jD = jar(), jE = jar(), jX = jar(), jF = jar(), jAdm = jar();
  // IDs deterministas: admin=1, A=2, B=3, C=4, D=5, E=6, X=7, F=8

  await okAsync('admin seed desde env', async () => {
    const r = await post(jAdm, '/login', { email: 'admin@club.test', password: 'admin123' });
    assert.equal(r.status, 302);
    const d = await get(jAdm, '/admin');
    assert.equal(d.status, 200);
  });
  await okAsync('registro menor de 14 rechazado', async () => {
    n++;
    const birth = new Date(); birth.setFullYear(birth.getFullYear() - 10);
    const r = await post(jar(), '/registro', { name: 'Kid', email: `u${n}@test.es`, phone: '600100' + (100 + n), password: 'secreto1', birthdate: birth.toISOString().slice(0, 10), gender: 'M', level_index: '12' });
    assert.equal(r.status, 200);
    assert.ok(r.text.includes('14 años'));
  });
  await okAsync('nivel inicial mejor que Medio+ rechazado', async () => {
    const r = await register(jar(), 'tmp', { level_index: '3' });
    assert.equal(r.status, 200);
    assert.ok(r.text.includes('Medio+'));
  });
  await okAsync('registro ok de 7 socios', async () => {
    const defs = [['A', jA, '10', 'M'], ['B', jB, '12', 'M'], ['C', jC, '8', 'M'], ['D', jD, '14', 'M'], ['E', jE, '11', 'F'], ['X', jX, '13', 'M'], ['F', jF, '9', 'M']];
    for (const [k, j, lvl, g] of defs) {
      const r = await register(j, k, { level_index: lvl, gender: g });
      assert.equal(r.status, 302, 'registro ' + k);
    }
  });

  let m1, m2, m3, m4, m5, m6, m7, m8, m9, r1, r2, r3;
  const m1t = localDT(new Date(fakeBase.getTime() + 864e5 + 2 * 3600e3));   // día 2, 11:00
  const m3t = localDT(new Date(fakeBase.getTime() + 864e5 + 2.5 * 3600e3)); // día 2, 11:30
  await okAsync('crear partido (sorteo/torneo/con pista)', async () => {
    const r = await post(jA, '/partidos', { starts_at: m1t, duration_min: '90', has_court: '1', court_label: 'Pista 3', visibility: 'open', gender: 'M', formation: 'sorteo', character: 'torneo' });
    assert.equal(r.status, 302);
    m1 = matchId(r);
  });
  await okAsync('no se puede crear en el pasado', async () => {
    const r = await post(jA, '/partidos', { starts_at: atHours(-3), has_court: '0', visibility: 'open', gender: 'X', formation: 'sorteo', character: 'amistoso' });
    assert.equal(r.status, 200);
    assert.ok(r.text.includes('futuras'));
  });
  await okAsync('B, C y D se apuntan; partido completo', async () => {
    for (const j of [jB, jC, jD]) assert.equal((await post(j, `/partido/${m1}/apuntarse`)).status, 302);
    assert.ok((await get(jA, `/partido/${m1}`)).text.includes('completo'));
  });
  await okAsync('mujer no puede apuntarse a partido masculino', async () => {
    const r = await post(jE, `/partido/${m1}/apuntarse`);
    assert.ok(r.location.includes('err='));
  });
  await okAsync('lista negra: X no ve el partido de A ni puede apuntarse', async () => {
    const rc = await post(jF, '/partidos', { starts_at: atHours(8), has_court: '0', visibility: 'open', gender: 'X', formation: 'sorteo', character: 'amistoso' });
    m2 = matchId(rc);
    assert.equal((await post(jA, '/lista-negra/7')).status, 302);
    const list = await get(jX, '/');
    assert.ok(!list.text.includes(`/partido/${m1}`), 'X no debe ver el partido de A');
    assert.ok(list.text.includes(`/partido/${m2}`), 'X sí ve el de F');
    assert.ok((await post(jX, `/partido/${m1}/apuntarse`)).location.includes('err='));
  });
  await okAsync('incompatibilidad horaria: 1h30 de margen', async () => {
    const rc = await post(jF, '/partidos', { starts_at: m3t, has_court: '0', visibility: 'open', gender: 'X', formation: 'sorteo', character: 'amistoso' });
    m3 = matchId(rc);
    const r = await post(jB, `/partido/${m3}/apuntarse`);
    assert.ok(r.location.includes('err='), 'B tiene m1 de 11:00 a 12:30 del día 2');
  });
  await okAsync('baja libre con más de 3 días', async () => {
    const rc = await post(jA, '/partidos', { starts_at: atDays(10), has_court: '0', visibility: 'open', gender: 'X', formation: 'sorteo', character: 'amistoso' });
    m4 = matchId(rc);
    assert.equal((await post(jB, `/partido/${m4}/apuntarse`)).status, 302);
    assert.ok((await post(jB, `/partido/${m4}/baja`)).location.includes('ok='));
  });
  await okAsync('baja con menos de 3 días exige sustituto', async () => {
    const rc = await post(jA, '/partidos', { starts_at: atHours(30), has_court: '0', visibility: 'open', gender: 'X', formation: 'sorteo', character: 'amistoso' });
    m5 = matchId(rc);
    assert.equal((await post(jB, `/partido/${m5}/apuntarse`)).status, 302);
    assert.ok((await post(jB, `/partido/${m5}/baja`)).location.includes('err='), 'baja directa bloqueada');
    assert.ok((await post(jB, `/partido/${m5}/sustituto/buscar`)).location.includes('ok='));
    assert.ok((await post(jF, `/partido/${m5}/sustituto/ocupar`, { seeker_id: '3' })).location.includes('ok='), 'F ocupa la plaza');
    assert.ok((await get(jA, `/partido/${m5}`)).text.includes('sustituto'));
  });
  await okAsync('con pareja: se publica al confirmar', async () => {
    const rc = await post(jA, '/partidos', { starts_at: atDays(2), has_court: '0', visibility: 'open', gender: 'X', formation: 'pareja', character: 'amistoso', partner_id: '3' });
    m6 = matchId(rc);
    assert.ok((await get(jA, `/partido/${m6}`)).text.includes('pendiente de pareja'));
    assert.ok((await get(jB, '/invitaciones')).text.includes(`/invitacion/${m6}/aceptar`));
    assert.ok((await post(jB, `/invitacion/${m6}/aceptar`)).location.includes(`/partido/${m6}`));
    assert.ok(!(await get(jA, `/partido/${m6}`)).text.includes('pendiente de pareja'));
  });
  await okAsync('con invitados: máx. 3, solo invitados lo ven', async () => {
    const rc = await post(jA, '/partidos', { starts_at: localDT(new Date(fakeBase.getTime() + 2 * 864e5 + 5 * 3600e3)), has_court: '0', visibility: 'invited', gender: 'X', formation: 'sorteo', character: 'amistoso' });
    m7 = matchId(rc);
    for (const uid of ['3', '4', '5']) assert.ok((await post(jA, `/partido/${m7}/invitar`, { user_id: uid })).location.includes('ok='));
    assert.ok((await post(jA, `/partido/${m7}/invitar`, { user_id: '6' })).location.includes('err='), 'máximo 3');
    assert.ok((await get(jB, '/')).text.includes(`/partido/${m7}`), 'B lo ve antes de aceptar');
    assert.ok((await post(jB, `/invitacion/${m7}/aceptar`)).location.includes('ok='));
    assert.ok((await get(jB, '/mis-partidos')).text.includes(`/partido/${m7}`), 'tras aceptar está en mis partidos');
    assert.ok(!(await get(jF, '/')).text.includes(`/partido/${m7}`), 'F no invitado no lo ve');
  });
  await okAsync('para favoritos: solo los favoritos lo ven', async () => {
    assert.ok((await post(jA, '/favoritos/3')).location.includes('ok='));
    const rc = await post(jA, '/partidos', { starts_at: atDays(3), has_court: '0', visibility: 'favorites', gender: 'X', formation: 'sorteo', character: 'amistoso' });
    m8 = matchId(rc);
    assert.ok((await get(jB, '/')).text.includes(`/partido/${m8}`));
    assert.ok(!(await get(jC, '/')).text.includes(`/partido/${m8}`));
  });
  await okAsync('por nivel: fuera de rango no puede apuntarse', async () => {
    const rc = await post(jA, '/partidos', { starts_at: localDT(new Date(fakeBase.getTime() + 3 * 864e5 + 5 * 3600e3)), has_court: '0', visibility: 'level', level_min: '7', level_max: '9', gender: 'X', formation: 'sorteo', character: 'amistoso' });
    m9 = matchId(rc);
    assert.ok((await post(jD, `/partido/${m9}/apuntarse`)).location.includes('err='), 'D es nivel 14');
    assert.equal((await post(jC, `/partido/${m9}/apuntarse`)).status, 302, 'C es nivel 8');
  });
  await okAsync('resultado de torneo actualiza el ELO', async () => {
    const rc = await post(jA, '/partidos', { starts_at: atHours(2), has_court: '0', visibility: 'open', gender: 'X', formation: 'sorteo', character: 'torneo' });
    r1 = matchId(rc);
    for (const [j, nm] of [[jB, 'B'], [jC, 'C'], [jD, 'D']]) {
      const jr = await post(j, `/partido/${r1}/apuntarse`);
      assert.ok(jr.location.includes('ok='), nm + ' apuntado: ' + jr.location);
    }
    const rr = await post(jA, `/partido/${r1}/resultado`, {
      a1: '2', a2: '3', b1: '4', b2: '5', outcome: 'A',
      'sets[0][a]': '6', 'sets[0][b]': '4', 'sets[1][a]': '6', 'sets[1][b]': '3',
    });
    assert.ok(rr.location.includes('ok='), 'resultado aceptado: ' + rr.location);
    assert.ok((await get(jA, `/partido/${r1}`)).text.includes('Movimientos ELO'));
    assert.ok((await get(jA, '/ranking')).text.includes('916'), 'A: 900 + 16');
  });
  await okAsync('empate no mueve el ranking', async () => {
    const rc = await post(jA, '/partidos', { starts_at: atHours(5), has_court: '0', visibility: 'open', gender: 'X', formation: 'sorteo', character: 'torneo' });
    r2 = matchId(rc);
    for (const [j, nm] of [[jB, 'B'], [jE, 'E'], [jF, 'F']]) {
      const jr = await post(j, `/partido/${r2}/apuntarse`);
      assert.ok(jr.location.includes('ok='), nm + ' apuntado: ' + jr.location);
    }
    const rr = await post(jA, `/partido/${r2}/resultado`, {
      a1: '2', a2: '3', b1: '6', b2: '8', outcome: 'draw',
      'sets[0][a]': '6', 'sets[0][b]': '4', 'sets[1][a]': '4', 'sets[1][b]': '6',
    });
    assert.ok(rr.location.includes('ok='), 'empate aceptado: ' + rr.location);
    const det = await get(jA, `/partido/${r2}`);
    assert.ok(det.text.includes('Empate'));
    assert.ok(!det.text.includes('Movimientos ELO'));
    assert.ok((await get(jA, '/ranking')).text.includes('916'), 'A sigue en 916');
  });
  await okAsync('suspendido: sin resultado ni ELO', async () => {
    const rc = await post(jA, '/partidos', { starts_at: atHours(8), has_court: '0', visibility: 'open', gender: 'X', formation: 'sorteo', character: 'torneo' });
    r3 = matchId(rc);
    for (const [j, nm] of [[jC, 'C'], [jD, 'D'], [jE, 'E']]) {
      const jr = await post(j, `/partido/${r3}/apuntarse`);
      assert.ok(jr.location.includes('ok='), nm + ' apuntado: ' + jr.location);
    }
    const rr = await post(jA, `/partido/${r3}/resultado`, { a1: '2', a2: '4', b1: '5', b2: '6', outcome: 'suspended', notes: 'lluvia' });
    assert.ok(rr.location.includes('ok='), 'suspendido aceptado: ' + rr.location);
    assert.ok((await get(jA, `/partido/${r3}`)).text.includes('Suspendido'));
  });
  await okAsync('admin sanciona con puntos (máx. 3)', async () => {
    const r = await post(jAdm, '/admin/usuarios/5/sancionar', { type: 'points', points: '2', reason: 'no-show test', match_id: m1 });
    assert.ok(r.location.includes('ok='));
    assert.ok((await get(jAdm, '/admin/usuarios/5')).text.includes('482'), 'D: 484 - 2');
    assert.ok((await post(jAdm, '/admin/usuarios/5/sancionar', { type: 'points', points: '99', reason: 'tope', match_id: '' })).location.includes('ok='), 'se aplica el tope de 3');
  });
  await okAsync('bloqueo temporal impide entrar; perdón lo levanta', async () => {
    const until = localDT(new Date(Date.now() + 864e5));
    assert.ok((await post(jAdm, '/admin/usuarios/7/sancionar', { type: 'block', until, reason: 'test' })).location.includes('ok='));
    await post(jX, '/logout');
    assert.ok((await post(jX, '/login', { email: 'u8@test.es', password: 'secreto1' })).text.includes('bloqueado'));
    assert.ok((await post(jAdm, '/admin/usuarios/7/perdonar')).location.includes('ok='));
    assert.equal((await post(jX, '/login', { email: 'u8@test.es', password: 'secreto1' })).status, 302);
  });
  await okAsync('expulsión impide entrar', async () => {
    assert.ok((await post(jAdm, '/admin/usuarios/7/sancionar', { type: 'expel', reason: 'reincidente' })).location.includes('ok='));
    await post(jX, '/logout');
    assert.ok((await post(jX, '/login', { email: 'u8@test.es', password: 'secreto1' })).text.includes('expulsada'));
    assert.ok((await post(jAdm, '/admin/usuarios/7/perdonar')).location.includes('ok='));
  });
  await okAsync('antifraude: el teléfono dado de baja no se puede re-registrar', async () => {
    assert.equal((await post(jE, '/baja', { password: 'secreto1', confirm: 'ELIMINAR' })).status, 302);
    n++;
    const r = await post(jar(), '/registro', { name: 'E2', email: `u${n}@test.es`, phone: phones.E, password: 'secreto1', birthdate: '2000-01-01', gender: 'F', level_index: '12' });
    assert.equal(r.status, 200);
    assert.ok(r.text.includes('no puede volver a registrarse'));
  });
  await okAsync('control de asistencia del creador', async () => {
    assert.ok((await post(jA, `/partido/${r1}/asistencia`, { att_2: '1', att_3: '1', att_4: '0', att_5: '1' })).location.includes('ok='));
    assert.equal((await get(jAdm, '/admin')).status, 200);
  });

  console.log(`\n${passed} comprobaciones superadas.`);
  child.kill();
  process.exit(process.exitCode || 0);
})().catch(e => { console.error('FALLO:', e); child.kill(); process.exit(1); });
