const express = require('express');
const getDrive = require('./drive');

const app = express();

// ── CORS ──
// Permite que la landing page del cliente (cualquier origen) pueda
// consultar el estado. Solo GET está abierto; PUT sigue protegido.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json());

// 🔴 ID de tu carpeta clientes
const FOLDER_ID = '1Hi5DIllhfb09ThQDeQW0IIng5898XFij';

// 🔍 Buscar archivo dentro de la carpeta
async function findFile(drive, name) {
  const res = await drive.files.list({
    q: `name='${name}' and '${FOLDER_ID}' in parents`,
    fields: 'files(id, name)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  return res.data.files[0];
}

// 📥 GET cliente
app.get('/clientes/:id', async (req, res) => {
  try {
    const drive = await getDrive();

    const file = await findFile(drive, req.params.id + '.json');

    if (!file) return res.status(404).send('No existe');

    const data = await drive.files.get({
      fileId: file.id,
      alt: 'media',
      supportsAllDrives: true,
    });

    res.json(data.data);

  } catch (err) {
    console.error(err);
    res.status(500).send(err.message);
  }
});

// 💾 PUT cliente
app.put('/clientes/:id', async (req, res) => {
  try {
    const drive = await getDrive();

    const fileName = req.params.id + '.json';
    const newData = req.body;

    let file = await findFile(drive, fileName);

    // 🆕 CREAR directamente en carpeta
    if (!file) {

      const created = await drive.files.create({
        requestBody: {
          name: fileName,
          parents: [FOLDER_ID], // 🔥 AQUÍ SE CREA DIRECTO
        },
        media: {
          mimeType: 'application/json',
          body: JSON.stringify({ ...newData, version: 1 }),
        },
        fields: 'id, parents',
        supportsAllDrives: true,
      });

      console.log('Archivo creado en carpeta clientes');

      return res.json({ ok: true, version: 1 });
    }

    // 📥 Leer actual
    const current = await drive.files.get({
      fileId: file.id,
      alt: 'media',
      supportsAllDrives: true,
    });

    // 🔐 Control de versión
    if (newData.version !== current.data.version) {
      return res.status(409).json({
        error: 'Conflicto de versión',
        currentVersion: current.data.version,
      });
    }

    const updated = {
      ...newData,
      version: current.data.version + 1,
      updated_at: new Date().toISOString(),
    };

    // 💾 Actualizar
    await drive.files.update({
      fileId: file.id,
      media: {
        mimeType: 'application/json',
        body: JSON.stringify(updated),
      },
      supportsAllDrives: true,
    });

    res.json({ ok: true, version: updated.version });

  } catch (err) {
    console.error(err);
    res.status(500).send(err.message);
  }
});

// 📋 LISTAR clientes
app.get('/clientes', async (req, res) => {
  try {
    const drive = await getDrive();

    const files = await drive.files.list({
      q: `'${FOLDER_ID}' in parents`,
      fields: 'files(id, name)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    res.json(files.data.files);

  } catch (err) {
    console.error(err);
    res.status(500).send(err.message);
  }
});

// ✅ Health check
app.get('/', (req, res) => {
  res.json({ app: 'Ronni GSM Backend', status: 'ok' });
});

// 🚀 Iniciar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 API corriendo en http://localhost:${PORT}`);
});
