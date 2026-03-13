const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const Redis = require('ioredis');

// ─── Environment-aware Logger ───────────────────────────────────────────────────────
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const log = {
    info: (...args) => { if (!IS_PRODUCTION) console.log(...args); },
    warn: (...args) => { console.warn(...args); },
    error: (...args) => { console.error(...args); },
};

// ─── Redis Setup ──────────────────────────────────────────────────────────────
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const redis = new Redis(REDIS_URL, {
    retryStrategy: (times) => {
        const delay = Math.min(times * 50, 2000);
        return delay;
    },
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: false,
});

let isRedisConnected = false;

redis.on('connect', () => {
    log.info('✅ Redis connected');
    isRedisConnected = true;
});

redis.on('error', (err) => {
    log.error('❌ Redis error:', err.message);
    isRedisConnected = false;
});

redis.on('close', () => {
    log.warn('⚠️  Redis connection closed');
    isRedisConnected = false;
});

// ─── Redis Helper Functions ───────────────────────────────────────────────────
const ROOM_TTL = 3600; // 1 hour in seconds

async function saveRoomToRedis(roomId, roomData) {
    if (!isRedisConnected) return;
    try {
        // Don't serialize timers (they'll be recreated on restore)
        const cleanData = { ...roomData };
        delete cleanData.turnTimer;
        // Don't serialize grace-period timers either
        if (cleanData.disconnectedPlayers) {
            const cleaned = {};
            for (const [name, data] of Object.entries(cleanData.disconnectedPlayers)) {
                cleaned[name] = { socketId: data.socketId, wasAdmin: data.wasAdmin };
            }
            cleanData.disconnectedPlayers = cleaned;
        }
        await redis.setex(`room:${roomId}`, ROOM_TTL, JSON.stringify(cleanData));
    } catch (err) {
        log.error(`Redis save error for room ${roomId}:`, err.message);
    }
}

async function getRoomFromRedis(roomId) {
    if (!isRedisConnected) return null;
    try {
        const data = await redis.get(`room:${roomId}`);
        return data ? JSON.parse(data) : null;
    } catch (err) {
        log.error(`Redis get error for room ${roomId}:`, err.message);
        return null;
    }
}

async function deleteRoomFromRedis(roomId) {
    if (!isRedisConnected) return;
    try {
        await redis.del(`room:${roomId}`);
    } catch (err) {
        log.error(`Redis delete error for room ${roomId}:`, err.message);
    }
}

async function getAllRoomsFromRedis() {
    if (!isRedisConnected) return [];
    try {
        const keys = [];
        let cursor = '0';
        do {
            const [nextCursor, batch] = await redis.scan(cursor, 'MATCH', 'room:*', 'COUNT', 100);
            cursor = nextCursor;
            keys.push(...batch);
        } while (cursor !== '0');
        const rooms = [];
        for (const key of keys) {
            const data = await redis.get(key);
            if (data) rooms.push(JSON.parse(data));
        }
        return rooms;
    } catch (err) {
        log.error('Redis get all rooms error:', err.message);
        return [];
    }
}

let FUN_QUESTIONS = [];
let LOVE_QUESTIONS = [];
let SPICY_QUESTIONS = [];

try {
    FUN_QUESTIONS = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'fun.json'), 'utf8'));
    LOVE_QUESTIONS = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'love.json'), 'utf8'));
    SPICY_QUESTIONS = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'spicy.json'), 'utf8'));
    log.info(`Loaded Questions: Fun(${FUN_QUESTIONS.length}), Love(${LOVE_QUESTIONS.length}), Spicy(${SPICY_QUESTIONS.length})`);
} catch (err) {
    log.error("Error loading question files:", err);
}

// ─── Constants ────────────────────────────────────────────────────────────────
// How long (ms) a disconnected player has to reconnect before being removed.
const RECONNECT_GRACE_MS = 60_000;
const MAX_PUBLIC_PLAYERS = 15;

const getQuestion = (room, action) => {
    const settings = room.settings || { fun: 100, love: 50, spicy: 10 };

    // Normalization logic for Toggle Switches (Boolean) or Sliders (Numbers)
    // If Boolean: true -> 1, false -> 0.
    // If Number: use value directly (or cap at 1? User asked for On/Off, so treat >0 as 1 is safer for equal probability).
    // Let's standardise: On means Weight 1. Off means Weight 0.
    // This gives Equal Probability to all active categories. (33% each if all 3 on).

    const wFun = (settings.fun === true || settings.fun > 0) ? 1 : 0;
    const wLove = (settings.love === true || settings.love > 0) ? 1 : 0;
    const wSpicy = (settings.spicy === true || settings.spicy > 0) ? 1 : 0;
    const totalWeight = wFun + wLove + wSpicy;

    let targetCategory = 'fun'; // Default

    if (totalWeight > 0) {
        const rand = Math.random() * totalWeight;
        if (rand < wFun) targetCategory = 'fun';
        else if (rand < wFun + wLove) targetCategory = 'love';
        else targetCategory = 'spicy';
    }

    // Select source array
    let sourcePool = [];
    if (targetCategory === 'fun') sourcePool = FUN_QUESTIONS;
    else if (targetCategory === 'love') sourcePool = LOVE_QUESTIONS;
    else sourcePool = SPICY_QUESTIONS;

    // Filter by Action (Truth/Dare)
    // Note: The new JSON files have "type": "Truth" or "Dare" (Capitalized).
    // Action passed is 'Truth' or 'Dare'.
    const validQuestions = sourcePool.filter(q =>
        q.type.toLowerCase() === action.toLowerCase()
    );

    if (validQuestions.length > 0) {
        const q = validQuestions[Math.floor(Math.random() * validQuestions.length)];
        return q.text;
    }

    // Fallback if selected category is empty implies configuration error or bad luck with filtering
    // Try Fun as fallback
    if (targetCategory !== 'fun') {
        const funValid = FUN_QUESTIONS.filter(q => q.type.toLowerCase() === action.toLowerCase());
        if (funValid.length > 0) return funValid[Math.floor(Math.random() * funValid.length)].text;
    }

    return `No ${action} available! Adjust your settings.`;
};

const app = express();
app.use(cors());

// Health Check Endpoint (for Docker/Dokploy)
app.get('/api/health', (req, res) => {
    res.status(200).json({
        status: 'ok',
        redis: isRedisConnected ? 'connected' : 'disconnected',
        uptime: process.uptime(),
        rooms: Object.keys(rooms).length
    });
});

// API Route for Data Sync
app.get('/api/data', (req, res) => {
    res.json({
        fun: FUN_QUESTIONS,
        love: LOVE_QUESTIONS,
        spicy: SPICY_QUESTIONS,
        version: Date.now()
    });
});

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: process.env.CORS_ORIGIN || "*",
        methods: ["GET", "POST"]
    }
});

// Game State (In-Memory)
const rooms = {};

// Chat rate limiting: per-socket sliding window
const chatRateLimits = new Map();
const CHAT_RATE_LIMIT = 5;       // max messages
const CHAT_RATE_WINDOW = 10000;  // per 10 seconds
const MAX_MESSAGE_LENGTH = 300;

function isChatRateLimited(socketId) {
    const now = Date.now();
    if (!chatRateLimits.has(socketId)) chatRateLimits.set(socketId, []);
    const timestamps = chatRateLimits.get(socketId).filter(t => now - t < CHAT_RATE_WINDOW);
    chatRateLimits.set(socketId, timestamps);
    if (timestamps.length >= CHAT_RATE_LIMIT) return true;
    timestamps.push(now);
    return false;
}

// General event rate limiting: per-socket per-event sliding window
const eventRateLimits = new Map();
function isEventRateLimited(socketId, event, limit = 3, windowMs = 5000) {
    const key = `${socketId}:${event}`;
    const now = Date.now();
    if (!eventRateLimits.has(key)) eventRateLimits.set(key, []);
    const timestamps = eventRateLimits.get(key).filter(t => now - t < windowMs);
    eventRateLimits.set(key, timestamps);
    if (timestamps.length >= limit) return true;
    timestamps.push(now);
    return false;
}

// Sanitize player name: trim, cap at 20 chars, fallback
function sanitizeName(name, fallback = 'Player') {
    return (typeof name === 'string' ? name : '').trim().slice(0, 20) || fallback;
}

// Reports log (in-memory — swap for DB in production, capped at 1000)
const reports = [];

// ─── Restore Rooms from Redis on Startup ─────────────────────────────────────
(async () => {
    log.info('🔄 Restoring rooms from Redis...');
    const savedRooms = await getAllRoomsFromRedis();
    for (const roomData of savedRooms) {
        // Restore room to memory, but don't restore timers (they need active sockets)
        rooms[roomData.id] = {
            ...roomData,
            turnTimer: null,
            disconnectedPlayers: {} // Clear grace-period timers on restart
        };
    }
    log.info(`✅ Restored ${savedRooms.length} rooms from Redis`);
})();

io.on('connection', (socket) => {
    log.info(`User connected: ${socket.id}`);

    // Create Room
    socket.on('create_room', (data) => {
        if (isEventRateLimited(socket.id, 'create_room', 2, 10000)) return;
        const roomId = Math.random().toString(36).substring(2, 7).toUpperCase();
        const playerName = sanitizeName(data.name, 'Host');
        const requestedRoomType = (data.roomType === 'public') ? 'public' : 'private';
        const requestedRoomName = (typeof data.roomName === 'string' ? data.roomName : '').trim().slice(0, 30)
            || `${playerName}'s Room`;
        rooms[roomId] = {
            id: roomId,
            adminId: socket.id,
            players: [{ id: socket.id, name: playerName }],
            // ── Server-side game state (source of truth for reconnects) ──
            currentPlayerIndex: 0,
            gameState: 'waiting',       // 'waiting' | 'spinning' | 'result' | 'action'
            currentAction: null,        // 'Truth' | 'Dare' | null
            currentQuestion: null,      // string | null
            spinAngle: 0,               // last bottle angle (for visual restore)
            // ── Settings ──
            settings: data.settings || { fun: true, love: false, spicy: false },
            // ── Room type & visibility ──
            roomType: requestedRoomType,
            roomName: requestedRoomName,
            // ── Disconnect grace-period tracking ──
            // key = player username, value = { socketId, wasAdmin, timer }
            disconnectedPlayers: {},
            turnTimer: null,
        };
        socket.join(roomId);
        saveRoomToRedis(roomId, rooms[roomId]); // Persist to Redis
        socket.emit('room_created', rooms[roomId]);
        log.info(`Room created: ${roomId}`);
    });

    // Join Room — also handles a fresh-join where disconnected entry already exists
    socket.on('join_room', (data) => {
        if (isEventRateLimited(socket.id, 'join_room', 3, 10000)) return;
        const roomId = data.roomId;
        const name = sanitizeName(data.name);
        const room = rooms[roomId];
        if (!room) {
            socket.emit('error', { message: 'Room not found' });
            return;
        }

        // Enforce public room player cap (allow reconnects / already-connected through)
        if (room.roomType === 'public' && !room.disconnectedPlayers[name] &&
            !room.players.some(p => p.id === socket.id) &&
            room.players.length >= MAX_PUBLIC_PLAYERS) {
            socket.emit('error', { message: `This public room is full (max ${MAX_PUBLIC_PLAYERS} players).` });
            return;
        }

        // Already connected with this socket id?
        const alreadyConnected = room.players.some(p => p.id === socket.id);
        if (alreadyConnected) {
            socket.emit('room_joined', room);
            return;
        }

        // Was this username in the grace-period list? If so, treat as rejoin
        const pending = room.disconnectedPlayers[name];
        if (pending) {
            clearTimeout(pending.timer);
            delete room.disconnectedPlayers[name];

            // Update socketId in players array
            const existing = room.players.find(p => p.name === name);
            if (existing) existing.id = socket.id;

            // Restore admin if they were admin before
            if (pending.wasAdmin) room.adminId = socket.id;

            socket.join(roomId);
            socket.emit('room_rejoined', {
                room,
                // Client needs to know their restored admin status
                restoredAdmin: pending.wasAdmin,
                isReconnect: true,
            });
            io.to(roomId).emit('player_reconnected', {
                players: room.players,
                adminId: room.adminId,
            });
            log.info(`[Rejoin via join_room] ${name} restored to room ${roomId}`);
            return;
        }

        // Completely new player
        room.players.push({ id: socket.id, name: name });
        socket.join(roomId);
        saveRoomToRedis(roomId, room); // Persist to Redis
        socket.emit('room_joined', room);
        io.to(roomId).emit('player_joined', room);
        log.info(`User ${name} joined room ${roomId}`);
    });

    // Rejoin Room — called explicitly by client after reconnect
    socket.on('rejoin_room', (data) => {
        const { roomId, username } = data;
        const room = rooms[roomId];
        if (!room) {
            socket.emit('error', { message: 'Room expired or not found. Please start a new game.' });
            return;
        }

        const pending = room.disconnectedPlayers[username];
        if (pending) {
            clearTimeout(pending.timer);
            delete room.disconnectedPlayers[username];

            // Update socketId
            const existing = room.players.find(p => p.name === username);
            if (existing) existing.id = socket.id;

            if (pending.wasAdmin) room.adminId = socket.id;

            socket.join(roomId);
            saveRoomToRedis(roomId, room); // Persist updated socket IDs
            socket.emit('room_rejoined', {
                room,
                restoredAdmin: pending.wasAdmin,
                isReconnect: true,
            });
            io.to(roomId).emit('player_reconnected', {
                players: room.players,
                adminId: room.adminId,
            });
            log.info(`[Rejoin] ${username} restored to room ${roomId}${pending.wasAdmin ? ' as admin' : ''}`);
        } else {
            // Player wasn't in grace-period (maybe never disconnected or too late)
            // Send current state so they can at least sync
            const alreadyIn = room.players.find(p => p.name === username);
            if (alreadyIn) {
                const wasAdmin = (room.adminId === alreadyIn.id); // Check BEFORE updating socket.id
                alreadyIn.id = socket.id; // Update socket id
                if (wasAdmin) room.adminId = socket.id; // Restore admin with new socket.id
                
                socket.join(roomId);
                saveRoomToRedis(roomId, room); // Persist updated socket ID
                socket.emit('room_rejoined', { room, restoredAdmin: wasAdmin, isReconnect: false });
                io.to(roomId).emit('player_reconnected', {
                    players: room.players,
                    adminId: room.adminId,
                });
                log.info(`[Rejoin - already in room] ${username} re-synced for room ${roomId}${wasAdmin ? ' as admin' : ''}`);
            } else {
                socket.emit('error', { message: 'Could not restore session. Please rejoin manually.' });
            }
        }
    });

    // Get Room State — lets a reconnected client pull the latest state at any time
    socket.on('get_room_state', ({ roomId }) => {
        const room = rooms[roomId];
        if (room) {
            socket.emit('room_state', room);
        } else {
            socket.emit('error', { message: 'Room not found' });
        }
    });

    // List Public Rooms
    socket.on('list_public_rooms', () => {
        if (isEventRateLimited(socket.id, 'list_public_rooms', 5, 10000)) return;
        const publicRoomsList = Object.values(rooms)
            .filter(r => r.roomType === 'public' && r.players.length < MAX_PUBLIC_PLAYERS)
            .map(r => ({
                id: r.id,
                roomName: r.roomName,
                playerCount: r.players.length,
                adminName: r.players.find(p => p.id === r.adminId)?.name || 'Host',
                settings: r.settings,
            }));
        socket.emit('public_rooms_list', publicRoomsList);
    });

    // Spin Bottle
    socket.on('spin_bottle', (data) => {
        if (isEventRateLimited(socket.id, 'spin_bottle', 2, 5000)) return;
        const { roomId } = data;
        if (rooms[roomId]) {
            const room = rooms[roomId];
            const randomAngle = Math.floor(Math.random() * 360) + 720;
            const winnerIndex = Math.floor(Math.random() * room.players.length);

            // Persist spin state server-side
            room.gameState = 'spinning';
            room.currentPlayerIndex = winnerIndex;
            room.spinAngle = randomAngle;
            room.currentAction = null;
            room.currentQuestion = null;

            saveRoomToRedis(roomId, room); // Persist to Redis
            io.to(roomId).emit('bottle_spun', { angle: randomAngle, winnerIndex });

            // Start Turn Timer (3s Spin + 10s Choice + 1s Buffer = 14s)
            if (room.turnTimer) clearTimeout(room.turnTimer);
            room.turnTimer = setTimeout(() => {
                // Force Choice
                if (rooms[roomId]) {
                    const action = Math.random() > 0.5 ? 'Truth' : 'Dare';
                    const question = getQuestion(room, action);
                    room.gameState = 'action';
                    room.currentAction = action;
                    room.currentQuestion = question;
                    io.to(roomId).emit('action_chosen', { action, question, forced: true });
                }
            }, 14000);
        } else {
            socket.emit('error', { message: 'Room not found. Please create a new game.' });
        }
    });

    // Update Settings
    socket.on('update_settings', (data) => {
        const { roomId, settings, roomType, roomName } = data;
        if (rooms[roomId] && rooms[roomId].adminId === socket.id) {
            rooms[roomId].settings = settings;
            // Apply room meta changes if provided by admin
            if (roomType !== undefined) {
                rooms[roomId].roomType = roomType === 'public' ? 'public' : 'private';
                if (typeof roomName === 'string' && roomName.trim()) {
                    rooms[roomId].roomName = roomName.trim().slice(0, 30);
                } else if (!rooms[roomId].roomName) {
                    const adminName = rooms[roomId].players.find(p => p.id === rooms[roomId].adminId)?.name || 'Host';
                    rooms[roomId].roomName = `${adminName}'s Room`;
                }
            }
            saveRoomToRedis(roomId, rooms[roomId]); // Persist to Redis
            io.to(roomId).emit('settings_updated', settings);
            io.to(roomId).emit('room_meta_updated', {
                roomType: rooms[roomId].roomType,
                roomName: rooms[roomId].roomName,
            });
            log.info(`Room ${roomId} settings updated:`, settings);
        }
    });

    // Choose Action (Truth/Dare)
    socket.on('choose_action', (data) => {
        if (isEventRateLimited(socket.id, 'choose_action', 3, 5000)) return;
        const { roomId, action } = data;
        if (rooms[roomId]) {
            const room = rooms[roomId];

            // Clear Forced Choice Timer
            if (room.turnTimer) clearTimeout(room.turnTimer);

            const selectedQuestion = getQuestion(room, action);

            // Persist action state server-side
            room.gameState = 'action';
            room.currentAction = action;
            room.currentQuestion = selectedQuestion;

            saveRoomToRedis(roomId, room); // Persist to Redis
            io.to(roomId).emit('action_chosen', { action, question: selectedQuestion });
        } else {
            socket.emit('error', { message: 'Room not found. Please create a new game.' });
        }
    });

    // Next Turn
    socket.on('next_turn', (data) => {
        if (isEventRateLimited(socket.id, 'next_turn', 3, 5000)) return;
        const { roomId } = data;
        if (rooms[roomId]) {
            const room = rooms[roomId];
            // Reset server state for next turn
            room.gameState = 'waiting';
            room.currentAction = null;
            room.currentQuestion = null;
            saveRoomToRedis(roomId, room); // Persist to Redis
            io.to(roomId).emit('next_turn');
        } else {
            socket.emit('error', { message: 'Room not found. Please create a new game.' });
        }
    });

    // Request Admin
    socket.on('request_admin', (data) => {
        if (isEventRateLimited(socket.id, 'request_admin', 1, 30000)) return;
        const { roomId } = data;
        if (rooms[roomId]) {
            const room = rooms[roomId];
            const requester = room.players.find(p => p.id === socket.id);
            if (requester && room.adminId) {
                io.to(room.adminId).emit('admin_requested', {
                    requesterId: socket.id,
                    requesterName: requester.name
                });
            }
        }
    });

    // Respond to Admin Request
    socket.on('respond_admin', (data) => {
        const { roomId, requesterId, accepted } = data;
        if (rooms[roomId]) {
            const room = rooms[roomId];
            if (socket.id === room.adminId && accepted) {
                room.adminId = requesterId;
                const newAdmin = room.players.find(p => p.id === requesterId);
                saveRoomToRedis(roomId, room); // Persist to Redis
                io.to(roomId).emit('admin_changed', {
                    adminId: requesterId,
                    adminName: newAdmin ? newAdmin.name : 'Unknown'
                });
            }
        }
    });

    // Chat Message (with rate limiting + length validation)
    socket.on('send_message', (data) => {
        const { roomId, message, senderName } = data;
        if (!rooms[roomId]) return;

        // Rate limit check
        if (isChatRateLimited(socket.id)) {
            socket.emit('chat_rate_limited', { message: 'You are sending messages too fast. Please wait a moment.' });
            return;
        }

        // Validate & sanitize
        const cleanMessage = (typeof message === 'string' ? message : '').trim().slice(0, MAX_MESSAGE_LENGTH);
        const cleanName = (typeof senderName === 'string' ? senderName : 'Player').trim().slice(0, 20);
        if (!cleanMessage) return;

        io.to(roomId).emit('receive_message', {
            id: Date.now().toString() + Math.random().toString(),
            senderId: socket.id,
            senderName: cleanName,
            message: cleanMessage,
            timestamp: new Date().toISOString()
        });
    });

    // Report Room / Player
    socket.on('report_room', (data) => {
        const { roomId, reason, details } = data;
        if (!rooms[roomId]) return;
        const reporter = rooms[roomId].players.find(p => p.id === socket.id);
        const report = {
            id: Date.now().toString(),
            roomId,
            reporterSocketId: socket.id,
            reporterName: reporter?.name || 'Unknown',
            reason: (typeof reason === 'string' ? reason : '').slice(0, 100),
            details: (typeof details === 'string' ? details : '').slice(0, 500),
            timestamp: new Date().toISOString(),
            playerCount: rooms[roomId].players.length
        };
        reports.push(report);
        if (reports.length > 1000) reports.shift(); // Cap to prevent memory leak
        log.info('[REPORT]', JSON.stringify(report));
        socket.emit('report_submitted', { success: true, message: 'Report submitted. Thank you for helping keep the community safe.' });
    });

    const handlePlayerLeave = (socketId, { immediate = false } = {}) => {
        for (const roomId in rooms) {
            const room = rooms[roomId];
            const index = room.players.findIndex(p => p.id === socketId);
            if (index === -1) continue;

            const player = room.players[index];
            const wasAdmin = (room.adminId === socketId);

            if (!immediate) {
                // ── Grace period: give the player 60 s to reconnect ──────────
                const timer = setTimeout(() => {
                    // If still disconnected after grace period, actually remove them
                    _removePlayer(roomId, socketId, player.name, wasAdmin);
                }, RECONNECT_GRACE_MS);

                room.disconnectedPlayers[player.name] = { socketId, wasAdmin, timer };
                log.info(`[Grace] ${player.name} disconnected from ${roomId}. Waiting ${RECONNECT_GRACE_MS / 1000}s…`);

                // Notify others that this person is temporarily offline
                io.to(roomId).emit('player_disconnected', {
                    playerName: player.name,
                    players: room.players,   // still shown — just marked away
                });
            } else {
                // Explicit leave (leave_room event / kick) — remove immediately
                _removePlayer(roomId, socketId, player.name, wasAdmin);
            }
            break;
        }
    };

    // Internal: permanently remove a player from a room
    const _removePlayer = (roomId, socketId, playerName, wasAdmin) => {
        const room = rooms[roomId];
        if (!room) return;

        // Cancel any pending grace timer for this player (safety)
        const pending = room.disconnectedPlayers[playerName];
        if (pending) {
            clearTimeout(pending.timer);
            delete room.disconnectedPlayers[playerName];
        }

        const index = room.players.findIndex(p => p.id === socketId || p.name === playerName);
        if (index === -1) return;
        room.players.splice(index, 1);

        if (room.players.length === 0) {
            // Only delete if no one else is still in the grace-period waiting
            const pendingCount = Object.keys(room.disconnectedPlayers).length;
            if (pendingCount === 0) {
                if (room.turnTimer) clearTimeout(room.turnTimer);
                delete rooms[roomId];
                deleteRoomFromRedis(roomId); // Remove from Redis
                log.info(`Room ${roomId} deleted (empty + no pending reconnects)`);
            }
        } else {
            let newAdminName = null;
            if (wasAdmin) {
                const newAdmin = room.players[Math.floor(Math.random() * room.players.length)];
                room.adminId = newAdmin.id;
                newAdminName = newAdmin.name;
                io.to(roomId).emit('admin_changed', {
                    adminId: newAdmin.id,
                    adminName: newAdmin.name
                });
            }
            io.to(roomId).emit('player_left', {
                players: room.players,
                playerName,
                wasAdmin,
                newAdminName,
            });
            // Only force a round reset when the admin left.
            if (wasAdmin) {
                io.to(roomId).emit('game_reset');
                room.gameState = 'waiting';
                room.currentAction = null;
                room.currentQuestion = null;
            }
            saveRoomToRedis(roomId, room); // Persist to Redis
        }
        log.info(`[Remove] ${playerName} permanently removed from room ${roomId}`);
    };

    // Leave Room (Explicit — player tapped "Exit")
    socket.on('leave_room', () => {
        handlePlayerLeave(socket.id, { immediate: true });
    });

    socket.on('kick_player', ({ roomId, playerId }) => {
        if (isEventRateLimited(socket.id, 'kick_player', 3, 10000)) return;
        const room = rooms[roomId];
        if (room && room.adminId === socket.id) {
            const playerIndex = room.players.findIndex(p => p.id === playerId);
            if (playerIndex !== -1) {
                const kickedPlayer = room.players[playerIndex];
                // Notify kicked player specifically
                io.to(kickedPlayer.id).emit('kicked');
                // Remove immediately (kick = no grace period)
                handlePlayerLeave(kickedPlayer.id, { immediate: true });
            }
        }
    });

    // Disconnect — use grace period so switching apps doesn't break the game
    socket.on('disconnect', () => {
        log.info(`User disconnected: ${socket.id}`);
        chatRateLimits.delete(socket.id);
        // Clean up event rate limits for this socket
        for (const key of eventRateLimits.keys()) {
            if (key.startsWith(socket.id + ':')) eventRateLimits.delete(key);
        }
        handlePlayerLeave(socket.id, { immediate: false });
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    log.info(`Server running on port ${PORT}`);
});
