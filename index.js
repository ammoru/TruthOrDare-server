const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

let FUN_QUESTIONS = [];
let LOVE_QUESTIONS = [];
let SPICY_QUESTIONS = [];

try {
    FUN_QUESTIONS = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'fun.json'), 'utf8'));
    LOVE_QUESTIONS = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'love.json'), 'utf8'));
    SPICY_QUESTIONS = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'spicy.json'), 'utf8'));
    console.log(`Loaded Questions: Fun(${FUN_QUESTIONS.length}), Love(${LOVE_QUESTIONS.length}), Spicy(${SPICY_QUESTIONS.length})`);
} catch (err) {
    console.error("Error loading question files:", err);
}

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
        return `[${targetCategory.toUpperCase()}] ${q.text}`; // Optional: Show category tag? Or just text.
        // User asked "we should not ask about the images... Just found these can generate...".
        // I'll return just text.
        // Or maybe with emoji? The text has emoji.
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
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Game State (In-Memory)
const rooms = {};

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    // Create Room
    socket.on('create_room', (data) => {
        const roomId = Math.random().toString(36).substring(2, 7).toUpperCase();
        rooms[roomId] = {
            id: roomId,
            adminId: socket.id,
            players: [{ id: socket.id, name: data.name || 'Host' }],
            currentPlayerIndex: 0,
            gameState: 'waiting',
            settings: data.settings || { fun: 100, love: 50, spicy: 10 } // Default Settings
        };
        socket.join(roomId);
        socket.emit('room_created', rooms[roomId]);
        console.log(`Room created: ${roomId}`);
    });

    // Join Room
    socket.on('join_room', (data) => {
        const { roomId, name } = data;
        if (rooms[roomId]) {
            rooms[roomId].players.push({ id: socket.id, name: name || 'Player' });
            socket.join(roomId);
            io.to(roomId).emit('player_joined', rooms[roomId]);
            console.log(`User ${name} joined room ${roomId}`);
        } else {
            socket.emit('error', { message: 'Room not found' });
        }
    });

    // Spin Bottle
    socket.on('spin_bottle', (data) => {
        const { roomId } = data;
        if (rooms[roomId]) {
            const room = rooms[roomId];
            const randomAngle = Math.floor(Math.random() * 360) + 720;
            const winnerIndex = Math.floor(Math.random() * room.players.length);
            io.to(roomId).emit('bottle_spun', { angle: randomAngle, winnerIndex });

            // Start Turn Timer (3s Spin + 10s Choice + 1s Buffer = 14s)
            if (room.turnTimer) clearTimeout(room.turnTimer);
            room.turnTimer = setTimeout(() => {
                // Force Choice
                if (rooms[roomId]) { // Check if room still exists
                    const action = Math.random() > 0.5 ? 'Truth' : 'Dare';
                    const question = getQuestion(room, action);
                    io.to(roomId).emit('action_chosen', { action, question, forced: true });
                }
            }, 14000);
        } else {
            socket.emit('error', { message: 'Room not found. Please create a new game.' });
        }
    });

    // Update Settings
    socket.on('update_settings', (data) => {
        const { roomId, settings } = data;
        if (rooms[roomId] && rooms[roomId].adminId === socket.id) {
            rooms[roomId].settings = settings;
            io.to(roomId).emit('settings_updated', settings);
            console.log(`Room ${roomId} settings updated:`, settings);
        }
    });

    // Choose Action (Truth/Dare)
    socket.on('choose_action', (data) => {
        const { roomId, action } = data;
        if (rooms[roomId]) {
            const room = rooms[roomId];

            // Clear Forced Choice Timer
            if (room.turnTimer) clearTimeout(room.turnTimer);

            const selectedQuestion = getQuestion(room, action);
            io.to(roomId).emit('action_chosen', { action, question: selectedQuestion });
        } else {
            socket.emit('error', { message: 'Room not found. Please create a new game.' });
        }
    });

    // Next Turn
    socket.on('next_turn', (data) => {
        const { roomId } = data;
        if (rooms[roomId]) {
            io.to(roomId).emit('next_turn');
        } else {
            socket.emit('error', { message: 'Room not found. Please create a new game.' });
        }
    });

    // Request Admin
    socket.on('request_admin', (data) => {
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
                io.to(roomId).emit('admin_changed', {
                    adminId: requesterId,
                    adminName: newAdmin ? newAdmin.name : 'Unknown'
                });
            }
        }
    });

    // Chat Message
    socket.on('send_message', (data) => {
        const { roomId, message, senderName } = data;
        if (rooms[roomId]) {
            io.to(roomId).emit('receive_message', {
                id: Date.now().toString() + Math.random().toString(),
                senderId: socket.id,
                senderName,
                message,
                timestamp: new Date().toISOString()
            });
        }
    });

    const handlePlayerLeave = (socketId) => {
        for (const roomId in rooms) {
            const room = rooms[roomId];
            const index = room.players.findIndex(p => p.id === socketId);
            if (index !== -1) {
                const wasAdmin = (room.adminId === socketId);
                room.players.splice(index, 1);

                if (room.players.length === 0) {
                    if (room.turnTimer) clearTimeout(room.turnTimer); // Clear timer
                    delete rooms[roomId];
                    console.log(`Room ${roomId} deleted (empty)`);
                } else {
                    if (wasAdmin && room.players.length > 0) {
                        const newAdmin = room.players[Math.floor(Math.random() * room.players.length)];
                        room.adminId = newAdmin.id;
                        io.to(roomId).emit('admin_changed', {
                            adminId: newAdmin.id,
                            adminName: newAdmin.name
                        });
                    }
                    io.to(roomId).emit('player_left', room.players);
                    // Reset game state for everyone remaining
                    io.to(roomId).emit('game_reset');
                }
                break;
            }
        }
    };

    // Leave Room (Explicit)
    socket.on('leave_room', () => {
        handlePlayerLeave(socket.id);
    });

    socket.on('kick_player', ({ roomId, playerId }) => {
        const room = rooms[roomId];
        if (room && room.adminId === socket.id) {
            const playerIndex = room.players.findIndex(p => p.id === playerId);
            if (playerIndex !== -1) {
                const kickedPlayer = room.players[playerIndex];

                // Notify kicked player specifically
                io.to(kickedPlayer.id).emit('kicked');

                // Remove player via handlePlayerLeave (ensures consistency)
                // Wait, handlePlayerLeave relies on socket.id passed to it?
                // No, handlePlayerLeave iterates all rooms to find where socket is.
                // But kickedPlayer.id IS socket.id.
                // So calling handlePlayerLeave(kickedPlayer.id) works perfect!
                handlePlayerLeave(kickedPlayer.id);
            }
        }
    });

    // Disconnect
    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
        handlePlayerLeave(socket.id);
    });
});

const PORT = 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});
