'use strict';
// Crea jugadores de prueba: node src/seed-test-players.js [n]
// Todos con contraseña "test1234". Idempotente: omite los que ya existan.
const { get, run } = require('./db');
const { hashPassword } = require('./lib/auth');
const { pointsForLevel, levelLabel, MAX_INITIAL_LEVEL } = require('./lib/elo');

const N = Math.max(1, Math.min(40, Number(process.argv[2] || 8)));
const NAMES_M = ['Bruno', 'Carlos', 'Diego', 'Iván', 'Jorge', 'Luis', 'Marco', 'Nico', 'Pablo', 'Rafa', 'Sergio', 'Tomás', 'Víctor', 'Álex', 'Dani', 'Hugo', 'Iker', 'Joel', 'Mario', 'Óscar'];
const NAMES_F = ['Ana', 'Lucía', 'Marta', 'Sara', 'Elena', 'Clara', 'Irene', 'Paula', 'Nora', 'Laia', 'Júlia', 'Aina', 'Carla', 'Júlia', 'Mireia', 'Núria', 'Anna', 'Jana', 'Ona', 'Rut'];

let created = 0, skipped = 0;
for (let i = 0; i < N; i++) {
  const female = i % 2 === 1;
  const pool = female ? NAMES_F : NAMES_M;
  const name = 'Test ' + pool[i % pool.length];
  const email = `test${i + 1}@padelrank.test`;
  const phone = '621000' + String(101 + i);
  // Niveles repartidos por toda la escala inicial permitida (7..18)
  const lvl = MAX_INITIAL_LEVEL + (i % (19 - MAX_INITIAL_LEVEL));
  if (get('SELECT 1 FROM users WHERE email = ? OR phone = ?', email, phone)) { skipped++; continue; }
  run(
    `INSERT INTO users(name, email, phone, password_hash, birthdate, gender, level_index, points)
     VALUES (?,?,?,?,?,?,?,?)`,
    name, email, phone, hashPassword('test1234'), '1990-01-01',
    female ? 'F' : 'M', lvl, pointsForLevel(lvl)
  );
  console.log(`  ${email}  ${name}  ${female ? 'F' : 'M'}  ${levelLabel(lvl)}`);
  created++;
}
console.log(`\nCreados: ${created}, omitidos (ya existían): ${skipped}. Contraseña de todos: test1234`);
