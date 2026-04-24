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
  cors: { 
    origin: "*", 
    methods: ["GET", "POST", "PATCH"]
  }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'client')));

// Configuración de uploads
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + Math.random().toString(36).substr(2, 9) + path.extname(file.originalname));
  }
});
const upload = multer({ 
  storage, 
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB max
});

// Base de datos en memoria
let cases = [];
let messages = {};

// Generar ID único
function generateId() {
  return 'HSL-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).substr(2, 4).toUpperCase();
}

// ==================== API ROUTES ====================

// Crear nuevo caso
app.post('/api/case', (req, res) => {
  const { category, description, isAnonymous, contact } = req.body;
  
  const newCase = {
    id: generateId(),
    category,
    description,
    isAnonymous: isAnonymous || true,
    contact: isAnonymous ? null : contact,
    status: 'pending', // pending, in_review, resolved
    priority: 'normal', // normal, high, urgent
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    files: []
  };
  
  cases.unshift(newCase);
  messages[newCase.id] = [{
    id: Date.now(),
    text: '✅ Su denuncia ha sido recibida. Un especialista la revisará en breve.',
    sender: 'system',
    timestamp: new Date().toISOString()
  }];
  
  io.emit('new_case', newCase);
  res.json({ success: true, caseId: newCase.id, message: 'Denuncia registrada' });
});

// Subir archivos
app.post('/api/upload/:caseId', upload.array('files', 5), (req, res) => {
  const { caseId } = req.params;
  const caseFound = cases.find(c => c.id === caseId);
  
  if (!caseFound) {
    return res.status(404).json({ error: 'Caso no encontrado' });
  }
  
  const files = req.files.map(f => ({
    filename: f.filename,
    originalname: f.originalname,
    size: f.size,
    mimetype: f.mimetype,
    uploadedAt: new Date().toISOString()
  }));
  
  caseFound.files.push(...files);
  caseFound.updatedAt = new Date().toISOString();
  
  io.emit('case_updated', { caseId, files });
  res.json({ success: true, files });
});

// Enviar mensaje al chat
app.post('/api/message/:caseId', (req, res) => {
  const { caseId } = req.params;
  const { text, sender, encrypted } = req.body;
  
  const caseFound = cases.find(c => c.id === caseId);
  if (!caseFound) {
    return res.status(404).json({ error: 'Caso no encontrado' });
  }
  
  const newMessage = {
    id: Date.now(),
    text,
    sender, // 'whistleblower', 'admin', 'system'
    encrypted: encrypted || false,
    timestamp: new Date().toISOString(),
    read: false
  };
  
  if (!messages[caseId]) messages[caseId] = [];
  messages[caseId].push(newMessage);
  caseFound.updatedAt = new Date().toISOString();
  
  io.to(caseId).emit('new_message', newMessage);
  io.emit('case_activity', { caseId, lastMessage: text });
  
  res.json({ success: true, message: newMessage });
});

// Obtener caso y mensajes
app.get('/api/case/:caseId', (req, res) => {
  const { caseId } = req.params;
  const caseFound = cases.find(c => c.id === caseId);
  
  if (!caseFound) {
    return res.status(404).json({ error: 'Caso no encontrado' });
  }
  
  res.json({
    case: {
      id: caseFound.id,
      status: caseFound.status,
      priority: caseFound.priority,
      createdAt: caseFound.createdAt,
      hasFiles: caseFound.files.length > 0
    },
    messages: messages[caseId] || []
  });
});

// Dashboard stats (admin)
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

// Lista completa de casos (admin) - NUEVO
app.get('/api/admin/cases', (req, res) => {
  const casesList = cases.map(c => ({
    id: c.id,
    category: c.category,
    description: c.description.substring(0, 100) + '...',
    status: c.status,
    priority: c.priority,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    messageCount: messages[c.id]?.length || 0,
    hasFiles: c.files.length > 0
  }));
  res.json(casesList);
});

// Actualizar estado del caso - NUEVO
app.patch('/api/case/:caseId/status', (req, res) => {
  const { caseId } = req.params;
  const { status, priority } = req.body;
  
  const caseFound = cases.find(c => c.id === caseId);
  if (!caseFound) {
    return res.status(404).json({ error: 'Caso no encontrado' });
  }
  
  if (status) caseFound.status = status;
  if (priority) caseFound.priority = priority;
  caseFound.updatedAt = new Date().toISOString();
  
  io.emit('case_status_changed', { caseId, status, priority });
  res.json({ success: true });
});

// ==================== SOCKET.IO ====================

io.on('connection', (socket) => {
  console.log('🔗 Cliente conectado:', socket.id);
  
  // Unirse a sala de caso
  socket.on('join_case', (caseId) => {
    socket.join(caseId);
    console.log(`Socket ${socket.id} unido al caso ${caseId}`);
  });
  
  // Enviar mensaje
  socket.on('send_message', ({ caseId, text, sender, encrypted }) => {
    const newMessage = {
      id: Date.now(),
      text,
      sender,
      encrypted: encrypted || false,
      timestamp: new Date().toISOString(),
      read: false
    };
    
    if (!messages[caseId]) messages[caseId] = [];
    messages[caseId].push(newMessage);
    
    const caseFound = cases.find(c => c.id === caseId);
    if (caseFound) {
      caseFound.updatedAt = new Date().toISOString();
    }
    
    io.to(caseId).emit('receive_message', newMessage);
    io.emit('case_activity', { caseId, lastMessage: text });
  });
  
  // Desconectar
  socket.on('disconnect', () => {
    console.log('🔌 Cliente desconectado:', socket.id);
  });
});

// ==================== INICIAR SERVIDOR ====================

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log('✅ SERVIDOR HSL ACTIVO');
  console.log('🌐 Puerto:', PORT);
  console.log('📁 Uploads:', uploadDir);
  console.log('📱 Socket.io: habilitado');
});
