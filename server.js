const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*", methods: ["GET", "POST", "PATCH"] } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'client')));

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + Math.random().toString(36).substr(2, 9) + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

let cases = [];
let adminNotes = {};

function generateId() {
  return 'HSL-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).substr(2, 4).toUpperCase();
}

// Crear caso
app.post('/api/case', (req, res) => {
  const { category, description } = req.body;
  const newCase = {
    id: generateId(),
    category,
    description,
    status: 'pending',
    createdAt: new Date().toISOString(),
    files: []
  };
  cases.unshift(newCase);
  adminNotes[newCase.id] = [];
  io.emit('new_case', newCase);
  res.json({ success: true, caseId: newCase.id });
});

// Subir archivos
app.post('/api/upload/:caseId', upload.array('files', 5), (req, res) => {
  const { caseId } = req.params;
  const caseFound = cases.find(c => c.id === caseId);
  if (!caseFound) return res.status(404).json({ error: 'Caso no encontrado' });
  
  const files = req.files.map(f => ({
    filename: f.filename, originalname: f.originalname, size: f.size, mimetype: f.mimetype, uploadedAt: new Date().toISOString()
  }));
  caseFound.files.push(...files);
  res.json({ success: true, files });
});

// Stats Admin
app.get('/api/admin/stats', (req, res) => {
  res.json({
    total: cases.length,
    pending: cases.filter(c => c.status === 'pending').length,
    inReview: cases.filter(c => c.status === 'in_review').length,
    resolved: cases.filter(c => c.status === 'resolved').length
  });
});

// Lista Admin
app.get('/api/admin/cases', (req, res) => {
  res.json(cases.map(c => ({
    id: c.id, category: c.category, description: c.description.substring(0, 100) + '...',
    status: c.status, createdAt: c.createdAt, hasFiles: c.files.length > 0
  })));
});

// Detalle Caso
app.get('/api/case/:caseId', (req, res) => {
  const caseFound = cases.find(c => c.id === req.params.caseId);
  if (!caseFound) return res.status(404).json({ error: 'No encontrado' });
  res.json({ case: caseFound, notes: adminNotes[caseFound.id] || [] });
});

// Cambiar Estado
app.patch('/api/case/:caseId/status', (req, res) => {
  const { caseId } = req.params;
  const { status } = req.body;
  const caseFound = cases.find(c => c.id === caseId);
  if (!caseFound) return res.status(404).json({ error: 'No encontrado' });
  caseFound.status = status;
  io.emit('case_status_changed', { caseId, status });
  res.json({ success: true });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`✅ Servidor activo en puerto ${PORT}`));
