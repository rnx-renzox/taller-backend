const express = require('express');
const crypto  = require('crypto');
const getDrive = require('./drive');

const app = express();

// ── CORS ──
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json());

// ── CONFIG ──
const FOLDER_ID = '1Hi5DIllhfb09ThQDeQW0IIng5898XFij';

// Tokens en memoria (se limpian al reiniciar el servidor)
// Formato: { token: { usuario, rol, nombre, exp } }
const sessions = {};

// ── HELPERS ──
function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}
function genToken() {
  return crypto.randomBytes(32).toString('hex');
}
function authMiddleware(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token  = header.replace('Bearer ', '').trim();
  if (!token || !sessions[token]) return res.status(401).json({ error: 'No autorizado' });
  const s = sessions[token];
  if (Date.now() > s.exp) { delete sessions[token]; return res.status(401).json({ error: 'Sesión expirada' }); }
  req.user = s;
  next();
}
function adminOnly(req, res, next) {
  if (req.user.rol !== 'admin') return res.status(403).json({ error: 'Solo admin' });
  next();
}

async function findFile(drive, name) {
  const res = await drive.files.list({
    q: `name='${name}' and '${FOLDER_ID}' in parents and trashed=false`,
    fields: 'files(id, name)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return res.data.files[0];
}

async function readJsonFile(drive, fileId) {
  const res = await drive.files.get({ fileId, alt: 'media', supportsAllDrives: true });
  return res.data;
}

async function writeJsonFile(drive, fileId, data) {
  await drive.files.update({
    fileId,
    media: { mimeType: 'application/json', body: JSON.stringify(data) },
    supportsAllDrives: true,
  });
}

// ── USUARIOS ──
// Lee/escribe usuarios.json en Drive
async function getUsuarios(drive) {
  const file = await findFile(drive, 'usuarios.json');
  if (!file) return null;
  return { file, data: await readJsonFile(drive, file.id) };
}

async function ensureUsuarios(drive) {
  // Si no existe usuarios.json, lo crea con los usuarios iniciales
  const existing = await findFile(drive, 'usuarios.json');
  if (existing) return;

  const defaultUsers = [
    { usuario: 'admin',    password: sha256('admin123'),    rol: 'admin',   nombre: 'Admin',    activo: true },
    { usuario: 'fernando', password: sha256('fernando123'), rol: 'tecnico', nombre: 'Fernando', activo: true },
    { usuario: 'renzo',    password: sha256('renzo123'),    rol: 'tecnico', nombre: 'Renzo',    activo: true },
  ];

  await drive.files.create({
    requestBody: { name: 'usuarios.json', parents: [FOLDER_ID] },
    media: { mimeType: 'application/json', body: JSON.stringify(defaultUsers) },
    fields: 'id',
    supportsAllDrives: true,
  });
  console.log('✅ usuarios.json creado con usuarios iniciales');
}

// ── AUTH ENDPOINTS ──

// POST /login
app.post('/login', async (req, res) => {
  try {
    const { usuario, password } = req.body;
    if (!usuario || !password) return res.status(400).json({ error: 'Faltan credenciales' });

    const drive = await getDrive();
    await ensureUsuarios(drive);

    const result = await getUsuarios(drive);
    if (!result) return res.status(500).json({ error: 'No se pudo leer usuarios' });

    const users = result.data;
    const user  = users.find(u => u.usuario === usuario.toLowerCase().trim() && u.activo !== false);
    if (!user) return res.status(401).json({ error: 'Usuario no encontrado' });

    const hash = sha256(password);
    if (user.password !== hash) return res.status(401).json({ error: 'Contraseña incorrecta' });

    const token = genToken();
    const exp   = Date.now() + 1000 * 60 * 60 * 12; // 12 horas
    sessions[token] = { usuario: user.usuario, rol: user.rol, nombre: user.nombre, exp };

    res.json({ token, rol: user.rol, nombre: user.nombre, usuario: user.usuario });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /me — valida sesión activa
app.get('/me', authMiddleware, (req, res) => {
  res.json({ usuario: req.user.usuario, rol: req.user.rol, nombre: req.user.nombre });
});

// POST /logout
app.post('/logout', authMiddleware, (req, res) => {
  const token = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
  delete sessions[token];
  res.json({ ok: true });
});

// POST /cambiar-password — cualquier usuario puede cambiar su propia contraseña
app.post('/cambiar-password', authMiddleware, async (req, res) => {
  try {
    const { passwordActual, passwordNueva } = req.body;
    if (!passwordActual || !passwordNueva) return res.status(400).json({ error: 'Faltan datos' });
    if (passwordNueva.length < 6) return res.status(400).json({ error: 'Mínimo 6 caracteres' });

    const drive  = await getDrive();
    const result = await getUsuarios(drive);
    if (!result) return res.status(500).json({ error: 'No se pudo leer usuarios' });

    const users = result.data;
    const idx   = users.findIndex(u => u.usuario === req.user.usuario);
    if (idx === -1) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (users[idx].password !== sha256(passwordActual)) return res.status(401).json({ error: 'Contraseña actual incorrecta' });

    users[idx].password = sha256(passwordNueva);
    await writeJsonFile(drive, result.file.id, users);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /usuarios — solo admin
app.get('/usuarios', authMiddleware, adminOnly, async (req, res) => {
  try {
    const drive  = await getDrive();
    const result = await getUsuarios(drive);
    if (!result) return res.json([]);
    // No devolver passwords
    res.json(result.data.map(u => ({ usuario: u.usuario, rol: u.rol, nombre: u.nombre, activo: u.activo })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /usuarios/:usuario — solo admin (cambiar contraseña de otro, activar/desactivar)
app.put('/usuarios/:usuario', authMiddleware, adminOnly, async (req, res) => {
  try {
    const drive  = await getDrive();
    const result = await getUsuarios(drive);
    if (!result) return res.status(500).json({ error: 'No se pudo leer usuarios' });

    const users = result.data;
    const idx   = users.findIndex(u => u.usuario === req.params.usuario);
    if (idx === -1) return res.status(404).json({ error: 'Usuario no encontrado' });

    if (req.body.password)         users[idx].password = sha256(req.body.password);
    if (req.body.activo !== undefined) users[idx].activo = req.body.activo;
    if (req.body.nombre)           users[idx].nombre   = req.body.nombre;

    await writeJsonFile(drive, result.file.id, users);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── CLIENTES ──

// GET /clientes — admin ve todo, técnico solo los suyos
app.get('/clientes', authMiddleware, async (req, res) => {
  try {
    const drive = await getDrive();
    const files = await drive.files.list({
      q: `'${FOLDER_ID}' in parents and trashed=false and name != 'usuarios.json' and name != 'egresos.json'`,
      fields: 'files(id, name)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    // Leer todos los archivos JSON de clientes
    const clientes = await Promise.all(
      files.data.files
        .filter(f => f.name.endsWith('.json'))
        .map(async f => {
          try { return await readJsonFile(drive, f.id); }
          catch { return null; }
        })
    );

    let result = clientes.filter(Boolean);

    // Técnico solo ve sus propios registros
    if (req.user.rol === 'tecnico') {
      result = result.filter(c =>
        (c.tecnico || '').toLowerCase() === req.user.nombre.toLowerCase()
      );
    }

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /clientes/:id — protegido, técnico solo puede ver los suyos
app.get('/clientes/:id', async (req, res) => {
  // Este endpoint es público para la landing page del QR (sin auth)
  try {
    const drive = await getDrive();
    const file  = await findFile(drive, req.params.id + '.json');
    if (!file) return res.status(404).json({ error: 'No existe' });
    const data = await readJsonFile(drive, file.id);
    // Solo devolver campos públicos para el QR (sin datos sensibles)
    res.json({
      id: data.id, nombre: data.nombre, equipo: data.equipo,
      modelo: data.modelo, estado: data.estado, servicio: data.servicio,
      tecnico: data.tecnico, fecha: data.fecha,
      precio: data.precio, // visible al cliente
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /clientes/:id — técnico puede crear/editar los suyos, no eliminar
app.put('/clientes/:id', authMiddleware, async (req, res) => {
  try {
    const drive    = await getDrive();
    const fileName = req.params.id + '.json';
    const newData  = req.body;

    // Técnico solo puede guardar si el tecnico del registro es él
    if (req.user.rol === 'tecnico') {
      const tecnicoEnDato = (newData.tecnico || '').toLowerCase();
      if (tecnicoEnDato !== req.user.nombre.toLowerCase()) {
        return res.status(403).json({ error: 'No puedes editar fichas de otro técnico' });
      }
    }

    let file = await findFile(drive, fileName);

    if (!file) {
      await drive.files.create({
        requestBody: { name: fileName, parents: [FOLDER_ID] },
        media: { mimeType: 'application/json', body: JSON.stringify({ ...newData, version: 1 }) },
        fields: 'id',
        supportsAllDrives: true,
      });
      return res.json({ ok: true, version: 1 });
    }

    const current = await readJsonFile(drive, file.id);

    // Técnico no puede editar fichas que no son suyas
    if (req.user.rol === 'tecnico') {
      const dueno = (current.tecnico || '').toLowerCase();
      if (dueno && dueno !== req.user.nombre.toLowerCase()) {
        return res.status(403).json({ error: 'No puedes editar fichas de otro técnico' });
      }
    }

    if (newData.version !== undefined && newData.version !== current.version) {
      return res.status(409).json({ error: 'Conflicto de versión', currentVersion: current.version });
    }

    const updated = { ...newData, version: (current.version || 0) + 1, updated_at: new Date().toISOString() };
    await writeJsonFile(drive, file.id, updated);
    res.json({ ok: true, version: updated.version });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /clientes/:id — solo admin
app.delete('/clientes/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const drive = await getDrive();
    const file  = await findFile(drive, req.params.id + '.json');
    if (!file) return res.status(404).json({ error: 'No existe' });
    await drive.files.delete({ fileId: file.id, supportsAllDrives: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── EGRESOS ──
// Cada usuario tiene su propio archivo: egresos_admin.json, egresos_fernando.json, etc.

app.get('/egresos', authMiddleware, async (req, res) => {
  try {
    const drive    = await getDrive();
    const fileName = `egresos_${req.user.usuario}.json`;
    const file     = await findFile(drive, fileName);
    if (!file) return res.json([]);
    const data = await readJsonFile(drive, file.id);
    res.json(Array.isArray(data) ? data : []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/egresos', authMiddleware, async (req, res) => {
  try {
    const drive    = await getDrive();
    const fileName = `egresos_${req.user.usuario}.json`;
    const file     = await findFile(drive, fileName);
    const arr      = Array.isArray(req.body) ? req.body : [];

    if (!file) {
      await drive.files.create({
        requestBody: { name: fileName, parents: [FOLDER_ID] },
        media: { mimeType: 'application/json', body: JSON.stringify(arr) },
        fields: 'id',
        supportsAllDrives: true,
      });
    } else {
      await writeJsonFile(drive, file.id, arr);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /egresos/todos — solo admin, consolida todos
app.get('/egresos/todos', authMiddleware, adminOnly, async (req, res) => {
  try {
    const drive = await getDrive();
    const files = await drive.files.list({
      q: `'${FOLDER_ID}' in parents and trashed=false and name contains 'egresos_'`,
      fields: 'files(id, name)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    const all = [];
    for (const f of files.data.files) {
      try {
        const data = await readJsonFile(drive, f.id);
        const user = f.name.replace('egresos_', '').replace('.json', '');
        if (Array.isArray(data)) data.forEach(e => all.push({ ...e, _usuario: user }));
      } catch {}
    }
    res.json(all);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── HEALTH ──
app.get('/', (req, res) => {
  res.json({ app: 'Ronni GSM Backend', version: '2.0', status: 'ok' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Ronni GSM API v2.0 en http://localhost:${PORT}`));
