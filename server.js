const express = require('express');
const getDrive = require('./drive');

const app = express();
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

// 🚀 Iniciar servidor
app.listen(3000, () => {
  console.log('🚀 API corriendo en http://localhost:3000');
});
