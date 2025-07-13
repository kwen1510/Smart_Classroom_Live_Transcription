import 'dotenv/config';      
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { MongoClient, ServerApiVersion } from 'mongodb';
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

/* ---------- 1. MongoDB ---------- */
const uri = `mongodb+srv://${process.env.MONGO_DB_USERNAME}:${process.env.MONGO_DB_PASSWORD}@cluster0.bwtbeur.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

let db;

async function connectToDatabase() {
  try {
    // Connect the client to the server
    await client.connect();
    db = client.db("SMART_CLASSROOM_LIVE_SUMMARY");
    console.log("📦 MongoDB connected");
    
    // Create indexes for better performance
    await db.collection("sessions").createIndex({ "code": 1 }, { unique: true });
    await db.collection("groups").createIndex({ "session_id": 1, "number": 1 }, { unique: true });
    await db.collection("transcripts").createIndex({ "group_id": 1, "created_at": 1 });
    await db.collection("transcripts").createIndex({ "group_id": 1, "segment_number": 1 });
    await db.collection("summaries").createIndex({ "group_id": 1 }, { unique: true });
    await db.collection("session_prompts").createIndex({ "session_id": 1 }, { unique: true });
    
    console.log("📊 Database indexes ready");

    // Start server ONLY after DB is ready!
    http.listen(8080, () => console.log("🎯 Server running at http://localhost:8080"));
  } catch (error) {
    console.error("❌ Failed to connect to MongoDB:", error);
    process.exit(1);
  }
}

// Connect to database on startup
connectToDatabase();

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

/* Serve test recording page */
app.get("/test-recording", (req, res) => {
  console.log("🧪 Serving test recording page");
  res.sendFile(path.join(__dirname, "test-recording.html"));
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
        .session-card { 
            transition: all 0.3s ease; 
            position: relative;
        }
        .session-card:hover { 
            transform: translateY(-2px); 
            box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04); 
        }
        .session-card.selected {
            border-color: #4f46e5;
            box-shadow: 0 0 0 2px rgba(79, 70, 229, 0.1);
        }
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

        <!-- Selection Toolbar -->
        <div id="selectionToolbar" class="hidden bg-white rounded-xl shadow-lg border border-gray-200 p-4 mb-6">
            <div class="flex items-center justify-between">
                <div class="flex items-center space-x-4">
                    <div class="flex items-center space-x-2">
                        <input 
                            type="checkbox" 
                            id="selectAll" 
                            onchange="toggleSelectAll()"
                            class="w-4 h-4 text-indigo-600 bg-gray-100 border-gray-300 rounded focus:ring-indigo-500"
                        >
                        <label for="selectAll" class="text-sm font-medium text-gray-700">Select All</label>
                    </div>
                    <div id="selectionCount" class="text-sm text-gray-600">0 sessions selected</div>
                </div>
                <div class="flex space-x-3">
                    <button 
                        onclick="clearSelection()" 
                        class="bg-gray-500 hover:bg-gray-600 text-white px-4 py-2 rounded-lg font-medium transition-colors"
                    >
                        Clear Selection
                    </button>
                    <button 
                        onclick="deleteSelectedSessions()" 
                        class="bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded-lg font-medium transition-colors"
                        id="deleteSelectedBtn"
                        disabled
                    >
                        🗑️ Delete Selected
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
                <div class="session-card bg-white rounded-xl shadow-lg border border-gray-200 overflow-hidden transition-all duration-300 hover:shadow-xl" 
                     data-session-code="\${session.code}">
                    <!-- Selection Checkbox -->
                    <div class="absolute top-3 left-3 z-10">
                        <input 
                            type="checkbox" 
                            class="session-checkbox w-5 h-5 text-indigo-600 bg-white border-2 border-gray-300 rounded focus:ring-indigo-500 shadow-sm"
                            data-session-code="\${session.code}"
                            onchange="updateSelection()"
                            onclick="event.stopPropagation()"
                        >
                    </div>
                    
                    <!-- Card Content -->
                    <div class="p-6 cursor-pointer" onclick="viewSessionDetails('\${session.code}')">
                        <div class="flex items-center justify-between mb-4 ml-8">
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
                            <button 
                                onclick="viewSessionDetails('\${session.code}')" 
                                class="text-indigo-600 hover:text-indigo-800 font-medium text-sm transition-colors"
                            >
                                View Details →
                            </button>
                        </div>
                    </div>
                </div>
            \`).join('');
            
            // Update selection state
            updateSelection();
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
                                                <h5 class="font-medium text-gray-900 mb-2">Transcripts</h5>
                                                <div class="space-y-3">
                                                    \${(() => {
                                                        const transcripts = group.transcripts || [];
                                                        const latestTranscript = transcripts.length ? transcripts[transcripts.length - 1] : null;
                                                        const previousTranscripts = transcripts.length > 1 ? transcripts.slice(0, -1).reverse() : [];
                                                        
                                                        let html = '';
                                                        
                                                        // Show latest transcript at the top (highlighted)
                                                        if (latestTranscript) {
                                                            html += \`
                                                                <div class="bg-blue-50 rounded-lg p-4 border-l-4 border-blue-400 mb-4">
                                                                    <div class="flex items-center mb-2">
                                                                        <span class="text-xs font-medium text-blue-600 bg-blue-100 px-2 py-1 rounded uppercase tracking-wide">Latest Transcript</span>
                                                                        <span class="ml-2 text-xs text-gray-500">\${latestTranscript.duration_seconds ? \`\${latestTranscript.duration_seconds.toFixed(1)}s\` : 'Unknown duration'}</span>
                                                                    </div>
                                                                    <div class="text-gray-800 mb-2 font-medium leading-relaxed">\${latestTranscript.text}</div>
                                                                    <div class="flex items-center justify-between text-xs text-gray-500">
                                                                        <span>\${new Date(latestTranscript.created_at).toLocaleString()}</span>
                                                                        <span>\${latestTranscript.word_count || 0} words</span>
                                                                    </div>
                                                                </div>
                                                            \`;
                                                        }
                                                        
                                                        // Show previous transcripts below
                                                        if (previousTranscripts.length > 0) {
                                                            html += \`
                                                                <h6 class="text-xs font-semibold text-gray-500 mb-2">Previous Transcripts (\${previousTranscripts.length})</h6>
                                                                <div class="space-y-2 max-h-48 overflow-y-auto">
                                                                    \${previousTranscripts.map(transcript => \`
                                                                        <div class="bg-gray-50 rounded p-3 text-sm">
                                                                            <div class="text-gray-800 mb-1">\${transcript.text}</div>
                                                                            <div class="text-xs text-gray-500">
                                                                                \${new Date(transcript.created_at).toLocaleString()} • 
                                                                                \${transcript.word_count || 0} words • 
                                                                                \${transcript.duration_seconds ? transcript.duration_seconds.toFixed(1) + 's' : 'No duration'}
                                                                            </div>
                                                                        </div>
                                                                    \`).join('')}
                                                                </div>
                                                            \`;
                                                        }
                                                        
                                                        // Show empty state if no transcripts
                                                        if (!latestTranscript && previousTranscripts.length === 0) {
                                                            html += \`
                                                                <div class="text-center py-4 text-gray-500">
                                                                    <svg class="w-8 h-8 mx-auto mb-2 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"/>
                                                                    </svg>
                                                                    <p class="text-sm">No transcripts available</p>
                                                                </div>
                                                            \`;
                                                        }
                                                        
                                                        return html;
                                                    })()}
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

        // Selection and Deletion Functions
        function updateSelection() {
            const checkboxes = document.querySelectorAll('.session-checkbox');
            const checkedBoxes = document.querySelectorAll('.session-checkbox:checked');
            const selectAllCheckbox = document.getElementById('selectAll');
            const selectionToolbar = document.getElementById('selectionToolbar');
            const selectionCount = document.getElementById('selectionCount');
            const deleteBtn = document.getElementById('deleteSelectedBtn');

            // Update visual state of session cards
            checkboxes.forEach(checkbox => {
                const sessionCard = checkbox.closest('.session-card');
                if (checkbox.checked) {
                    sessionCard.classList.add('selected');
                } else {
                    sessionCard.classList.remove('selected');
                }
            });

            // Update select all checkbox state
            if (checkedBoxes.length === 0) {
                selectAllCheckbox.indeterminate = false;
                selectAllCheckbox.checked = false;
            } else if (checkedBoxes.length === checkboxes.length) {
                selectAllCheckbox.indeterminate = false;
                selectAllCheckbox.checked = true;
            } else {
                selectAllCheckbox.indeterminate = true;
                selectAllCheckbox.checked = false;
            }

            // Show/hide selection toolbar
            if (checkedBoxes.length > 0) {
                selectionToolbar.classList.remove('hidden');
                selectionCount.textContent = \`\${checkedBoxes.length} session\${checkedBoxes.length === 1 ? '' : 's'} selected\`;
                deleteBtn.disabled = false;
                deleteBtn.classList.remove('opacity-50', 'cursor-not-allowed');
            } else {
                selectionToolbar.classList.add('hidden');
                deleteBtn.disabled = true;
                deleteBtn.classList.add('opacity-50', 'cursor-not-allowed');
            }
        }

        function toggleSelectAll() {
            const selectAllCheckbox = document.getElementById('selectAll');
            const checkboxes = document.querySelectorAll('.session-checkbox');
            
            checkboxes.forEach(checkbox => {
                checkbox.checked = selectAllCheckbox.checked;
            });
            
            updateSelection();
        }

        function clearSelection() {
            const checkboxes = document.querySelectorAll('.session-checkbox');
            checkboxes.forEach(checkbox => {
                checkbox.checked = false;
            });
            updateSelection();
        }

        async function deleteSelectedSessions() {
            const checkedBoxes = document.querySelectorAll('.session-checkbox:checked');
            const selectedCodes = Array.from(checkedBoxes).map(cb => cb.dataset.sessionCode);
            
            if (selectedCodes.length === 0) {
                return;
            }

            // Show confirmation dialog
            const confirmMessage = \`Are you sure you want to delete \${selectedCodes.length} session\${selectedCodes.length === 1 ? '' : 's'}?\\n\\nThis will permanently delete:\\n- All session data\\n- All groups and transcripts\\n- All summaries\\n\\nThis action cannot be undone.\`;
            
            if (!confirm(confirmMessage)) {
                return;
            }

            try {
                // Show loading state
                const deleteBtn = document.getElementById('deleteSelectedBtn');
                const originalText = deleteBtn.innerHTML;
                deleteBtn.innerHTML = '⏳ Deleting...';
                deleteBtn.disabled = true;

                // Delete sessions
                const response = await fetch('/api/sessions', {
                    method: 'DELETE',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        sessionCodes: selectedCodes
                    })
                });

                const result = await response.json();

                if (response.ok) {
                    // Show success message
                    alert(\`Successfully deleted \${result.deletedCounts.sessions} sessions and all related data:\\n\\n\` +
                          \`- \${result.deletedCounts.transcripts} transcripts\\n\` +
                          \`- \${result.deletedCounts.summaries} summaries\\n\` +
                          \`- \${result.deletedCounts.groups} groups\\n\` +
                          \`- \${result.deletedCounts.session_prompts} prompts\`);
                    
                    // Reload sessions
                    loadSessions(currentPage, currentFilters);
                    clearSelection();
                } else {
                    throw new Error(result.error || 'Delete failed');
                }

            } catch (error) {
                console.error('Delete error:', error);
                alert(\`Failed to delete sessions: \${error.message}\`);
            } finally {
                // Restore button state
                const deleteBtn = document.getElementById('deleteSelectedBtn');
                deleteBtn.innerHTML = originalText;
                updateSelection(); // This will handle the disabled state
            }
        }
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
app.post("/api/session/:code/prompt", express.json(), async (req, res) => {
  try {
    const { code } = req.params;
    const { prompt } = req.body;
    
    if (!prompt || !prompt.trim()) {
      return res.status(400).json({ error: "Prompt is required" });
    }
    
    // Get session ID
    const session = await db.collection("sessions").findOne({ code: code });
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }
    
    // Save prompt for this session
    await db.collection("session_prompts").findOneAndUpdate(
      { session_id: session._id },
      { $set: { prompt: prompt.trim(), updated_at: Date.now() } },
      { upsert: true }
    );
    
    console.log(`💾 Saved custom prompt for session ${code}`);
    res.json({ success: true, message: "Prompt saved successfully" });
    
  } catch (err) {
    console.error("❌ Failed to save prompt:", err);
    res.status(500).json({ error: "Failed to save prompt" });
  }
});

app.get("/api/session/:code/prompt", async (req, res) => {
  try {
    const { code } = req.params;
    
    // Get session ID
    const session = await db.collection("sessions").findOne({ code: code });
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }
    
    // Get prompt for this session
    const promptData = await db.collection("session_prompts").findOne({ session_id: session._id });
    
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
app.get("/api/new-session", async (req, res) => {
  try {
    const id = uuid();
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const interval = Number(req.query.interval) || 30000;
    
    // Clear any existing session with same code (unlikely but safe)
    activeSessions.delete(code);
    
    // Store session in memory only - no database persistence until recording starts
    activeSessions.set(code, {
      id,
      code,
      active: false,
      interval,
      startTime: null,
      created_at: Date.now(),
      persisted: false // Flag to track if saved to database
    });
    
    console.log(`🆕 New session created in memory: Code=${code}, Interval=${interval}ms (memory only)`);
    res.json({ code, interval });
  } catch (err) {
    console.error("❌ Failed to create session:", err);
    res.status(500).json({ error: "Failed to create session" });
  }
});

/* Get session status */
app.get("/api/session/:code/status", async (req, res) => {
  try {
    const code = req.params.code;
    const sessionState = activeSessions.get(code);
    
    if (!sessionState) {
      return res.status(404).json({ error: "Session not found" });
    }
    
    console.log(`📋 Session ${code} found in memory`);
    res.json(sessionState);
  } catch (err) {
    console.error("❌ Failed to get session status:", err);
    res.status(500).json({ error: "Failed to get session status" });
  }
});

/* Admin API: start/stop session */
app.post("/api/session/:code/start", express.json(), async (req, res) => {
  try {
    const { interval } = req.body;
    const code = req.params.code;
    const startTime = Date.now();
    
    // Get session from memory
    const sessionState = activeSessions.get(code);
    if (!sessionState) {
      return res.status(404).json({ error: "Session not found in memory" });
    }
    
    // Persist to database when recording actually starts (first time only)
    if (!sessionState.persisted) {
      // Check if session already exists in database (in case of server restart)
      const existingSession = await db.collection("sessions").findOne({ code: code });
      
      if (existingSession) {
        // Session exists in database, just update it
        await db.collection("sessions").updateOne(
          { code: code },
          { $set: { 
            active: true, 
            interval_ms: interval || 30000,
            start_time: startTime,
            end_time: null,
            total_duration_seconds: null
          } }
        );
        
        // Update the session state with the existing database ID
        sessionState.id = existingSession._id;
        sessionState.persisted = true;
        console.log(`🔄 Session ${code} already exists in database, updated with ID: ${existingSession._id}`);
      } else {
        // Generate a new unique ID for database insertion
        const dbSessionId = uuid();
        
        await db.collection("sessions").insertOne({
          _id: dbSessionId,
          code: code,
          interval_ms: interval || 30000,
          created_at: sessionState.created_at,
          active: true,
          start_time: startTime,
          end_time: null,
          total_duration_seconds: null
        });
        
        // Update the session state with the database ID
        sessionState.id = dbSessionId;
        sessionState.persisted = true;
        console.log(`💾 Session ${code} persisted to database on first start with ID: ${dbSessionId}`);
      }
    } else {
      // Update existing database record
      await db.collection("sessions").updateOne(
        { code: code },
        { $set: { 
          active: true, 
          interval_ms: interval || 30000,
          start_time: startTime,
          end_time: null,
          total_duration_seconds: null
        } }
      );
      console.log(`🔄 Session ${code} updated in database`);
    }
    
    // Update memory state
    sessionState.active = true;
    sessionState.interval = interval || 30000;
    sessionState.startTime = startTime;
    
    io.to(code).emit("record_now", interval || 30000);
    
    console.log(`▶️  Session ${code} started recording (interval: ${interval || 30000}ms)`);
    res.json({ ok: true });
  } catch (err) {
    console.error("❌ Failed to start session:", err);
    res.status(500).json({ error: "Failed to start session" });
  }
});

app.post("/api/session/:code/stop", async (req, res) => {
  try {
    const code = req.params.code;
    const endTime = Date.now();
    
    // Get session from memory
    const sessionState = activeSessions.get(code);
    if (!sessionState) {
      return res.status(404).json({ error: "Session not found in memory" });
    }
    
    // Only update database if session was persisted (i.e., recording was started)
    if (sessionState.persisted) {
      // Calculate total duration in seconds
      const totalDurationSeconds = sessionState.startTime ? 
        Math.floor((endTime - sessionState.startTime) / 1000) : 0;
      
      await db.collection("sessions").updateOne(
        { code: code },
        { $set: { 
          active: false,
          end_time: endTime,
          total_duration_seconds: totalDurationSeconds
        } }
      );
      
      console.log(`💾 Session ${code} stopped and saved to database (duration: ${totalDurationSeconds}s)`);
    } else {
      console.log(`⏹️  Session ${code} stopped (was never persisted to database)`);
    }
    
    // Update memory state
    sessionState.active = false;
    sessionState.startTime = null;
    
    io.to(code).emit("stop_recording");
    
    console.log(`⏹️  Session ${code} stopped recording`);
    res.json({ ok: true });
  } catch (err) {
    console.error("❌ Failed to stop session:", err);
    res.status(500).json({ error: "Failed to stop session" });
  }
});

/* Admin API: get transcripts for a specific group */
app.get("/api/transcripts/:code/:number", async (req, res) => {
  try {
    const { code, number } = req.params;
    console.log(`📝 Fetching transcripts for session ${code}, group ${number}`);
    
    // Get session and group IDs
    const session = await db.collection("sessions").findOne({ code: code });
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }
    
    const group = await db.collection("groups").findOne({ session_id: session._id, number: parseInt(number) });
    if (!group) {
      return res.status(404).json({ error: "Group not found" });
    }
    
    // Get all transcripts for this group
    const transcripts = await db.collection("transcripts").find({ group_id: group._id }).sort({ created_at: -1 }).limit(50).toArray();
    
    // Get the latest summary
    const summary = await db.collection("summaries").findOne({ group_id: group._id });
    
    // Get some stats
    const stats = await db.collection("transcripts").aggregate([
      { $match: { group_id: group._id } },
      {
        $group: {
          _id: null,
          total_segments: { $sum: 1 },
          total_words: { $sum: "$word_count" },
          total_duration: { $sum: "$duration_seconds" },
          last_update: { $max: "$created_at" }
        }
      }
    ]).toArray();
    
    res.json({
      transcripts: await Promise.all(transcripts.map(async t => ({
        ...t,
        created_at: new Date(t.created_at).toISOString()
      }))),
      summary: summary || { text: "No summary available", updated_at: null },
      stats: stats[0] || {
        totalSegments: 0,
        totalWords: 0,
        totalDuration: 0,
        lastUpdate: null
      }
    });
    
  } catch (err) {
    console.error("❌ Failed to fetch transcripts:", err);
    res.status(500).json({ error: "Failed to fetch transcripts" });
  }
});

/* Admin API: get historical data */
app.get("/api/history", async (req, res) => {
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
    const sessions = await db.collection("sessions").find({}).sort({ created_at: -1 }).skip(parseInt(offset)).limit(parseInt(limit)).toArray();
    
    const result = {
      sessions: await Promise.all(sessions.map(async s => {
        // Calculate current duration for active sessions
        let currentDuration = s.total_duration_seconds || 0;
        if (s.active && s.start_time) {
          currentDuration = Math.floor((Date.now() - s.start_time) / 1000);
        }
        
        return {
          ...s,
          created_at: new Date(s.created_at).toISOString(),
          interval_seconds: s.interval_ms / 1000,
          current_duration_seconds: currentDuration,
          groups: []
        };
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
        const groups = await db.collection("groups").find({ session_id: session._id }).sort({ number: 1 }).toArray();
        
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
            groupData.transcripts = await db.collection("transcripts").find({ group_id: group._id }).sort({ created_at: 1 }).toArray();
            
            // Calculate stats
            groupData.stats = {
              totalSegments: groupData.transcripts.length,
              totalWords: groupData.transcripts.reduce((sum, t) => sum + (t.word_count || 0), 0),
              totalDuration: groupData.transcripts.reduce((sum, t) => sum + (t.duration_seconds || 0), 0)
            };
          }
          
          if (includeSummaries === 'true') {
            // Get summary for this group
            const summary = await db.collection("summaries").findOne({ group_id: group._id });
            
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
    
    // After all groups are pushed to session.groups in /api/history:
    for (const session of result.sessions) {
      session.group_count = session.groups.length;
      session.total_transcripts = session.groups.reduce((sum, g) => sum + (g.stats?.totalSegments || 0), 0);
      session.total_words = session.groups.reduce((sum, g) => sum + (g.stats?.totalWords || 0), 0);
      // Use actual session duration (current for active sessions, total for completed)
      session.total_duration = session.current_duration_seconds || 0;
    }
    
    res.json(result);
    
  } catch (err) {
    console.error("❌ Failed to fetch historical data:", err);
    res.status(500).json({ error: "Failed to fetch historical data" });
  }
});

/* Admin API: get specific session details */
app.get("/api/history/session/:code", async (req, res) => {
  try {
    const { code } = req.params;
    console.log(`📋 Fetching detailed data for session: ${code}`);
    
    // Get session info
    const session = await db.collection("sessions").findOne({ code: code });
    
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }
    
    // Get all groups for this session
    const groups = await db.collection("groups").find({ session_id: session._id }).sort({ number: 1 }).toArray();
    
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
      const transcripts = await db.collection("transcripts").find({ group_id: group._id }).sort({ created_at: 1 }).toArray();
      
      // Get summary
      const summary = await db.collection("summaries").findOne({ group_id: group._id });
      
      const groupData = {
        number: group.number,
        transcripts: await Promise.all(transcripts.map(async t => ({
          ...t,
          created_at: new Date(t.created_at).toISOString()
        }))),
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

/* Admin API: delete multiple sessions */
app.delete("/api/sessions", express.json(), async (req, res) => {
  try {
    const { sessionCodes } = req.body;
    
    if (!sessionCodes || !Array.isArray(sessionCodes) || sessionCodes.length === 0) {
      return res.status(400).json({ error: "sessionCodes array is required" });
    }
    
    console.log(`🗑️ Deleting ${sessionCodes.length} sessions:`, sessionCodes);
    
    const deletedCounts = {
      sessions: 0,
      groups: 0,
      transcripts: 0,
      summaries: 0,
      session_prompts: 0
    };
    
    // Process each session
    for (const sessionCode of sessionCodes) {
      console.log(`🗑️ Processing deletion for session: ${sessionCode}`);
      
      // Find the session
      const session = await db.collection("sessions").findOne({ code: sessionCode });
      if (!session) {
        console.log(`⚠️ Session ${sessionCode} not found, skipping`);
        continue;
      }
      
      // Stop any active timers for this session
      if (activeSessions.has(sessionCode)) {
        activeSessions.delete(sessionCode);
        console.log(`🛑 Removed session ${sessionCode} from active sessions`);
      }
      
      if (activeSummaryTimers.has(sessionCode)) {
        clearInterval(activeSummaryTimers.get(sessionCode));
        activeSummaryTimers.delete(sessionCode);
        console.log(`⏰ Stopped auto-summary timer for session ${sessionCode}`);
      }
      
      // Get all groups for this session
      const groups = await db.collection("groups").find({ session_id: session._id }).toArray();
      console.log(`📊 Found ${groups.length} groups for session ${sessionCode}`);
      
      // Delete all related data for each group
      for (const group of groups) {
        // Delete transcripts
        const transcriptResult = await db.collection("transcripts").deleteMany({ group_id: group._id });
        deletedCounts.transcripts += transcriptResult.deletedCount;
        
        // Delete summaries
        const summaryResult = await db.collection("summaries").deleteMany({ group_id: group._id });
        deletedCounts.summaries += summaryResult.deletedCount;
        
        console.log(`🗑️ Deleted ${transcriptResult.deletedCount} transcripts and ${summaryResult.deletedCount} summaries for group ${group.number}`);
      }
      
      // Delete all groups for this session
      const groupResult = await db.collection("groups").deleteMany({ session_id: session._id });
      deletedCounts.groups += groupResult.deletedCount;
      
      // Delete session prompts
      const promptResult = await db.collection("session_prompts").deleteMany({ session_id: session._id });
      deletedCounts.session_prompts += promptResult.deletedCount;
      
      // Finally, delete the session itself
      const sessionResult = await db.collection("sessions").deleteOne({ _id: session._id });
      deletedCounts.sessions += sessionResult.deletedCount;
      
      console.log(`✅ Successfully deleted session ${sessionCode} and all related data`);
    }
    
    console.log(`🎯 Deletion complete:`, deletedCounts);
    
    res.json({
      success: true,
      message: `Successfully deleted ${deletedCounts.sessions} sessions and all related data`,
      deletedCounts
    });
    
  } catch (err) {
    console.error("❌ Failed to delete sessions:", err);
    res.status(500).json({ 
      error: "Failed to delete sessions", 
      details: err.message 
    });
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
    const session = await db.collection("sessions").findOne({ code: sessionCode, active: true });
    
    if (!session || !sessionState?.active) {
      console.log(`⚠️  Session ${sessionCode} no longer active, stopping auto-summary`);
      stopAutoSummary(sessionCode);
      return;
    }
    
    const groups = await db.collection("groups").find({ session_id: session._id }).sort({ number: 1 }).toArray();
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

// Concurrency guard for transcription
const processingGroups = new Set();

async function generateSummaryForGroup(sessionCode, groupNumber) {
  const groupKey = `${sessionCode}-${groupNumber}`;
  
  // Prevent overlapping processing for the same group
  if (processingGroups.has(groupKey)) {
    console.log(`⏳ Group ${groupNumber} already being processed, skipping`);
    return;
  }
  
  processingGroups.add(groupKey);
  
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
        // For WebM containers, we should have at most one complete container per socket
        // For other formats, we might have multiple chunks
        const audioChunks = socket.localBuf.filter(chunk => chunk.data.length > 20000); // Guardrail: only process substantial chunks
        
        if (audioChunks.length > 0) {
          // For WebM, we need to handle both complete containers and partial chunks
          const baseMime = extractMime(audioChunks[0].format);
          if (baseMime === 'audio/webm') {
            // First, look for a complete WebM container
            const completeContainer = audioChunks.find(chunk => {
              const header = chunk.data.slice(0, 4).toString('hex');
              return header === '1a45dfa3' && !chunk.isPartial;
            });
            
            if (completeContainer) {
              console.log(`✅ Found complete WebM container (${completeContainer.data.length} bytes) from socket ${socket.id}`);
              combinedAudio.push(completeContainer);
              hasAudio = true;
            } else {
              // Don't try to combine partial chunks - they create corrupted WebM data
              // Instead, just skip this processing cycle and wait for a complete container
              console.log(`⏭️  No complete WebM container found, skipping processing (${audioChunks.length} partial chunks available)`);
              console.log(`💡 Waiting for complete WebM container with header 1a45dfa3...`);
            }
          } else {
            // For other formats, add all substantial chunks
            combinedAudio.push(...audioChunks);
            hasAudio = true;
          }
        }
        
        socket.localBuf.length = 0; // Clear buffer after processing
      }
    }
    
    if (!hasAudio) {
      console.log(`ℹ️  No substantial audio data available for group ${groupNumber}, skipping`);
      return;
    }
    
    // Process each blob individually instead of concatenating
    for (const audioChunk of combinedAudio) {
      console.log(`🔄 Processing ${audioChunk.data.length} bytes of audio data for group ${groupNumber}`);
      
      // Validate audio before sending to API
      if (audioChunk.data.length < 1000) {
        console.log(`⚠️  Audio too small (${audioChunk.data.length} bytes), skipping`);
        continue;
      }
      
      // Check if audio has valid headers for common formats
      const header = audioChunk.data.slice(0, 4).toString('hex');
      const validHeaders = {
        '1a45dfa3': 'WebM',
        '52494646': 'WAV/RIFF',
        '00000020': 'MP4',
        '4f676753': 'OGG'
      };
      
      if (validHeaders[header]) {
        console.log(`✅ Valid ${validHeaders[header]} header detected: ${header}`);
      } else {
        console.log(`⚠️  Unknown audio header: ${header}, proceeding anyway`);
        // Log the first few bytes for debugging
        const firstBytes = audioChunk.data.slice(0, 8).toString('hex');
        console.log(`🔍 First 8 bytes: ${firstBytes}`);
      }
      
      // Get transcription for this individual audio chunk
      console.log("🗣️  Starting transcription for current chunk...");
      
      console.log(`🎵 Audio format: ${audioChunk.format}`);
      
      const transcription = await transcribe(audioChunk.data, audioChunk.format);
      
      // Only proceed if we have valid transcription
      let cleanedText = transcription.text;
      if (transcription.text && transcription.text !== "No transcription available" && transcription.text !== "Transcription failed") {
        // Transcript cleaning removed - using raw transcription
        console.log(`📝 Transcription for group ${groupNumber}:`, {
          text: cleanedText,
          duration: transcription.words.length > 0 ? 
            transcription.words[transcription.words.length - 1].end : 0,
          wordCount: transcription.words.length
        });
        
        // Save this individual transcription segment
        const session = await db.collection("sessions").findOne({ code: sessionCode });
        const group = await db.collection("groups").findOne({ session_id: session._id, number: parseInt(groupNumber) });
        
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
          
          await db.collection("transcripts").insertOne({
            _id: transcriptId,
            group_id: group._id,
            text: cleanedText,
            word_count: wordCount,
            duration_seconds: duration,
            created_at: now,
            segment_number: Math.floor(now / 30000) // Update segment tracking for new interval
          });
          
          // Get all transcripts for this group to create summary of FULL conversation
          const allTranscripts = await db.collection("transcripts").find({ group_id: group._id }).sort({ created_at: 1 }).toArray();
          
          // Combine all transcripts for summary (but only transcribe current chunk)
          const fullText = allTranscripts.map(t => t.text).join(' ');
          
          // Generate summary of the entire conversation so far
          console.log("🤖 Generating summary of full conversation...");
          
          // Get custom prompt for this session
          let customPrompt = null;
          if (session) {
            const promptData = await db.collection("session_prompts").findOne({ session_id: session._id });
            customPrompt = promptData?.prompt || null;
          }
          
          const summary = await summarise(fullText, customPrompt);
          
          // Save/update the summary
          await db.collection("summaries").findOneAndUpdate(
            { group_id: group._id },
            { $set: { text: summary, updated_at: now } },
            { upsert: true }
          );
          
          // Send both new transcription and updated summary to clients
          io.to(roomName).emit("transcription_and_summary", {
            transcription: {
              text: cleanedText,
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
            latestTranscript: cleanedText,
            cumulativeTranscript: fullText, // Add full conversation for admin
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
    }
    
  } catch (err) {
    console.error(`❌ Error processing group ${groupNumber}:`, err);
  } finally {
    processingGroups.delete(groupKey);
  }
}

// Helper to clean up transcript using Anthropic
async function cleanTranscriptWithAnthropic(text) {
  return summarise(
    text,
    "Clean up the following transcript for grammar, punctuation, and readability, but do not summarize or remove any content. Only return the cleaned transcript:"
  );
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

  socket.on("join", async ({ code, group }) => {
    try {
      console.log(`👋 Socket ${socket.id} attempting to join session ${code}, group ${group}`);
      
      // Check memory only - no database lookup
      const sessionState = activeSessions.get(code);
      
      if (!sessionState) {
        console.log(`❌ Session ${code} not found`);
        return socket.emit("error", "Session not found");
      }
      
      sessionCode = code;
      groupNumber = group;
      
      // Only create database entries if session has been persisted (i.e., recording started)
      if (sessionState.persisted) {
        // Session exists in database, handle group creation normally
        const sess = await db.collection("sessions").findOne({ code: code });
        if (!sess) {
          console.log(`❌ Session ${code} not found in database despite being marked as persisted`);
          return socket.emit("error", "Session data inconsistent");
        }
        
        const existing = await db.collection("groups").findOne({ session_id: sess._id, number: parseInt(group) });
        groupId = existing?._id ?? uuid();
        
        if (!existing) {
          await db.collection("groups").insertOne({
            _id: groupId,
            session_id: sess._id,
            number: parseInt(group)
          });
          console.log(`📝 Created new group: Session ${code}, Group ${group}, ID: ${groupId}`);
        } else {
          console.log(`🔄 Rejoined existing group: Session ${code}, Group ${group}, ID: ${groupId}`);
        }
      } else {
        // Session not yet persisted, just create a temporary group ID
        groupId = uuid();
        console.log(`📝 Created temporary group ID for unpersisted session: ${groupId}`);
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

  socket.on("student:chunk", ({ data, format }) => {
    // Note: This event is no longer used. Students now upload chunks directly via /api/transcribe-chunk
    console.log(`⚠️  Received old-style chunk from ${sessionCode}, group ${groupNumber} - ignoring (use /api/transcribe-chunk instead)`);
  });

  // Handle heartbeat to keep connection alive (especially for background recording)
  socket.on("heartbeat", ({ session, group }) => {
    console.log(`💓 Heartbeat from session ${session}, group ${group} (socket: ${socket.id})`);
    socket.emit("heartbeat_ack");
  });

  // Handle admin heartbeat
  socket.on("admin_heartbeat", ({ sessionCode }) => {
    console.log(`💓 Admin heartbeat from session ${sessionCode} (socket: ${socket.id})`);
    socket.emit("admin_heartbeat_ack");
  });

  // Handle upload errors from students
  socket.on("upload_error", ({ session, group, error, chunkSize, timestamp }) => {
    console.log(`❌ Upload error from session ${session}, group ${group}: ${error}`);
    
    // Notify admin about the upload error
    socket.to(session).emit("upload_error", {
      group: group,
      error: error,
      chunkSize: chunkSize,
      timestamp: timestamp,
      socketId: socket.id
    });
    
    // Log error for debugging
    console.log(`📊 Upload error details: ${chunkSize} bytes, ${error}`);
  });

  socket.on("disconnect", () => {
    console.log(`🔌 Socket ${socket.id} disconnected from session ${sessionCode}, group ${groupNumber}`);
    
    // Clean up socket buffer to prevent memory leaks
    if (socket.localBuf) {
      socket.localBuf.length = 0;
      socket.localBuf = null;
    }
    
    // Remove from processing groups if it was being processed
    if (sessionCode && groupNumber) {
      const groupKey = `${sessionCode}-${groupNumber}`;
      processingGroups.delete(groupKey);
    }
    
    // Notify admin about student leaving
    if (sessionCode && groupNumber) {
      socket.to(sessionCode).emit("student_left", { group: groupNumber, socketId: socket.id });
    }
  });
});

/* ---------- 4. External API helpers ---------- */
// Helper to extract base MIME type (before semicolon)
function extractMime(mime) {
  if (!mime) return 'audio/webm';
  return mime.split(';')[0].trim().toLowerCase();
}

async function transcribe(buf, format = 'audio/webm') {
  try {
    console.log(`🌐 Calling ElevenLabs API for transcription (${buf.length} bytes, format: ${format})`);
    
    // Additional validation
    if (!buf || buf.length === 0) {
      console.log("⚠️  Empty audio buffer provided");
      return { text: "No audio data available", words: [] };
    }
    
    if (buf.length < 1000) {
      console.log(`⚠️  Audio buffer too small (${buf.length} bytes) for transcription`);
      return { text: "Audio too short for transcription", words: [] };
    }
    
    // Create FormData for the API call
    const FormData = (await import('form-data')).default;
    const formData = new FormData();
    
    // Extract base MIME type and map formats correctly
    const baseMime = extractMime(format);
    let audioMime = baseMime;
    let filename = 'audio.webm';
    
    // Map formats using base MIME, not the whole string
    switch (baseMime) {
      case 'audio/wav':
      case 'audio/x-wav':
      case 'audio/wave':
      case 'audio/pcm':
        audioMime = 'audio/wav';
        filename = 'audio.wav';
        break;
        
      case 'audio/mp4':
      case 'audio/m4a':
        audioMime = 'audio/mp4';
        filename = 'audio.mp4';
        break;
        
      case 'audio/ogg':
      case 'audio/opus':
        audioMime = 'audio/ogg';
        filename = 'audio.ogg';
        break;
        
      default:
        // Keep WebM as WebM (default case)
        audioMime = 'audio/webm';
        filename = 'audio.webm';
    }
    
    // Validate audio headers based on format
    const header = buf.slice(0, 4).toString('hex');
    console.log(`🔍 Audio header: ${header} (format: ${audioMime})`);
    
    // Additional validation for WebM containers
    if (audioMime === 'audio/webm') {
      if (header !== '1a45dfa3') {
        console.log(`❌ Invalid WebM header: ${header}, expected: 1a45dfa3`);
        console.log(`🚫 Rejecting WebM data - only complete containers should be processed`);
        return { text: "Invalid WebM container - only complete containers are supported", words: [] };
      }
      
      // Check for minimum WebM container size
      if (buf.length < 1000) {
        console.log(`❌ WebM container too small: ${buf.length} bytes`);
        return { text: "WebM container too small", words: [] };
      }
      
      console.log(`✅ Valid WebM container detected (${buf.length} bytes)`);
    }
    
    // Add the audio buffer as a file
    formData.append('file', buf, {
      filename: filename,
      contentType: audioMime
    });
    formData.append('model_id', 'scribe_v1');
    formData.append('timestamps_granularity', 'word');
    
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
      
      // Handle specific error cases
      if (response.status === 400) {
        try {
          const errorJson = JSON.parse(errorText);
          if (errorJson.detail?.message?.includes('corrupted')) {
            console.log("🔄 Audio appears corrupted - this might be due to WebM container issues");
            console.log(`📊 Audio details: ${buf.length} bytes, format: ${audioMime}, header: ${buf.slice(0, 4).toString('hex')}`);
            return { text: "Audio quality issue - WebM container may be incomplete", words: [] };
          }
        } catch (e) {
          // If we can't parse the error, continue with generic error
        }
      }
      
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
    
    // Return a more user-friendly error message
    if (err.message.includes('corrupted') || err.message.includes('invalid_content')) {
      return { text: "Audio quality issue - please try again", words: [] };
    }
    
    return { text: "Transcription temporarily unavailable", words: [] };
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
process.on('SIGINT', async () => {
  console.log('🛑 Server shutting down...');
  
  // Stop all auto-summary timers
  for (const [sessionCode, timer] of activeSummaryTimers) {
    clearInterval(timer);
    console.log(`⏰ Stopped timer for session ${sessionCode}`);
  }
  
  // Mark all sessions as inactive in database
  await db.collection("sessions").updateMany({}, { $set: { active: false } });
  console.log('💾 Marked all sessions as inactive');
  
  process.exit(0);
});

/* New 30-second chunk transcription endpoint */
app.post("/api/transcribe-chunk", upload.single('file'), async (req, res) => {
  try {
    console.log("📦 Received chunk for transcription");
    
    if (!req.file) {
      return res.status(400).json({ error: "No audio file provided", success: false });
    }
    
    const audioBuffer = req.file.buffer;
    const mimeType = req.file.mimetype;
    const { sessionCode, groupNumber } = req.body;
    
    if (!sessionCode || !groupNumber) {
      return res.status(400).json({ error: "Session code and group number are required", success: false });
    }
    
    console.log(`📁 Processing chunk: ${audioBuffer.length} bytes, mimetype: ${mimeType}, session: ${sessionCode}, group: ${groupNumber}`);
    
    // Enhanced chunk validation
    if (audioBuffer.length < 100) {
      console.log("⚠️ Chunk too small, skipping");
      return res.json({ 
        success: false, 
        message: "Chunk too small (< 100 bytes)",
        transcription: { text: "", words: [] }
      });
    }
    
    if (audioBuffer.length > 10 * 1024 * 1024) { // 10MB limit
      console.log("⚠️ Chunk too large, skipping");
      return res.status(400).json({ error: "Chunk too large (>10MB)", success: false });
    }
    
    // Validate audio format
    const header = audioBuffer.slice(0, 4).toString('hex');
    const validHeaders = {
      '1a45dfa3': 'WebM',
      '52494646': 'WAV/RIFF',
      '00000020': 'MP4',
      '4f676753': 'OGG'
    };
    
    if (!validHeaders[header]) {
      console.log(`⚠️ Unknown audio format, header: ${header}`);
      // Don't reject - ElevenLabs might still be able to process it
    } else {
      console.log(`✅ Detected ${validHeaders[header]} format`);
    }
    
    // Validate WebM containers more strictly
    if (mimeType.includes('webm') && header !== '1a45dfa3') {
      console.log(`❌ Invalid WebM container, header: ${header}`);
      return res.status(400).json({ 
        error: "Invalid WebM container - corrupted audio data", 
        success: false,
        details: `Expected WebM header 1a45dfa3, got ${header}`
      });
    }
    
    // Direct forward to ElevenLabs using form-data with retry logic
    const FormData = (await import('form-data')).default;
    const formData = new FormData();
    
    formData.append('model_id', 'scribe_v1');
    formData.append('file', audioBuffer, {
      filename: req.file.originalname || `chunk_${Date.now()}.webm`,
      contentType: mimeType
    });
    
    console.log("🌐 Forwarding to ElevenLabs Speech-to-Text API...");
    
    const startTime = Date.now();
    let response;
    let retryCount = 0;
    const maxRetries = 3;
    
    // Retry logic for ElevenLabs API
    while (retryCount < maxRetries) {
      try {
        response = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
          method: 'POST',
          headers: {
            'xi-api-key': process.env.ELEVENLABS_KEY,
            ...formData.getHeaders()
          },
          body: formData,
          timeout: 30000 // 30 second timeout
        });
        
        if (response.ok) {
          break; // Success, exit retry loop
        } else if (response.status === 429) {
          // Rate limit - wait and retry
          console.log(`⏳ Rate limited, retrying in ${Math.pow(2, retryCount)} seconds...`);
          await new Promise(resolve => setTimeout(resolve, Math.pow(2, retryCount) * 1000));
          retryCount++;
        } else if (response.status >= 500) {
          // Server error - retry
          console.log(`🔄 Server error ${response.status}, retrying...`);
          retryCount++;
          await new Promise(resolve => setTimeout(resolve, 1000));
        } else {
          // Client error - don't retry
          break;
        }
      } catch (fetchError) {
        console.error(`❌ Network error (attempt ${retryCount + 1}):`, fetchError);
        retryCount++;
        if (retryCount < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, Math.pow(2, retryCount) * 1000));
        }
      }
    }
    
    const processingTime = Date.now() - startTime;
    
    if (!response || !response.ok) {
      let errorText = 'Unknown error';
      try {
        errorText = await response.text();
      } catch (e) {
        // Ignore text parsing errors
      }
      
      console.error(`❌ ElevenLabs API error after ${retryCount} retries: ${response?.status} ${response?.statusText}`);
      console.error('Error response:', errorText);
      
      // Return more specific error messages
      let errorMessage = "Transcription service temporarily unavailable";
      if (response?.status === 400) {
        errorMessage = "Audio format not supported or corrupted";
      } else if (response?.status === 401) {
        errorMessage = "Transcription service authentication failed";
      } else if (response?.status === 429) {
        errorMessage = "Transcription service rate limit exceeded";
      } else if (response?.status >= 500) {
        errorMessage = "Transcription service server error";
      }
      
      return res.status(response?.status || 500).json({ 
        error: errorMessage,
        details: errorText,
        success: false,
        retryCount: retryCount
      });
    }
    
    const result = await response.json();
    console.log(`✅ ElevenLabs transcription successful (${processingTime}ms, ${retryCount} retries)`);
    
    // Use the raw transcription without cleaning
    let transcriptionText = result.text || "";
    
    // Skip empty transcriptions
    if (!transcriptionText.trim()) {
      console.log("⚠️ Empty transcription result, skipping database save");
      return res.json({
        success: true,
        message: "Empty transcription - no speech detected",
        transcription: {
          text: "",
          words: [],
          duration: 0,
          wordCount: 0
        },
        processingTime: `${processingTime}ms`,
        chunkSize: audioBuffer.length
      });
    }
    
    // Save to database and generate summary
    try {
      // Get session and group
      const session = await db.collection("sessions").findOne({ code: sessionCode });
      if (!session) {
        console.log(`⚠️  Session ${sessionCode} not found in database - session may not have started recording yet`);
        return res.json({
          success: true,
          message: "Session not yet persisted - transcription processed but not saved",
          transcription: {
            text: transcriptionText,
            words: result.words || [],
            duration: result.words && result.words.length > 0 ? 
              result.words[result.words.length - 1].end : 
              Math.max(5, Math.min(60, transcriptionText.split(' ').length * 0.5)),
            wordCount: result.words ? result.words.length : 
              transcriptionText.split(' ').filter(w => w.trim().length > 0).length
          },
          processingTime: `${processingTime}ms`,
          chunkSize: audioBuffer.length
        });
      }
      
      // Define the timestamp for this processing
      const now = Date.now();
      
      const group = await db.collection("groups").findOne({ 
        session_id: session._id, 
        number: parseInt(groupNumber) 
      });
      if (!group) {
        console.log(`⚠️  Group ${groupNumber} not found in database - creating new group`);
        
        // Create the group since it doesn't exist
        const newGroupId = uuid();
        await db.collection("groups").insertOne({
          _id: newGroupId,
          session_id: session._id,
          number: parseInt(groupNumber)
        });
        
        console.log(`📝 Created new group: Session ${sessionCode}, Group ${groupNumber}, ID: ${newGroupId}`);
        
        // Continue with the newly created group
        const newGroup = { _id: newGroupId, session_id: session._id, number: parseInt(groupNumber) };
        
        // Save transcription and continue processing with the new group
        await processTranscriptionForGroup(session, newGroup, transcriptionText, result, now, sessionCode, groupNumber);
      } else {
        // Process with existing group
        await processTranscriptionForGroup(session, group, transcriptionText, result, now, sessionCode, groupNumber);
      }
      
      console.log(`✅ Transcription and summary saved for session ${sessionCode}, group ${groupNumber}`);
      
    } catch (dbError) {
      console.error("❌ Database error:", dbError);
      // Still return success for transcription even if DB fails
      return res.json({
        success: true,
        message: "Transcription successful but database save failed",
        transcription: {
          text: transcriptionText,
          words: result.words || [],
          duration: result.words && result.words.length > 0 ? 
            result.words[result.words.length - 1].end : 
            Math.max(5, Math.min(60, transcriptionText.split(' ').length * 0.5)),
          wordCount: result.words ? result.words.length : 
            transcriptionText.split(' ').filter(w => w.trim().length > 0).length
        },
        processingTime: `${processingTime}ms`,
        chunkSize: audioBuffer.length,
        dbError: dbError.message
      });
    }
    
    const finalResult = {
      success: true,
      transcription: {
        text: transcriptionText,
        words: result.words || [],
        duration: result.words && result.words.length > 0 ? 
          result.words[result.words.length - 1].end : 
          Math.max(5, Math.min(60, transcriptionText.split(' ').length * 0.5)),
        wordCount: result.words ? result.words.length : 
          transcriptionText.split(' ').filter(w => w.trim().length > 0).length
      },
      processingTime: `${processingTime}ms`,
      chunkSize: audioBuffer.length,
      retryCount: retryCount
    };
    
    console.log("📝 Chunk transcription result:", {
      text: transcriptionText.substring(0, 100) + (transcriptionText.length > 100 ? "..." : ""),
      wordCount: finalResult.transcription.wordCount,
      duration: finalResult.transcription.duration,
      retries: retryCount
    });
    
    res.json(finalResult);
    
  } catch (err) {
    console.error("❌ Chunk transcription error:", err);
    res.status(500).json({ 
      error: "Internal server error during transcription", 
      details: err.message,
      success: false,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  }
});

// Helper function to process transcription for a group
async function processTranscriptionForGroup(session, group, transcriptionText, result, now, sessionCode, groupNumber) {
  try {
    // Save the transcription segment
    const transcriptId = uuid();
    
    const wordCount = result.words && result.words.length > 0 ? 
      result.words.length : 
      transcriptionText.split(' ').filter(w => w.trim().length > 0).length;
    
    const duration = result.words && result.words.length > 0 ? 
      result.words[result.words.length - 1].end : 
      Math.max(5, Math.min(60, transcriptionText.split(' ').length * 0.5));
    
    await db.collection("transcripts").insertOne({
      _id: transcriptId,
      group_id: group._id,
      text: transcriptionText,
      word_count: wordCount,
      duration_seconds: duration,
      created_at: now,
      segment_number: Math.floor(now / (session.interval_ms || 30000))
    });
    
    // Get all transcripts for this group to create cumulative conversation
    const allTranscripts = await db.collection("transcripts").find({ 
      group_id: group._id 
    }).sort({ created_at: 1 }).toArray();
    
    // Create cumulative conversation text (chronological order)
    const cumulativeText = allTranscripts.map(t => t.text).join(' ');
    
    // Generate summary of the entire conversation so far
    console.log("🤖 Generating summary of full conversation...");
    
    // Get custom prompt for this session
    let customPrompt = null;
    const promptData = await db.collection("session_prompts").findOne({ session_id: session._id });
    customPrompt = promptData?.prompt || null;
    
    const summary = await summarise(cumulativeText, customPrompt);
    
    // Save/update the summary
    await db.collection("summaries").findOneAndUpdate(
      { group_id: group._id },
      { $set: { text: summary, updated_at: now } },
      { upsert: true }
    );
    
    // Send both new transcription and updated summary to clients
    const roomName = `${sessionCode}-${groupNumber}`;
    io.to(roomName).emit("transcription_and_summary", {
      transcription: {
        text: transcriptionText, // Current chunk only
        cumulativeText: cumulativeText, // Full conversation so far
        words: result.words,
        duration: duration,
        wordCount: wordCount
      },
      summary,
      isLatestSegment: true
    });
    
    // Send update to admin console
    io.to(sessionCode).emit("admin_update", {
      group: groupNumber,
      latestTranscript: transcriptionText,
      cumulativeTranscript: cumulativeText, // Add full conversation for admin
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
    
    // Clean up old transcripts to prevent memory issues (keep last 100 per group)
    if (allTranscripts.length > 100) {
      const oldTranscripts = allTranscripts.slice(0, -100);
      const oldTranscriptIds = oldTranscripts.map(t => t._id);
      
      await db.collection("transcripts").deleteMany({
        _id: { $in: oldTranscriptIds }
      });
      
      console.log(`🧹 Cleaned up ${oldTranscripts.length} old transcripts for group ${groupNumber}`);
    }
    
  } catch (error) {
    console.error(`❌ Error processing transcription for group ${groupNumber}:`, error);
    throw error;
  }
}

