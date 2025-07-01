import 'dotenv/config';      
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import Database from "better-sqlite3";
import { v4 as uuid } from "uuid";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import multer from "multer";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log("🚀 Starting Smart Classroom Live Transcription Server...");

// Initialize ElevenLabs client
const elevenlabs = new ElevenLabsClient({
  apiKey: process.env.ELEVENLABS_KEY,
});

// Session state management
const activeSessions = new Map(); // sessionCode -> { id, code, active, interval, startTime }
const sessionTimers = new Map();  // sessionCode -> timer

/* ---------- 1. SQLite ---------- */
const db = new Database("db.sqlite");
console.log("📦 Database connected");

// Migration: Add active column if it doesn't exist
try {
  db.prepare('ALTER TABLE sessions ADD COLUMN active INTEGER DEFAULT 0').run();
  console.log("✅ Added 'active' column to sessions table");
} catch (e) {
  console.log("ℹ️  'active' column already exists in sessions table");
}

// Migration: Add new transcript columns if they don't exist
try {
  db.prepare('ALTER TABLE transcripts ADD COLUMN word_count INTEGER DEFAULT 0').run();
  db.prepare('ALTER TABLE transcripts ADD COLUMN duration_seconds REAL DEFAULT 0').run();
  db.prepare('ALTER TABLE transcripts ADD COLUMN segment_number INTEGER DEFAULT 0').run();
  console.log("✅ Added new columns to transcripts table");
} catch (e) {
  console.log("ℹ️  New transcript columns already exist");
}

db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  code TEXT UNIQUE,
  interval_ms INTEGER DEFAULT 10000,
  created_at INTEGER,
  active INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  number INTEGER,
  UNIQUE(session_id, number)
);

CREATE TABLE IF NOT EXISTS transcripts (
  id TEXT PRIMARY KEY,
  group_id TEXT,
  text TEXT,
  word_count INTEGER DEFAULT 0,
  duration_seconds REAL DEFAULT 0,
  segment_number INTEGER DEFAULT 0,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS summaries (
  group_id TEXT PRIMARY KEY,
  text TEXT,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS session_prompts (
  session_id TEXT PRIMARY KEY,
  prompt TEXT,
  updated_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_transcripts_group_created 
ON transcripts(group_id, created_at);

CREATE INDEX IF NOT EXISTS idx_transcripts_segment 
ON transcripts(group_id, segment_number);
`);
console.log("📊 Database tables ready");

/* ---------- 2. Express + Socket.IO ---------- */
const app = express();
app.use(express.static(path.join(__dirname, "public")));

// Setup multer for file uploads
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

const http = createServer(app);
const io   = new Server(http, { cors: { origin: "*" } });

/* Serve student and admin pages */
app.get("/student", (req, res) => {
  console.log("📚 Serving student page");
  res.sendFile(path.join(__dirname, "public", "student.html"));
});
app.get("/admin", (req, res) => {
  console.log("👨‍🏫 Serving admin page");
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

/* Serve test transcription page */
app.get("/test-transcription", (req, res) => {
  console.log("🧪 Serving test transcription page");
  res.sendFile(path.join(__dirname, "public", "test-transcription.html"));
});

/* Serve database viewer page */
app.get("/database", (req, res) => {
  console.log("🗄️ Serving database viewer page");
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Database Viewer - Smart Classroom</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');
        body { font-family: 'Inter', sans-serif; }
        .gradient-bg { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); }
    </style>
</head>
<body class="bg-gray-50 min-h-screen">
    <header class="gradient-bg text-white shadow-xl">
        <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
            <div class="flex items-center justify-between">
                <div class="flex items-center space-x-4">
                    <div class="w-12 h-12 bg-white/20 rounded-xl flex items-center justify-center">
                        <svg class="w-7 h-7" fill="currentColor" viewBox="0 0 20 20">
                            <path d="M3 4a1 1 0 011-1h12a1 1 0 011 1v2a1 1 0 01-1 1H4a1 1 0 01-1-1V4zM3 10a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H4a1 1 0 01-1-1v-6zM14 9a1 1 0 00-1 1v6a1 1 0 001 1h2a1 1 0 001-1v-6a1 1 0 00-1-1h-2z"/>
                        </svg>
                    </div>
                    <div>
                        <h1 class="text-2xl font-bold">Database Viewer</h1>
                        <p class="text-white/80">Smart Classroom System Data</p>
                    </div>
                </div>
                <div class="flex space-x-4">
                    <a href="/admin" class="bg-white/20 hover:bg-white/30 text-white px-4 py-2 rounded-lg transition-colors">Admin</a>
                    <a href="/student" class="bg-white/20 hover:bg-white/30 text-white px-4 py-2 rounded-lg transition-colors">Student</a>
                    <a href="/history" class="bg-white/20 hover:bg-white/30 text-white px-4 py-2 rounded-lg transition-colors">History</a>
                </div>
            </div>
        </div>
    </header>

    <main class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div class="text-center py-16">
            <div class="w-24 h-24 mx-auto bg-gradient-to-br from-blue-100 to-indigo-200 rounded-full flex items-center justify-center mb-6">
                <svg class="w-12 h-12 text-indigo-600" fill="currentColor" viewBox="0 0 20 20">
                    <path d="M3 4a1 1 0 011-1h12a1 1 0 011 1v2a1 1 0 01-1 1H4a1 1 0 01-1-1V4zM3 10a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H4a1 1 0 01-1-1v-6zM14 9a1 1 0 00-1 1v6a1 1 0 001 1h2a1 1 0 001-1v-6a1 1 0 00-1-1h-2z"/>
                </svg>
            </div>
            <h3 class="text-xl font-semibold text-gray-900 mb-4">Database Viewer</h3>
            <p class="text-gray-600 max-w-md mx-auto mb-8">This is a raw database viewer for technical debugging. For a better user experience, try the dedicated History page.</p>
            <div class="flex justify-center space-x-4">
                <a href="/history" class="bg-indigo-600 hover:bg-indigo-700 text-white px-6 py-3 rounded-lg font-semibold transition-colors">
                    📚 Go to History Page
                </a>
                <button onclick="loadRawData()" class="bg-gray-600 hover:bg-gray-700 text-white px-6 py-3 rounded-lg font-semibold transition-colors">
                    🛠️ Load Raw Data
                </button>
            </div>
        </div>

        <div id="rawData" class="hidden space-y-6">
            <!-- Raw data will be loaded here -->
        </div>
    </main>

    <script>
        async function loadRawData() {
            const rawDataDiv = document.getElementById('rawData');
            rawDataDiv.classList.remove('hidden');
            
            try {
                const response = await fetch('/api/history?includeTranscripts=true&includeSummaries=true&limit=10');
                const data = await response.json();
                
                rawDataDiv.innerHTML = \`
                    <div class="bg-white rounded-xl shadow-lg border border-gray-200 overflow-hidden">
                        <div class="px-6 py-4 bg-gray-50 border-b border-gray-200">
                            <h3 class="text-lg font-semibold text-gray-900">Raw Database Data</h3>
                        </div>
                        <div class="p-6">
                            <pre class="bg-gray-100 rounded-lg p-4 text-sm overflow-auto max-h-96">\${JSON.stringify(data, null, 2)}</pre>
                        </div>
                    </div>
                \`;
            } catch (error) {
                rawDataDiv.innerHTML = \`
                    <div class="bg-red-50 border border-red-200 rounded-lg p-6">
                        <h3 class="text-lg font-semibold text-red-800 mb-2">Error Loading Data</h3>
                        <p class="text-red-600">\${error.message}</p>
                    </div>
                \`;
            }
        }
    </script>
</body>
</html>
  `);
});

/* Serve history page */
app.get("/history", (req, res) => {
  console.log("📚 Serving history page");
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Session History - Smart Classroom</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');
        body { font-family: 'Inter', sans-serif; }
        .gradient-bg { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); }
        .session-card { transition: all 0.3s ease; }
        .session-card:hover { transform: translateY(-2px); box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04); }
    </style>
</head>
<body class="bg-gray-50 min-h-screen">
    <header class="gradient-bg text-white shadow-xl">
        <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
            <div class="flex items-center justify-between">
                <div class="flex items-center space-x-4">
                    <div class="w-12 h-12 bg-white/20 rounded-xl flex items-center justify-center">
                        <svg class="w-7 h-7" fill="currentColor" viewBox="0 0 20 20">
                            <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>
                        </svg>
                    </div>
                    <div>
                        <h1 class="text-2xl font-bold">Session History</h1>
                        <p class="text-white/80">Browse past classroom sessions</p>
                    </div>
                </div>
                <div class="flex space-x-4">
                    <a href="/admin" class="bg-white/20 hover:bg-white/30 text-white px-4 py-2 rounded-lg transition-colors">👨‍🏫 Admin</a>
                    <a href="/student" class="bg-white/20 hover:bg-white/30 text-white px-4 py-2 rounded-lg transition-colors">👨‍🎓 Student</a>
                    <a href="/database" class="bg-white/20 hover:bg-white/30 text-white px-4 py-2 rounded-lg transition-colors">🗄️ Database</a>
                </div>
            </div>
        </div>
    </header>

    <main class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <!-- Search and Filters -->
        <div class="bg-white rounded-xl shadow-lg border border-gray-200 p-6 mb-8">
            <div class="flex flex-col md:flex-row md:items-center md:justify-between space-y-4 md:space-y-0">
                <div class="flex flex-col md:flex-row space-y-4 md:space-y-0 md:space-x-4">
                    <div>
                        <label for="sessionSearch" class="block text-sm font-medium text-gray-700 mb-1">Search Sessions</label>
                        <input 
                            type="text" 
                            id="sessionSearch" 
                            placeholder="Enter session code..." 
                            class="border border-gray-300 rounded-lg px-4 py-2 w-48 focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                        >
                    </div>
                    <div>
                        <label for="dateFrom" class="block text-sm font-medium text-gray-700 mb-1">From Date</label>
                        <input 
                            type="date" 
                            id="dateFrom" 
                            class="border border-gray-300 rounded-lg px-4 py-2 focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                        >
                    </div>
                    <div>
                        <label for="dateTo" class="block text-sm font-medium text-gray-700 mb-1">To Date</label>
                        <input 
                            type="date" 
                            id="dateTo" 
                            class="border border-gray-300 rounded-lg px-4 py-2 focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                        >
                    </div>
                </div>
                <div class="flex space-x-3">
                    <button onclick="searchSessions()" class="bg-indigo-600 hover:bg-indigo-700 text-white px-6 py-2 rounded-lg font-semibold transition-colors">
                        🔍 Search
                    </button>
                    <button onclick="clearSearch()" class="bg-gray-600 hover:bg-gray-700 text-white px-6 py-2 rounded-lg font-semibold transition-colors">
                        🗑️ Clear
                    </button>
                </div>
            </div>
        </div>

        <!-- Loading State -->
        <div id="loading" class="text-center py-12">
            <div class="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600 mx-auto mb-4"></div>
            <p class="text-gray-600">Loading sessions...</p>
        </div>

        <!-- Sessions Grid -->
        <div id="sessionsContainer" class="hidden">
            <div class="flex items-center justify-between mb-6">
                <h2 id="sessionsTitle" class="text-xl font-semibold text-gray-900">Recent Sessions</h2>
                <div id="sessionStats" class="text-sm text-gray-600"></div>
            </div>
            <div id="sessionsGrid" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                <!-- Session cards will be inserted here -->
            </div>
            <div id="pagination" class="mt-8 flex justify-center">
                <!-- Pagination will be inserted here -->
            </div>
        </div>

        <!-- Session Detail Modal -->
        <div id="sessionModal" class="fixed inset-0 bg-black bg-opacity-50 hidden items-center justify-center z-50 p-4">
            <div class="bg-white rounded-xl shadow-2xl max-w-6xl w-full max-h-screen overflow-y-auto">
                <div id="modalContent">
                    <!-- Session details will be loaded here -->
                </div>
            </div>
        </div>
    </main>

    <script>
        let currentPage = 0;
        let currentLimit = 12;
        let currentFilters = {};

        // Initialize page
        document.addEventListener('DOMContentLoaded', () => {
            loadSessions();
        });

        function showLoading() {
            document.getElementById('loading').classList.remove('hidden');
            document.getElementById('sessionsContainer').classList.add('hidden');
        }

        function hideLoading() {
            document.getElementById('loading').classList.add('hidden');
            document.getElementById('sessionsContainer').classList.remove('hidden');
        }

        async function loadSessions(page = 0, filters = {}) {
            showLoading();
            currentPage = page;
            currentFilters = filters;

            try {
                const params = new URLSearchParams({
                    limit: currentLimit,
                    offset: page * currentLimit,
                    ...filters
                });

                const response = await fetch(\`/api/history?\${params}\`);
                const data = await response.json();

                displaySessions(data);
                displayPagination(data.pagination);
                updateStats(data);
            } catch (error) {
                document.getElementById('sessionsContainer').innerHTML = \`
                    <div class="bg-red-50 border border-red-200 rounded-lg p-6">
                        <h3 class="text-lg font-semibold text-red-800 mb-2">Error Loading Sessions</h3>
                        <p class="text-red-600">\${error.message}</p>
                    </div>
                \`;
            }
            hideLoading();
        }

        function displaySessions(data) {
            const container = document.getElementById('sessionsGrid');
            
            if (data.sessions.length === 0) {
                container.innerHTML = \`
                    <div class="col-span-full text-center py-12">
                        <svg class="w-16 h-16 mx-auto mb-4 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
                        </svg>
                        <h3 class="text-lg font-semibold text-gray-900 mb-2">No Sessions Found</h3>
                        <p class="text-gray-600">Try adjusting your search criteria or date range.</p>
                    </div>
                \`;
                return;
            }

            container.innerHTML = data.sessions.map(session => \`
                <div class="session-card bg-white rounded-xl shadow-lg border border-gray-200 overflow-hidden cursor-pointer" 
                     onclick="viewSessionDetails('\${session.code}')">
                    <div class="p-6">
                        <div class="flex items-center justify-between mb-4">
                            <div class="flex items-center space-x-3">
                                <div class="w-12 h-12 bg-gradient-to-br from-indigo-500 to-purple-600 rounded-lg flex items-center justify-center">
                                    <span class="text-white font-bold text-lg">\${session.code.slice(-2)}</span>
                                </div>
                                <div>
                                    <h3 class="text-lg font-semibold text-gray-900">Session \${session.code}</h3>
                                    <p class="text-sm text-gray-600">\${new Date(session.created_at).toLocaleDateString()}</p>
                                </div>
                            </div>
                            <span class="px-3 py-1 text-xs font-semibold rounded-full \${session.active ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'}">
                                \${session.active ? 'Active' : 'Completed'}
                            </span>
                        </div>
                        
                        <div class="grid grid-cols-2 gap-4 mb-4">
                            <div class="text-center p-3 bg-blue-50 rounded-lg">
                                <div class="text-xl font-bold text-blue-600">\${session.group_count || 0}</div>
                                <div class="text-xs text-gray-600">Groups</div>
                            </div>
                            <div class="text-center p-3 bg-green-50 rounded-lg">
                                <div class="text-xl font-bold text-green-600">\${session.total_transcripts || 0}</div>
                                <div class="text-xs text-gray-600">Transcripts</div>
                            </div>
                        </div>
                        
                        <div class="grid grid-cols-2 gap-4 text-sm text-gray-600">
                            <div>
                                <span class="font-medium">Words:</span> \${session.total_words || 0}
                            </div>
                            <div>
                                <span class="font-medium">Duration:</span> \${formatDuration(session.total_duration || 0)}
                            </div>
                        </div>
                        
                        <div class="mt-4 text-xs text-gray-500">
                            <span class="font-medium">Created:</span> \${new Date(session.created_at).toLocaleString()}
                        </div>
                    </div>
                    
                    <div class="px-6 py-3 bg-gray-50 border-t border-gray-200">
                        <div class="flex items-center justify-between">
                            <span class="text-sm text-gray-600">Interval: \${session.interval_seconds}s</span>
                            <span class="text-indigo-600 font-medium text-sm">View Details →</span>
                        </div>
                    </div>
                </div>
            \`).join('');
        }

        function displayPagination(pagination) {
            const container = document.getElementById('pagination');
            const totalPages = Math.ceil((pagination.offset + pagination.limit) / pagination.limit) + (pagination.hasMore ? 1 : 0);
            
            if (totalPages <= 1) {
                container.innerHTML = '';
                return;
            }

            container.innerHTML = \`
                <div class="flex space-x-2">
                    <button 
                        onclick="loadSessions(\${currentPage - 1}, currentFilters)" 
                        \${currentPage === 0 ? 'disabled' : ''}
                        class="px-4 py-2 border border-gray-300 rounded-lg \${currentPage === 0 ? 'bg-gray-100 text-gray-400 cursor-not-allowed' : 'bg-white text-gray-700 hover:bg-gray-50'}"
                    >
                        Previous
                    </button>
                    
                    <span class="px-4 py-2 bg-indigo-600 text-white rounded-lg">
                        Page \${currentPage + 1}
                    </span>
                    
                    <button 
                        onclick="loadSessions(\${currentPage + 1}, currentFilters)" 
                        \${!pagination.hasMore ? 'disabled' : ''}
                        class="px-4 py-2 border border-gray-300 rounded-lg \${!pagination.hasMore ? 'bg-gray-100 text-gray-400 cursor-not-allowed' : 'bg-white text-gray-700 hover:bg-gray-50'}"
                    >
                        Next
                    </button>
                </div>
            \`;
        }

        function updateStats(data) {
            const stats = document.getElementById('sessionStats');
            const totalSessions = data.sessions.length;
            const activeSessions = data.sessions.filter(s => s.active).length;
            
            stats.textContent = \`\${totalSessions} sessions found (\${activeSessions} active)\`;
        }

        function searchSessions() {
            const filters = {};
            
            const sessionCode = document.getElementById('sessionSearch').value.trim();
            if (sessionCode) filters.sessionCode = sessionCode;
            
            const dateFrom = document.getElementById('dateFrom').value;
            if (dateFrom) filters.startDate = dateFrom;
            
            const dateTo = document.getElementById('dateTo').value;
            if (dateTo) filters.endDate = dateTo;
            
            loadSessions(0, filters);
        }

        function clearSearch() {
            document.getElementById('sessionSearch').value = '';
            document.getElementById('dateFrom').value = '';
            document.getElementById('dateTo').value = '';
            loadSessions(0, {});
        }

        async function viewSessionDetails(sessionCode) {
            const modal = document.getElementById('sessionModal');
            const content = document.getElementById('modalContent');
            
            modal.classList.remove('hidden');
            modal.classList.add('flex');
            
            content.innerHTML = \`
                <div class="p-6">
                    <div class="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600 mx-auto mb-4"></div>
                    <p class="text-center text-gray-600">Loading session details...</p>
                </div>
            \`;

            try {
                const response = await fetch(\`/api/history/session/\${sessionCode}\`);
                const data = await response.json();
                
                content.innerHTML = \`
                    <div class="relative">
                        <button onclick="closeModal()" class="absolute top-4 right-4 text-gray-400 hover:text-gray-600 z-10">
                            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
                            </svg>
                        </button>
                        
                        <div class="p-6 border-b border-gray-200">
                            <h2 class="text-2xl font-bold text-gray-900">Session \${data.session.code}</h2>
                            <p class="text-gray-600 mt-1">Created: \${new Date(data.session.created_at).toLocaleString()}</p>
                            <div class="flex items-center space-x-4 mt-3 text-sm">
                                <span class="px-3 py-1 bg-indigo-100 text-indigo-800 rounded-full">
                                    Interval: \${data.session.interval_seconds}s
                                </span>
                                <span class="px-3 py-1 \${data.session.active ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'} rounded-full">
                                    \${data.session.active ? 'Active' : 'Completed'}
                                </span>
                            </div>
                        </div>
                        
                        <div class="p-6 border-b border-gray-200">
                            <div class="grid grid-cols-1 md:grid-cols-4 gap-4">
                                <div class="bg-blue-50 rounded-lg p-4 text-center">
                                    <div class="text-2xl font-bold text-blue-600">\${data.groups.length}</div>
                                    <div class="text-sm text-gray-600">Groups</div>
                                </div>
                                <div class="bg-green-50 rounded-lg p-4 text-center">
                                    <div class="text-2xl font-bold text-green-600">\${data.groups.reduce((sum, g) => sum + g.stats.totalSegments, 0)}</div>
                                    <div class="text-sm text-gray-600">Total Segments</div>
                                </div>
                                <div class="bg-purple-50 rounded-lg p-4 text-center">
                                    <div class="text-2xl font-bold text-purple-600">\${data.groups.reduce((sum, g) => sum + g.stats.totalWords, 0)}</div>
                                    <div class="text-sm text-gray-600">Total Words</div>
                                </div>
                                <div class="bg-yellow-50 rounded-lg p-4 text-center">
                                    <div class="text-2xl font-bold text-yellow-600">\${formatDuration(data.groups.reduce((sum, g) => sum + g.stats.totalDuration, 0))}</div>
                                    <div class="text-sm text-gray-600">Total Duration</div>
                                </div>
                            </div>
                        </div>
                        
                        <div class="p-6 max-h-96 overflow-y-auto">
                            <h3 class="text-lg font-semibold text-gray-900 mb-4">Groups (\${data.groups.length})</h3>
                            <div class="space-y-6">
                                \${data.groups.map(group => \`
                                    <div class="border border-gray-200 rounded-lg overflow-hidden">
                                        <div class="px-4 py-3 bg-gray-50 border-b border-gray-200">
                                            <div class="flex items-center justify-between">
                                                <h4 class="font-semibold text-gray-900">Group \${group.number}</h4>
                                                <div class="flex space-x-4 text-sm text-gray-600">
                                                    <span>\${group.stats.totalSegments} segments</span>
                                                    <span>\${group.stats.totalWords} words</span>
                                                    <span>\${formatDuration(group.stats.totalDuration)}</span>
                                                </div>
                                            </div>
                                        </div>
                                        <div class="p-4">
                                            \${group.summary ? \`
                                                <div class="mb-4">
                                                    <h5 class="font-medium text-gray-900 mb-2">Summary</h5>
                                                    <div class="bg-purple-50 rounded-lg p-3 border-l-4 border-purple-400">
                                                        <div class="text-gray-800 text-sm leading-relaxed whitespace-pre-line">\${group.summary.text}</div>
                                                    </div>
                                                </div>
                                            \` : ''}
                                            
                                            <div>
                                                <h5 class="font-medium text-gray-900 mb-2">Recent Transcripts</h5>
                                                <div class="space-y-2 max-h-32 overflow-y-auto">
                                                    \${group.transcripts.slice(0, 3).map(transcript => \`
                                                        <div class="bg-gray-50 rounded p-3 text-sm">
                                                            <div class="text-gray-800 mb-1">\${transcript.text}</div>
                                                            <div class="text-xs text-gray-500">
                                                                \${new Date(transcript.created_at).toLocaleString()} • 
                                                                \${transcript.word_count} words • 
                                                                \${transcript.duration_seconds ? transcript.duration_seconds.toFixed(1) + 's' : 'No duration'}
                                                            </div>
                                                        </div>
                                                    \`).join('')}
                                                    \${group.transcripts.length > 3 ? \`
                                                        <div class="text-center text-sm text-gray-500 py-2">
                                                            ... and \${group.transcripts.length - 3} more transcripts
                                                        </div>
                                                    \` : ''}
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                \`).join('')}
                            </div>
                        </div>
                    </div>
                \`;
            } catch (error) {
                content.innerHTML = \`
                    <div class="p-6">
                        <div class="bg-red-50 border border-red-200 rounded-lg p-6">
                            <h3 class="text-lg font-semibold text-red-800 mb-2">Error Loading Session Details</h3>
                            <p class="text-red-600">\${error.message}</p>
                            <button onclick="closeModal()" class="mt-4 bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded-lg">
                                Close
                            </button>
                        </div>
                    </div>
                \`;
            }
        }

        function closeModal() {
            const modal = document.getElementById('sessionModal');
            modal.classList.add('hidden');
            modal.classList.remove('flex');
        }

        function formatDuration(seconds) {
            if (!seconds) return '0:00';
            const mins = Math.floor(seconds / 60);
            const secs = Math.floor(seconds % 60);
            return \`\${mins}:\${secs.toString().padStart(2, '0')}\`;
        }

        // Close modal when clicking outside
        document.getElementById('sessionModal').addEventListener('click', (e) => {
            if (e.target === e.currentTarget) {
                closeModal();
            }
        });

        // Handle escape key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                closeModal();
            }
        });

        // Handle enter key in search
        document.getElementById('sessionSearch').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                searchSessions();
            }
        });
    </script>
</body>
</html>
  `);
});

/* Test transcription API endpoint */
app.post("/api/test-transcription", upload.single('audio'), async (req, res) => {
  try {
    console.log("🧪 Test transcription request received");
    
    if (!req.file) {
      return res.status(400).json({ error: "No audio file provided" });
    }
    
    const audioBuffer = req.file.buffer;
    console.log(`📁 Received audio file: ${audioBuffer.length} bytes, mimetype: ${req.file.mimetype}`);
    
    // Test the transcription function
    const startTime = Date.now();
    const transcription = await transcribe(audioBuffer);
    const endTime = Date.now();
    
    const debug = {
      fileSize: audioBuffer.length,
      mimeType: req.file.mimetype,
      processingTime: `${endTime - startTime}ms`,
      timestamp: new Date().toISOString()
    };
    
    console.log(`✅ Test transcription completed in ${endTime - startTime}ms`);
    
    res.json({
      success: true,
      transcription,
      debug
    });
    
  } catch (err) {
    console.error("❌ Test transcription error:", err);
    res.status(500).json({ 
      error: "Transcription failed", 
      details: err.message,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  }
});

/* Test summary API endpoint */
app.post("/api/test-summary", express.json(), async (req, res) => {
  try {
    console.log("🧪 Test summary request received");
    
    const { text, customPrompt } = req.body;
    if (!text) {
      return res.status(400).json({ error: "No text provided for summarization" });
    }
    
    console.log(`📝 Received text for summarization (${text.length} characters)`);
    
    // Test the summary function with custom prompt
    const startTime = Date.now();
    const summary = await summarise(text, customPrompt);
    const endTime = Date.now();
    
    const debug = {
      textLength: text.length,
      processingTime: `${endTime - startTime}ms`,
      timestamp: new Date().toISOString(),
      promptUsed: customPrompt || "default"
    };
    
    console.log(`✅ Test summary completed in ${endTime - startTime}ms`);
    
    res.json({
      success: true,
      summary,
      debug
    });
    
  } catch (err) {
    console.error("❌ Test summary error:", err);
    res.status(500).json({ 
      error: "Summary failed", 
      details: err.message,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  }
});

/* Session prompt management endpoints */
app.post("/api/session/:code/prompt", express.json(), (req, res) => {
  try {
    const { code } = req.params;
    const { prompt } = req.body;
    
    if (!prompt || !prompt.trim()) {
      return res.status(400).json({ error: "Prompt is required" });
    }
    
    // Get session ID
    const session = db.prepare("SELECT id FROM sessions WHERE code=?").get(code);
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }
    
    // Save prompt for this session
    db.prepare(`
      INSERT OR REPLACE INTO session_prompts (session_id, prompt, updated_at)
      VALUES (?, ?, ?)
    `).run(session.id, prompt.trim(), Date.now());
    
    console.log(`💾 Saved custom prompt for session ${code}`);
    res.json({ success: true, message: "Prompt saved successfully" });
    
  } catch (err) {
    console.error("❌ Failed to save prompt:", err);
    res.status(500).json({ error: "Failed to save prompt" });
  }
});

app.get("/api/session/:code/prompt", (req, res) => {
  try {
    const { code } = req.params;
    
    // Get session ID
    const session = db.prepare("SELECT id FROM sessions WHERE code=?").get(code);
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }
    
    // Get prompt for this session
    const promptData = db.prepare(`
      SELECT prompt, updated_at FROM session_prompts WHERE session_id=?
    `).get(session.id);
    
    if (promptData) {
      res.json({ 
        prompt: promptData.prompt,
        updatedAt: promptData.updated_at
      });
    } else {
      res.json({ 
        prompt: null,
        message: "No custom prompt set for this session"
      });
    }
    
  } catch (err) {
    console.error("❌ Failed to load prompt:", err);
    res.status(500).json({ error: "Failed to load prompt" });
  }
});

/* Admin API: create new session */
app.get("/api/new-session", (req, res) => {
  try {
  const id   = uuid();
  const code = Math.floor(100000 + Math.random() * 900000).toString();
    const interval = Number(req.query.interval) || 30000; // Changed default to 30 seconds
    
    // Clear any existing session with same code (unlikely but safe)
    stopAutoSummary(code);
    activeSessions.delete(code);
    
    db.prepare("INSERT INTO sessions (id, code, interval_ms, created_at, active) VALUES (?,?,?,?,0)")
      .run(id, code, interval, Date.now());
    
    // Store session in memory
    activeSessions.set(code, {
      id,
      code,
      active: false,
      interval,
      startTime: null
    });
    
    console.log(`🆕 New session created: Code=${code}, Interval=${interval}ms`);
    res.json({ code, interval });
  } catch (err) {
    console.error("❌ Failed to create session:", err);
    res.status(500).json({ error: "Failed to create session" });
  }
});

/* Get session status */
app.get("/api/session/:code/status", (req, res) => {
  try {
    const code = req.params.code;
    const sessionState = activeSessions.get(code);
    
    if (!sessionState) {
      // Check database for session
      const dbSession = db.prepare("SELECT * FROM sessions WHERE code=?").get(code);
      if (dbSession) {
        // Restore session to memory
        activeSessions.set(code, {
          id: dbSession.id,
          code: dbSession.code,
          active: !!dbSession.active,
          interval: dbSession.interval_ms || 30000, // Changed default to 30 seconds
          startTime: dbSession.active ? Date.now() : null
        });
        
        // If session was active, restart auto-summary
        if (dbSession.active) {
          startAutoSummary(code, dbSession.interval_ms || 30000); // Changed default to 30 seconds
          console.log(`🔄 Restored active session: ${code}`);
        }
        
        res.json(activeSessions.get(code));
      } else {
        res.status(404).json({ error: "Session not found" });
      }
    } else {
      res.json(sessionState);
    }
  } catch (err) {
    console.error("❌ Failed to get session status:", err);
    res.status(500).json({ error: "Failed to get session status" });
  }
});

/* Admin API: start/stop session */
app.post("/api/session/:code/start", express.json(), (req, res) => {
  try {
    const { interval } = req.body;
    const code = req.params.code;
    
    db.prepare("UPDATE sessions SET active=1, interval_ms=? WHERE code=?").run(interval || 30000, code); // Changed default to 30 seconds
    
    // Update memory state
    const sessionState = activeSessions.get(code);
    if (sessionState) {
      sessionState.active = true;
      sessionState.interval = interval || 30000; // Changed default to 30 seconds
      sessionState.startTime = Date.now();
    }
    
    io.to(code).emit("record_now", interval || 30000); // Changed default to 30 seconds
    
    // Start automatic summary generation - use same interval as recording
    startAutoSummary(code, interval || 30000); // Changed default to 30 seconds
    
    console.log(`▶️  Session ${code} started recording (interval: ${interval || 30000}ms)`);
    res.json({ ok: true });
  } catch (err) {
    console.error("❌ Failed to start session:", err);
    res.status(500).json({ error: "Failed to start session" });
  }
});

app.post("/api/session/:code/stop", (req, res) => {
  try {
    const code = req.params.code;
    
    db.prepare("UPDATE sessions SET active=0 WHERE code=?").run(code);
    
    // Update memory state
    const sessionState = activeSessions.get(code);
    if (sessionState) {
      sessionState.active = false;
      sessionState.startTime = null;
    }
    
    io.to(code).emit("stop_recording");
    
    // Stop automatic summary generation
    stopAutoSummary(code);
    
    console.log(`⏹️  Session ${code} stopped recording`);
    res.json({ ok: true });
  } catch (err) {
    console.error("❌ Failed to stop session:", err);
    res.status(500).json({ error: "Failed to stop session" });
  }
});

/* Admin API: get group transcripts and summary */
app.get("/api/session/:code/group/:number/transcripts", (req, res) => {
  try {
    const { code, number } = req.params;
    console.log(`📊 Fetching transcripts for session ${code}, group ${number}`);
    
    // Get session and group IDs
    const session = db.prepare("SELECT id FROM sessions WHERE code=?").get(code);
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }
    
    const group = db.prepare("SELECT id FROM groups WHERE session_id=? AND number=?")
      .get(session.id, number);
    if (!group) {
      return res.status(404).json({ error: "Group not found" });
    }
    
    // Get all transcripts for this group
    const transcripts = db.prepare(`
      SELECT 
        text,
        word_count,
        duration_seconds,
        segment_number,
        created_at
      FROM transcripts 
      WHERE group_id = ? 
      ORDER BY created_at DESC
      LIMIT 50
    `).all(group.id);
    
    // Get the latest summary
    const summary = db.prepare(`
      SELECT text, updated_at
      FROM summaries
      WHERE group_id = ?
    `).get(group.id);
    
    // Get some stats
    const stats = db.prepare(`
      SELECT 
        COUNT(*) as total_segments,
        SUM(word_count) as total_words,
        SUM(duration_seconds) as total_duration,
        MAX(created_at) as last_update
      FROM transcripts
      WHERE group_id = ?
    `).get(group.id);
    
    res.json({
      transcripts,
      summary: summary || { text: "No summary available", updated_at: null },
      stats: {
        totalSegments: stats.total_segments,
        totalWords: stats.total_words,
        totalDuration: stats.total_duration,
        lastUpdate: stats.last_update
      }
    });
    
  } catch (err) {
    console.error("❌ Failed to fetch transcripts:", err);
    res.status(500).json({ error: "Failed to fetch transcripts" });
  }
});

/* Admin API: get historical data */
app.get("/api/history", (req, res) => {
  try {
    const { 
      sessionCode, 
      startDate, 
      endDate, 
      limit = 50, 
      offset = 0,
      includeTranscripts = 'true',
      includeSummaries = 'true'
    } = req.query;
    
    console.log(`📊 Fetching historical data with filters:`, { sessionCode, startDate, endDate, limit, offset });
    
    let sessionFilter = "";
    let params = [];
    
    if (sessionCode) {
      sessionFilter = " AND s.code = ?";
      params.push(sessionCode);
    }
    
    if (startDate) {
      sessionFilter += " AND s.created_at >= ?";
      params.push(new Date(startDate).getTime());
    }
    
    if (endDate) {
      sessionFilter += " AND s.created_at <= ?";
      params.push(new Date(endDate).getTime());
    }
    
    // Get sessions with basic info
    const sessions = db.prepare(`
      SELECT 
        s.id,
        s.code,
        s.interval_ms,
        s.created_at,
        s.active,
        COUNT(DISTINCT g.id) as group_count,
        COUNT(DISTINCT t.id) as total_transcripts,
        SUM(t.word_count) as total_words,
        SUM(t.duration_seconds) as total_duration
      FROM sessions s
      LEFT JOIN groups g ON s.id = g.session_id
      LEFT JOIN transcripts t ON g.id = t.group_id
      WHERE 1=1 ${sessionFilter}
      GROUP BY s.id, s.code, s.interval_ms, s.created_at, s.active
      ORDER BY s.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, parseInt(limit), parseInt(offset));
    
    const result = {
      sessions: sessions.map(session => ({
        ...session,
        created_at: new Date(session.created_at).toISOString(),
        interval_seconds: session.interval_ms / 1000,
        groups: []
      })),
      pagination: {
        limit: parseInt(limit),
        offset: parseInt(offset),
        hasMore: sessions.length === parseInt(limit)
      }
    };
    
    // For each session, get detailed group data if requested
    if (includeTranscripts === 'true' || includeSummaries === 'true') {
      for (const session of result.sessions) {
        // Get groups for this session
        const groups = db.prepare(`
          SELECT id, number FROM groups WHERE session_id = ? ORDER BY number
        `).all(session.id);
        
        for (const group of groups) {
          const groupData = {
            number: group.number,
            transcripts: [],
            summary: null,
            stats: {
              totalSegments: 0,
              totalWords: 0,
              totalDuration: 0
            }
          };
          
          if (includeTranscripts === 'true') {
            // Get transcripts for this group
            groupData.transcripts = db.prepare(`
              SELECT 
                text,
                word_count,
                duration_seconds,
                segment_number,
                created_at
              FROM transcripts 
              WHERE group_id = ? 
              ORDER BY created_at ASC
            `).all(group.id).map(t => ({
              ...t,
              created_at: new Date(t.created_at).toISOString()
            }));
            
            // Calculate stats
            groupData.stats = {
              totalSegments: groupData.transcripts.length,
              totalWords: groupData.transcripts.reduce((sum, t) => sum + (t.word_count || 0), 0),
              totalDuration: groupData.transcripts.reduce((sum, t) => sum + (t.duration_seconds || 0), 0)
            };
          }
          
          if (includeSummaries === 'true') {
            // Get summary for this group
            const summary = db.prepare(`
              SELECT text, updated_at FROM summaries WHERE group_id = ?
            `).get(group.id);
            
            if (summary) {
              groupData.summary = {
                text: summary.text,
                updated_at: new Date(summary.updated_at).toISOString()
              };
            }
          }
          
          session.groups.push(groupData);
        }
      }
    }
    
    res.json(result);
    
  } catch (err) {
    console.error("❌ Failed to fetch historical data:", err);
    res.status(500).json({ error: "Failed to fetch historical data" });
  }
});

/* Admin API: get specific session details */
app.get("/api/history/session/:code", (req, res) => {
  try {
    const { code } = req.params;
    console.log(`📋 Fetching detailed data for session: ${code}`);
    
    // Get session info
    const session = db.prepare(`
      SELECT id, code, interval_ms, created_at, active FROM sessions WHERE code = ?
    `).get(code);
    
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }
    
    // Get all groups for this session
    const groups = db.prepare(`
      SELECT id, number FROM groups WHERE session_id = ? ORDER BY number
    `).all(session.id);
    
    const result = {
      session: {
        ...session,
        created_at: new Date(session.created_at).toISOString(),
        interval_seconds: session.interval_ms / 1000
      },
      groups: []
    };
    
    for (const group of groups) {
      // Get all transcripts
      const transcripts = db.prepare(`
        SELECT 
          text,
          word_count,
          duration_seconds,
          segment_number,
          created_at
        FROM transcripts 
        WHERE group_id = ? 
        ORDER BY created_at ASC
      `).all(group.id);
      
      // Get summary
      const summary = db.prepare(`
        SELECT text, updated_at FROM summaries WHERE group_id = ?
      `).get(group.id);
      
      const groupData = {
        number: group.number,
        transcripts: transcripts.map(t => ({
          ...t,
          created_at: new Date(t.created_at).toISOString()
        })),
        summary: summary ? {
          text: summary.text,
          updated_at: new Date(summary.updated_at).toISOString()
        } : null,
        stats: {
          totalSegments: transcripts.length,
          totalWords: transcripts.reduce((sum, t) => sum + (t.word_count || 0), 0),
          totalDuration: transcripts.reduce((sum, t) => sum + (t.duration_seconds || 0), 0),
          firstTranscript: transcripts.length > 0 ? new Date(transcripts[0].created_at).toISOString() : null,
          lastTranscript: transcripts.length > 0 ? new Date(transcripts[transcripts.length - 1].created_at).toISOString() : null
        }
      };
      
      result.groups.push(groupData);
    }
    
    res.json(result);
    
  } catch (err) {
    console.error("❌ Failed to fetch session details:", err);
    res.status(500).json({ error: "Failed to fetch session details" });
  }
});

/* ---------- Auto-summary management ---------- */
const activeSummaryTimers = new Map();

function startAutoSummary(sessionCode, intervalMs) {
  // Clear any existing timer for this session
  stopAutoSummary(sessionCode);
  
  const timer = setInterval(async () => {
    console.log(`⏰ Auto-generating summaries for session ${sessionCode}`);
    
    // Check if session is still active (both in memory and database)
    const sessionState = activeSessions.get(sessionCode);
    const session = db.prepare("SELECT id FROM sessions WHERE code=? AND active=1").get(sessionCode);
    
    if (!session || !sessionState?.active) {
      console.log(`⚠️  Session ${sessionCode} no longer active, stopping auto-summary`);
      stopAutoSummary(sessionCode);
      return;
    }
    
    const groups = db.prepare("SELECT number FROM groups WHERE session_id=?").all(session.id);
    console.log(`🔄 Processing summaries for ${groups.length} groups in session ${sessionCode}`);
    
    for (const group of groups) {
      await generateSummaryForGroup(sessionCode, group.number);
    }
  }, intervalMs); // Use the same interval as recording instead of fixed 10 seconds
  
  activeSummaryTimers.set(sessionCode, timer);
  console.log(`⏰ Started auto-summary timer for session ${sessionCode} (every ${intervalMs}ms)`);
}

function stopAutoSummary(sessionCode) {
  const timer = activeSummaryTimers.get(sessionCode);
  if (timer) {
    clearInterval(timer);
    activeSummaryTimers.delete(sessionCode);
    console.log(`⏰ Stopped auto-summary timer for session ${sessionCode}`);
  }
}

async function generateSummaryForGroup(sessionCode, groupNumber) {
  try {
    console.log(`📋 Processing group ${groupNumber} in session ${sessionCode}`);
    
    // Find sockets in this group and get their audio data
    const roomName = `${sessionCode}-${groupNumber}`;
    const socketsInRoom = await io.in(roomName).fetchSockets();
    
    if (socketsInRoom.length === 0) {
      console.log(`ℹ️  No active sockets in group ${groupNumber}, skipping`);
      return;
    }
    
    // Collect audio from all sockets in this group
    let hasAudio = false;
    let combinedAudio = [];
    
    for (const socket of socketsInRoom) {
      if (socket.localBuf && socket.localBuf.length > 0) {
        combinedAudio.push(...socket.localBuf);
        socket.localBuf = []; // Clear the buffer after processing
        hasAudio = true;
      }
    }
    
    if (!hasAudio) {
      console.log(`ℹ️  No audio data available for group ${groupNumber}, skipping`);
      return;
    }
    
    const audio = Buffer.concat(combinedAudio);
    console.log(`🔄 Processing ${audio.length} bytes of audio data for group ${groupNumber}`);
    
    // Get transcription for ONLY this current audio chunk
    console.log("🗣️  Starting transcription for current chunk...");
    const transcription = await transcribe(audio);
    
    // Only proceed if we have valid transcription
    if (transcription.text && transcription.text !== "No transcription available" && transcription.text !== "Transcription failed") {
      console.log(`📝 Transcription for group ${groupNumber}:`, {
        text: transcription.text,
        duration: transcription.words.length > 0 ? 
          transcription.words[transcription.words.length - 1].end : 0,
        wordCount: transcription.words.length
      });
      
      // Save this individual transcription segment
      const session = db.prepare("SELECT id FROM sessions WHERE code=?").get(sessionCode);
      const group = db.prepare("SELECT id FROM groups WHERE session_id=? AND number=?").get(session.id, groupNumber);
      
      if (group) {
        // Save the transcription segment
        const now = Date.now();
        const transcriptId = uuid();
        
        // Calculate word count and duration with fallbacks
        const wordCount = transcription.words && transcription.words.length > 0 ? 
          transcription.words.length : 
          transcription.text.split(' ').filter(w => w.trim().length > 0).length;
        
        const duration = transcription.words && transcription.words.length > 0 ? 
          transcription.words[transcription.words.length - 1].end : 
          Math.max(10, Math.min(30, transcription.text.length * 0.05)); // Estimate 0.05 seconds per character
        
        db.prepare(`
          INSERT INTO transcripts (
            id, group_id, text, word_count, duration_seconds, 
            created_at, segment_number
          ) VALUES (?,?,?,?,?,?,?)
        `).run(
          transcriptId,
          group.id,
          transcription.text,
          wordCount,
          duration,
          now,
          Math.floor(now / 30000) // Update segment tracking for new interval
        );
        
        // Get all transcripts for this group to create summary of FULL conversation
        const allTranscripts = db.prepare(`
          SELECT text, word_count, duration_seconds
          FROM transcripts 
          WHERE group_id = ? 
          ORDER BY created_at ASC
        `).all(group.id);
        
        // Combine all transcripts for summary (but only transcribe current chunk)
        const fullText = allTranscripts.map(t => t.text).join(' ');
        
        // Generate summary of the entire conversation so far
        console.log("🤖 Generating summary of full conversation...");
        
        // Get custom prompt for this session
        let customPrompt = null;
        if (session) {
          const promptData = db.prepare("SELECT prompt FROM session_prompts WHERE session_id=?").get(session.id);
          customPrompt = promptData?.prompt || null;
        }
        
        const summary = await summarise(fullText, customPrompt);
        
        // Save/update the summary
        db.prepare(`
          INSERT OR REPLACE INTO summaries (
            group_id, text, updated_at
          ) VALUES (?,?,?)
        `).run(group.id, summary, now);
        
        // Send both new transcription and updated summary to clients
        io.to(roomName).emit("transcription_and_summary", {
          transcription: {
            text: transcription.text,
            words: transcription.words,
            duration: duration,
            wordCount: wordCount
          },
          summary,
          isLatestSegment: true
        });
        
        // Send update to admin console
        io.to(sessionCode).emit("admin_update", {
          group: groupNumber,
          latestTranscript: transcription.text,
          transcriptDuration: duration,
          transcriptWordCount: wordCount,
          summary,
          stats: {
            totalSegments: allTranscripts.length,
            totalWords: allTranscripts.reduce((sum, t) => sum + (t.word_count || 0), 0),
            totalDuration: allTranscripts.reduce((sum, t) => sum + (t.duration_seconds || 0), 0),
            lastUpdate: now
          }
        });
        
        console.log(`✅ Results saved and sent for session ${sessionCode}, group ${groupNumber}`);
      }
    } else {
      console.log(`⚠️  No valid transcription for group ${groupNumber}`);
    }
    
  } catch (err) {
    console.error(`❌ Error processing group ${groupNumber}:`, err);
  }
}

/* ---------- 3. WebSocket flow ---------- */
io.on("connection", socket => {
  console.log(`🔌 New socket connection: ${socket.id}`);
  let groupId, localBuf = [], sessionCode, groupNumber;
  
  // Attach buffer to socket for auto-summary access
  socket.localBuf = localBuf;

  // Admin joins session room
  socket.on("admin_join", ({ code }) => {
    try {
      console.log(`👨‍🏫 Admin socket ${socket.id} joining session room: ${code}`);
      socket.join(code);
      console.log(`✅ Admin joined session room: ${code}`);
    } catch (err) {
      console.error("❌ Error admin joining session room:", err);
    }
  });

  socket.on("join", ({ code, group }) => {
    try {
      console.log(`👋 Socket ${socket.id} attempting to join session ${code}, group ${group}`);
      
      // Check memory first, then database
      let sessionState = activeSessions.get(code);
      let sess = db.prepare("SELECT id, active, interval_ms FROM sessions WHERE code=?").get(code);
      
      if (!sess) {
        console.log(`❌ Session ${code} not found`);
        return socket.emit("error", "Session not found");
      }
      
      // Restore session to memory if missing
      if (!sessionState) {
        sessionState = {
          id: sess.id,
          code: code,
          active: !!sess.active,
          interval: sess.interval_ms || 30000, // Changed default to 30 seconds
          startTime: sess.active ? Date.now() : null
        };
        activeSessions.set(code, sessionState);
        console.log(`🔄 Restored session ${code} to memory`);
        
        // Restart auto-summary if session was active
        if (sess.active) {
          startAutoSummary(code, sess.interval_ms || 30000); // Changed default to 30 seconds
        }
      }
      
      // Allow joining inactive sessions - students can wait for admin to start
      // if (!sessionState.active) {
      //   console.log(`❌ Session ${code} is not active`);
      //   return socket.emit("error", "Session not active");
      // }
      
      sessionCode = code;
      groupNumber = group;
      const existing = db.prepare("SELECT id FROM groups WHERE session_id=? AND number=?").get(sess.id, group);
    groupId = existing?.id ?? uuid();
    if (!existing) {
        db.prepare("INSERT INTO groups (id, session_id, number) VALUES (?,?,?)").run(groupId, sess.id, group);
        console.log(`📝 Created new group: Session ${code}, Group ${group}, ID: ${groupId}`);
      } else {
        console.log(`🔄 Rejoined existing group: Session ${code}, Group ${group}, ID: ${groupId}`);
      }
      
      socket.join(code);
      socket.join(`${code}-${group}`);
      
      // Send different status based on session state
      if (sessionState.active) {
        socket.emit("joined", { code, group, status: "recording" });
        console.log(`✅ Socket ${socket.id} joined ACTIVE session ${code}, group ${group}`);
      } else {
        socket.emit("joined", { code, group, status: "waiting" });
        console.log(`✅ Socket ${socket.id} joined INACTIVE session ${code}, group ${group} - waiting for start`);
      }
      
      // Notify admin about student joining
      socket.to(code).emit("student_joined", { group, socketId: socket.id });
      console.log(`📢 Notified admin about student joining group ${group}`);
      
    } catch (err) {
      console.error("❌ Error joining session:", err);
      socket.emit("error", "Failed to join session");
    }
  });

  socket.on("student:chunk", ({ data }) => {
    localBuf.push(Buffer.from(data));
    socket.localBuf = localBuf; // Keep reference updated
    console.log(`🎤 Received audio chunk from session ${sessionCode}, group ${groupNumber} (${localBuf.length} chunks total, latest: ${data.byteLength} bytes)`);
  });

  socket.on("disconnect", () => {
    console.log(`🔌 Socket ${socket.id} disconnected from session ${sessionCode}, group ${groupNumber}`);
    
    // Notify admin about student leaving
    if (sessionCode && groupNumber) {
      socket.to(sessionCode).emit("student_left", { group: groupNumber, socketId: socket.id });
    }
  });
});

/* ---------- 4. External API helpers ---------- */
async function transcribe(buf) {
  try {
    console.log(`🌐 Calling ElevenLabs API for transcription (${buf.length} bytes)`);
    
    // Create FormData for the API call
    const FormData = (await import('form-data')).default;
    const formData = new FormData();
    
    // Add the audio buffer as a file
    formData.append('file', buf, {
      filename: 'audio.webm',
      contentType: 'audio/webm'
    });
    formData.append('model_id', 'scribe_v1');
    formData.append('timestamps_granularity', 'word'); // Request word-level timestamps
    
    // Make direct API call instead of using SDK
    const response = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: {
        'xi-api-key': process.env.ELEVENLABS_KEY,
        ...formData.getHeaders()
      },
      body: formData
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ ElevenLabs API error: ${response.status} ${response.statusText}`);
      console.error('Error response:', errorText);
      throw new Error(`API error: ${response.status} ${response.statusText}`);
    }
    
    const result = await response.json();
    console.log("✅ ElevenLabs transcription successful");
    
    // Return both text and word-level data
    return {
      text: result.text || "No transcription available",
      words: result.words || []
    };
    
  } catch (err) {
    console.error("❌ Transcription error:", err);
    console.error("Error details:", err.message);
    return { text: "Transcription failed", words: [] };
  }
}

async function summarise(text, customPrompt) {
  try {
    console.log(`🌐 Calling Anthropic API for summarization`);
    const basePrompt = customPrompt || "Summarise the following classroom discussion in ≤6 clear bullet points:";
    
  const body = {
      model: "claude-3-haiku-20240307",
      max_tokens: 256,
      temperature: 0.2,
    messages: [
      {
          role: "user",
          content: `${basePrompt}\n\n${text}`
      }
    ]
  };

  const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
    headers: {
        "x-api-key": process.env.ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
    
    if (!res.ok) {
      console.error(`❌ Anthropic API error: ${res.status} ${res.statusText}`);
      const errorText = await res.text();
      console.error("Error response:", errorText);
      return "Summarization failed";
    }

  const j = await res.json();
    console.log("✅ Anthropic summarization successful");
  return j.content?.[0]?.text?.trim() ?? "(no summary)";
  } catch (err) {
    console.error("❌ Summarization error:", err);
    return "Summarization failed";
  }
}

// Clean up on server shutdown
process.on('SIGINT', () => {
  console.log('🛑 Server shutting down...');
  
  // Stop all auto-summary timers
  for (const [sessionCode, timer] of activeSummaryTimers) {
    clearInterval(timer);
    console.log(`⏰ Stopped timer for session ${sessionCode}`);
  }
  
  // Mark all sessions as inactive in database
  db.prepare("UPDATE sessions SET active=0").run();
  console.log('💾 Marked all sessions as inactive');
  
  process.exit(0);
});

http.listen(8080, () => console.log("🎯 Server running at http://localhost:8080"));