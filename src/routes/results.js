'use strict';

const express = require('express');
const { get, all, run, transaction } = require('../db');
const { requireLogin } = require('../lib/auth');
const { confirmedPlayers, validateSet, canRegisterResult } = require('../lib/rules');
const { updateRatings, levelForPoints } = require('../lib/elo');

const router = express.Router();
router.use(requireLogin);

// Formulario de resultado
router.get('/partido/:id/resultado', (req, res) => {
  const match = get('SELECT * FROM matches WHERE id = ?', req.params.id);
  if (!match) return res.status(404).send('No encontrado.');
  const players = confirmedPlayers(match.id);
  if (!players.some(p => p.id === req.user.id)) return res.status(403).send('Solo los participantes pueden registrar el resultado.');
  if (!canRegisterResult(match)) {
    return res.redirect(`/partido/${match.id}?err=` + encodeURIComponent('El resultado solo puede registrarse el día del partido y el siguiente.'));
  }
  if (get('SELECT 1 FROM match_results WHERE match_id = ?', match.id)) return res.redirect(`/partido/${match.id}`);
  const pairs = match.pairs_json ? JSON.parse(match.pairs_json).pairs : null;
  res.render('result_form', { match, players, pairs, err: req.query.err });
});

router.post('/partido/:id/resultado', (req, res) => {
  const match = get('SELECT * FROM matches WHERE id = ?', req.params.id);
  if (!match) return res.status(404).send('No encontrado.');
  const players = confirmedPlayers(match.id);
  const ids = players.map(p => p.id);
  if (!ids.includes(req.user.id)) return res.status(403).send('Sin permiso.');
  if (!canRegisterResult(match)) return res.redirect(`/partido/${match.id}?err=` + encodeURIComponent('Fuera de plazo.'));
  if (get('SELECT 1 FROM match_results WHERE match_id = ?', match.id)) return res.redirect(`/partido/${match.id}`);
  if (players.length !== 4) return res.redirect(`/partido/${match.id}?err=` + encodeURIComponent('El partido necesita 4 jugadores.'));

  const fail = msg => res.redirect(`/partido/${match.id}/resultado?err=` + encodeURIComponent(msg));
  const outcome = req.body.outcome;
  if (!['A', 'B', 'draw', 'retired_a', 'retired_b', 'suspended'].includes(outcome)) return fail('Resultado no válido.');

  const teamA = [Number(req.body.a1), Number(req.body.a2)];
  const teamB = [Number(req.body.b1), Number(req.body.b2)];
  const allIds = [...teamA, ...teamB];
  if (new Set(allIds).size !== 4 || !allIds.every(id => ids.includes(id))) return fail('Las parejas deben formarse con los 4 jugadores.');

  // Sets
  let setsA = 0, setsB = 0;
  const sets = [];
  const rawSets = req.body.sets || [];
  const list = (Array.isArray(rawSets) ? rawSets : Object.values(rawSets))
    .filter(s => s && (String(s.a).trim() !== '' || String(s.b).trim() !== ''));
  for (const s of list) {
    const v = validateSet(s.a, s.b, s.tb === '1');
    if (!v.valid) return fail('Hay un set con marcador no válido (recuerda: el 6-6 se resuelve con tie-break).');
    const complete = s.complete !== '0'; // sets iniciados a <10 min del final no cuentan
    sets.push({ a: Number(s.a), b: Number(s.b), tb: s.tb === '1', complete });
    if (complete) {
      if (v.winner === 'A') setsA++;
      else setsB++;
    }
  }

  if (outcome === 'suspended') {
    // Sin resultado deportivo: no hay ELO
    transaction(() => {
      run(`INSERT INTO match_results(match_id, registered_by, team_a, team_b, outcome, sets, notes)
           VALUES (?,?,?,?,?,?,?)`,
        match.id, req.user.id, JSON.stringify(teamA), JSON.stringify(teamB), 'suspended',
        JSON.stringify(sets), String(req.body.notes || '').slice(0, 500));
      run(`UPDATE matches SET status = 'closed' WHERE id = ?`, match.id);
    });
    return res.redirect(`/partido/${match.id}?ok=` + encodeURIComponent('Partido suspendido registrado (sin cambios en el ranking).'));
  }

  if (sets.length === 0) return fail('Indica al menos un set.');
  if (outcome === 'A' && setsA <= setsB) return fail('El marcador no da ganador al equipo A.');
  if (outcome === 'B' && setsB <= setsA) return fail('El marcador no da ganador al equipo B.');
  if (outcome === 'draw' && setsA !== setsB) return fail('El empate requiere los mismos sets.');
  if ((outcome === 'retired_a' || outcome === 'retired_b') && setsA === setsB && setsA === 0) {
    return fail('Indica los sets jugados antes de la retirada.');
  }

  // Ganador por normativa: más sets completos; 3 sets = victoria automática
  const winnerTeam = outcome === 'B' || outcome === 'retired_a' ? 'B'
    : outcome === 'A' || outcome === 'retired_b' ? 'A' : 'draw';

  let eloJson = null;
  transaction(() => {
    if (match.character === 'torneo' && winnerTeam !== 'draw') {
      const byId = Object.fromEntries(players.map(p => [p.id, p]));
      const scoreA = winnerTeam === 'A' ? 1 : 0;
      const deltas = updateRatings(
        teamA.map(id => ({ id, points: byId[id].points })),
        teamB.map(id => ({ id, points: byId[id].points })),
        scoreA
      );
      for (const dlt of deltas) {
        run('UPDATE users SET points = ?, level_index = ? WHERE id = ?', dlt.newPoints, dlt.newLevel, dlt.userId);
      }
      eloJson = JSON.stringify(deltas);
    }
    run(`INSERT INTO match_results(match_id, registered_by, team_a, team_b, outcome, sets, notes, elo_json)
         VALUES (?,?,?,?,?,?,?,?)`,
      match.id, req.user.id, JSON.stringify(teamA), JSON.stringify(teamB), outcome,
      JSON.stringify(sets), String(req.body.notes || '').slice(0, 500), eloJson);
    run(`UPDATE matches SET status = 'closed' WHERE id = ?`, match.id);
  });

  const msg = match.character === 'torneo' && winnerTeam !== 'draw'
    ? 'Resultado registrado y ranking actualizado.'
    : 'Resultado registrado.';
  res.redirect(`/partido/${match.id}?ok=` + encodeURIComponent(msg));
});

module.exports = router;
