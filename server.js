const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'client')));

// Configuración de uploads
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + Math.random().toString(36).substr(2, 9) + path.extname(file.originalname));
  }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// Base de datos en memoria
let cases = [];
let messages = {};

function generateId() {
  return 'HSL-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).substr(2, 4).toUpperCase();
}

// API Routes
app.post('/api/case', (req, res) => {
  const { category, description, isAnonymous, contact } = req.body;
  
  const newCase = {
    id: generateId(),
    category,
    description,
    isAnonymous: isAnonymous || true,
    contact: isAnonymous ? null : contact,
    status: 'pending',
    priority: 'normal',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    files: []
  };
  
  cases.unshift(newCase);
  messages[newCase.id] = [{
    id: Date.now(),
    text: '✅ Su denuncia ha sido recibida.',
    sender: 'system',
    timestamp: new Date().toISOString()
  }];
  
  io.emit('new_case', newCase);
  res.json({ success: true, caseId: newCase.id });
});

app.post('/api/upload/:caseId', upload.array('files', 5), (req, res) => {
  const { caseId } = req.params;
  const caseFound = cases.find(c => c.id === caseId);
  
  if (!caseFound) return res.status(404).json({ error: 'Caso no encontrado' });
  
  const files = req.files.map(f => ({
    filename: f.filename,
    originalname: f.originalname,
    size: f.size
  }));
  
  caseFound.files.push(...files);
  res.json({ success: true, files });
});

app.post('/api/message/:caseId', (req, res) => {
  const { caseId } = req.params;
  const { text, sender, encrypted } = req.body;
  
  const caseFound = cases.find(c => c.id === caseId);
  if (!caseFound) return res.status(404).json({ error: 'Caso no encontrado' });
  
  const newMessage = {
    id: Date.now(),
    text,
    sender,
    encrypted: encrypted || false,
    timestamp: new Date().toISOString()
  };
  
  if (!messages[caseId]) messages[caseId] = [];
  messages[caseId].push(newMessage);
  
  io.to(caseId).emit('new_message', newMessage);
  res.json({ success: true, message: newMessage });
});

app.get('/api/case/:caseId', (req, res) => {
  const { caseId } = req.params;
  const caseFound = cases.find(c => c.id === caseId);
  
  if (!caseFound) return res.status(404).json({ error: 'Caso no encontrado' });
  
  res.json({
    case: { id: caseFound.id, status: caseFound.status },
    messages: messages[caseId] || []
  });
});

app.get('/api/admin/stats', (req, res) => {
  res.json({
    total: cases.length,
    pending: cases.filter(c => c.status === 'pending').length,
    inReview: cases.filter(c => c.status === 'in_review').length,
    resolved: cases.filter(c => c.status === 'resolved').length,
    urgent: cases.filter(c => c.priority === 'urgent').length,
    withFiles: cases.filter(c => c.files.length > 0).length
  });
});

app.get('/api/admin/cases', (req, res) => {
  const filtered = cases.map(c => ({
    id: c.id,
    category: c.category,
    status: c.status,
    priority: c.priority,
    createdAt: c.createdAt,
    messageCount: messages[c.id]?.length || 0,
    hasFiles: c.files.length > 0
  }));
  res.json(filtered);
});

// Socket.io
io.on('connection', (socket) => {
  console.log('🔗 Cliente conectado:', socket.id);
  
  socket.on('join_case', (caseId) => {
    socket.join(caseId);
  });
  
  socket.on('send_message', ({ caseId, text, sender, encrypted }) => {
    const newMessage = {
      id: Date.now(),
      text,
      sender,
      encrypted: encrypted || false,
      timestamp: new Date().toISOString()
    };
    
    if (!messages[caseId]) messages[caseId] = [];
    messages[caseId].push(newMessage);
    
    io.to(caseId).emit('receive_message', newMessage);
  });
});

// Iniciar servidor
const PORT = 4000;
server.listen(PORT, () => {
  console.log('✅ SERVIDOR HSL ACTIVO');
  console.log('🌐 http://localhost:' + PORT);
  console.log('📁 Sirviendo archivos de: ' + path.join(__dirname, 'client'));
});