# Club Pádel — partidos, ranking ELO y torneos

Aplicación web para un club de pádel: los socios crean partidos (amistosos o de
torneo), se apuntan, registran resultados y compiten en un ranking ELO con
18 niveles. Sin dependencias nativas: usa el SQLite integrado en Node 24.

## Requisitos

- Docker y Docker Compose (recomendado), o Node.js 24+.

## Puesta en marcha con Docker

```bash
cp .env.example .env
# edita .env: SESSION_SECRET, ADMIN_EMAIL y ADMIN_PASSWORD
docker compose up -d --build
```

La app queda en `http://TU_SERVIDOR:3000`. Los datos viven en `./data`
(SQLite); no borres esa carpeta al actualizar.

Actualizar:

```bash
docker compose up -d --build
```

## Puesta en marcha sin Docker

```bash
npm ci
cp .env.example .env   # y edítalo
npm start
```

## Variables de entorno

| Variable         | Descripción                                              |
|------------------|----------------------------------------------------------|
| `PORT`           | Puerto de escucha (por defecto 3000)                     |
| `DATA_DIR`       | Carpeta de la base de datos (por defecto `./data`)       |
| `SESSION_SECRET` | Clave para firmar las sesiones (¡cámbiala!)              |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Crea el primer administrador en el arranque |

## Reglas implementadas

- Registro desde los 14 años; nivel inicial libre hasta **Medio+** como máximo.
- 18 niveles (Radical PRO → Básico), 100 puntos por nivel, entre 1800 y 0.
- ELO clásico K=32 por parejas (promedio de sus dos jugadores). Solo los
  **torneos** mueven el ranking: victoria suma, derrota resta, empate no cambia.
- Partidos con fecha/hora, pista (opcional pero indicada), visibilidad
  (abierto, por nivel, favoritos o invitados —máx. 3—), masculino/femenino/mixto,
  con pareja o por sorteo, amistoso o torneo.
- Sorteo: en mixto, una mujer y un hombre por pareja; si no, el mejor con el peor.
- 1h30 de margen entre partidos del mismo jugador; no repetir los mismos 4
  el mismo día; no crear ni aceptar partidos pasados.
- Baja libre con más de 3 días; con menos, hay que dejar sustituto.
- Resultado registrable por cualquier participante el día del partido y el
  siguiente. Gana quien más sets completos tenga; 3 sets = victoria automática.
  Un set empezado a menos de 10 minutos del final no cuenta. 6-6 → tie-break.
  Retirada = derrota; mal tiempo o ausencia = suspendido (sin ELO).
- Lista negra personal: el bloqueado no ve tus partidos ni puede apuntarse.
- Baja de cuenta: el teléfono se conserva anonimizado para impedir registros
  fraudulentos.
- Administración: asistencia, no-shows, sanción de hasta 3 puntos, bloqueo
  temporal y expulsión (segunda falta).

## Tests

```bash
npm test   # 34 comprobaciones: unitarias + integración HTTP
```
