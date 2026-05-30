const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'questlife_super_secret_key_13579';

// =================================================================
// KONFIGURASI KONEKSI DATABASE POSTGRESQL
// =================================================================
const pool = new Pool({
    user: process.env.DB_USER || 'postgres',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'questlife',
    password: process.env.DB_PASSWORD || 'password_postgres_anda',
    port: process.env.DB_PORT || 5432,
});

app.use(express.json());

// --- SERVE PWA FILES ---
// Endpoint agar browser bisa membaca file manifest dan service worker
app.get('/manifest.json', (req, res) => {
    res.sendFile(path.join(__dirname, 'manifest.json'));
});

app.get('/service-worker.js', (req, res) => {
    res.setHeader('Content-Type', 'application/javascript');
    res.sendFile(path.join(__dirname, 'service-worker.js'));
});

// --- MIDDLEWARE AUTENTIKASI ---
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) return res.status(401).json({ error: 'Token tidak ditemukan. Akses ditolak.' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Token tidak valid atau kedaluwarsa.' });
        req.user = user;
        next();
    });
};

// =================================================================
// ENDPOINT API BACKEND (POSTGRESQL)
// =================================================================

// 1. Register User
app.post('/api/auth/register', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ error: 'Email dan password wajib diisi.' });
    }

    try {
        const userExists = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (userExists.rows.length > 0) {
            return res.status(400).json({ error: 'Email sudah terdaftar.' });
        }

        const salt = await bcrypt.genSalt(10);
        const hash = await bcrypt.hash(password, salt);

        const newUser = await pool.query(
            `INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email`,
            [email, hash]
        );

        const userId = newUser.rows[0].id;

        // Tambahkan quest default
        await pool.query(`
            INSERT INTO quests (user_id, title, type, difficulty, xp, gold) VALUES
            (${userId}, 'Olahraga Ringan 15 Minit', 'STR', 'Sedang', 20, 10),
            (${userId}, 'Membaca Buku Pendidikan / Hobi', 'INT', 'Sedang', 20, 10)
        `);

        // Tambahkan reward default
        await pool.query(`
            INSERT INTO rewards (user_id, title, cost) VALUES
            (${userId}, 'Menonton Movie 1 Episod', 30)
        `);

        // Tambahkan log pertama
        await pool.query(`
            INSERT INTO logs (user_id, text, log_time) VALUES
            (${userId}, 'Karakter berjaya dicipta! Selamat mengembara.', 'Sistem')
        `);

        const token = jwt.sign({ id: userId, email: email }, JWT_SECRET, { expiresIn: '30d' });
        res.json({ token, email });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Terjadi ralat pada server saat mendaftar.' });
    }
});

// 2. Login User
app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (result.rows.length === 0) {
            return res.status(400).json({ error: 'Email atau kata laluan salah.' });
        }

        const user = result.rows[0];
        const validPass = await bcrypt.compare(password, user.password_hash);
        if (!validPass) {
            return res.status(400).json({ error: 'Email atau kata laluan salah.' });
        }

        const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
        res.json({ token, email: user.email });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Terjadi ralat server saat masuk.' });
    }
});

// 3. Ambil Semua Data Game Player (Sync)
app.get('/api/game/state', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        
        const userQuery = await pool.query('SELECT id, email, player_name, level, xp, xp_needed, hp, max_hp, gold, stat_str, stat_int, stat_dex, stat_wis FROM users WHERE id = $1', [userId]);
        const questsQuery = await pool.query('SELECT id, title, type, difficulty, xp, gold, completed_today FROM quests WHERE user_id = $1 ORDER BY id DESC', [userId]);
        const rewardsQuery = await pool.query('SELECT id, title, cost, count FROM rewards WHERE user_id = $1 ORDER BY id DESC', [userId]);
        const logsQuery = await pool.query('SELECT id, text, log_time FROM logs WHERE user_id = $1 ORDER BY id DESC LIMIT 50', [userId]);

        const dbUser = userQuery.rows[0];
        
        const playerState = {
            name: dbUser.player_name,
            level: dbUser.level,
            xp: dbUser.xp,
            xpNeeded: dbUser.xp_needed,
            hp: dbUser.hp,
            maxHp: dbUser.max_hp,
            gold: dbUser.gold,
            stats: {
                str: dbUser.stat_str,
                int: dbUser.stat_int,
                dex: dbUser.stat_dex,
                wis: dbUser.stat_wis
            }
        };

        res.json({
            player: playerState,
            quests: questsQuery.rows.map(q => ({
                id: q.id.toString(),
                title: q.title,
                type: q.type,
                difficulty: q.difficulty,
                xp: q.xp,
                gold: q.gold,
                completedToday: q.completed_today
            })),
            rewards: rewardsQuery.rows.map(r => ({
                id: r.id.toString(),
                title: r.title,
                cost: r.cost,
                count: r.count
            })),
            logs: logsQuery.rows.map(l => ({
                id: l.id.toString(),
                text: l.text,
                time: l.log_time
            }))
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Gagal mengambil data.' });
    }
});

// 4. Update Seluruh Game State (Simpan Perkembangan)
app.post('/api/game/save', authenticateToken, async (req, res) => {
    const { player, quests, rewards, logs } = req.body;
    const userId = req.user.id;

    try {
        await pool.query('BEGIN');

        await pool.query(
            `UPDATE users SET 
                player_name = $1, level = $2, xp = $3, xp_needed = $4, hp = $5, max_hp = $6, gold = $7,
                stat_str = $8, stat_int = $9, stat_dex = $10, stat_wis = $11
             WHERE id = $12`,
            [
                player.name, player.level, player.xp, player.xpNeeded, player.hp, player.maxHp, player.gold,
                player.stats.str, player.stats.int, player.stats.dex, player.stats.wis, userId
            ]
        );

        await pool.query('DELETE FROM quests WHERE user_id = $1', [userId]);
        for (const q of quests) {
            await pool.query(
                `INSERT INTO quests (user_id, title, type, difficulty, xp, gold, completed_today) 
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [userId, q.title, q.type, q.difficulty, q.xp, q.gold, q.completedToday]
            );
        }

        await pool.query('DELETE FROM rewards WHERE user_id = $1', [userId]);
        for (const r of rewards) {
            await pool.query(
                `INSERT INTO rewards (user_id, title, cost, count) VALUES ($1, $2, $3, $4)`,
                [userId, r.title, r.cost, r.count]
            );
        }

        await pool.query('DELETE FROM logs WHERE user_id = $1', [userId]);
        const truncatedLogs = logs.slice(0, 50);
        for (const l of truncatedLogs) {
            await pool.query(
                `INSERT INTO logs (user_id, text, log_time) VALUES ($1, $2, $3)`,
                [userId, l.text, l.time]
            );
        }

        await pool.query('COMMIT');
        res.json({ success: true, message: 'Kemajuan berhasil disimpan!' });
    } catch (err) {
        await pool.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ error: 'Gagal mengamankan data.' });
    }
});


// =================================================================
// FRONTEND SERVING (HTML + REACT + PWA SUPPORT)
// =================================================================

app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>QuestLife - PWA Habit RPG</title>
    
    <!-- PWA Meta Tags & Manifest -->
    <link rel="manifest" href="/manifest.json">
    <meta name="theme-color" content="#f59e0b">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    <link rel="apple-touch-icon" href="https://cdn-icons-png.flaticon.com/512/3408/3408506.png">

    <script src="https://cdn.tailwindcss.com"></script>
    <script>
        tailwind.config = {
            theme: {
                extend: {
                    colors: {
                        slate: { 950: '#0b1329' }
                    }
                }
            }
        }
    </script>
    <script src="https://unpkg.com/react@18/umd/react.production.min.js" crossorigin></script>
    <script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js" crossorigin></script>
    <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen">

    <div id="root"></div>

    <script type="text/babel">
        const { useState, useEffect } = React;

        const Icons = {
            Sword: () => <svg className="w-5 h-5 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M11.5 12.5h3m-3 0V15m0-2.5h-3m3 0V10M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>,
            Book: () => <svg className="w-5 h-5 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" /></svg>,
            Shield: () => <svg className="w-5 h-5 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" /></svg>,
            Compass: () => <svg className="w-5 h-5 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" /></svg>,
            Coins: () => <svg className="w-5 h-5 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>,
            Heart: () => <svg className="w-5 h-5 text-red-500" fill="currentColor" viewBox="0 0 24 24"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>,
            Trash: () => <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
        };

        function App() {
            const [token, setToken] = useState(localStorage.getItem('ql_token') || null);
            const [userEmail, setUserEmail] = useState(localStorage.getItem('ql_email') || '');
            const [authLoading, setAuthLoading] = useState(false);
            const [isRegistering, setIsRegistering] = useState(false);
            const [emailInput, setEmailInput] = useState('');
            const [passwordInput, setPasswordInput] = useState('');
            const [authError, setAuthError] = useState('');

            // Game States
            const [player, setPlayer] = useState({
                name: "Satria Baru", level: 1, xp: 0, xpNeeded: 100, hp: 100, maxHp: 100, gold: 50,
                stats: { str: 10, int: 10, dex: 10, wis: 10 }
            });
            const [quests, setQuests] = useState([]);
            const [rewards, setRewards] = useState([]);
            const [logs, setLogs] = useState([]);
            const [activeTab, setActiveTab] = useState('dashboard');
            const [syncing, setSyncing] = useState(false);
            const [notification, setNotification] = useState(null);

            // PWA Install Prompt State
            const [deferredPrompt, setDeferredPrompt] = useState(null);
            const [showInstallBtn, setShowInstallBtn] = useState(false);

            // Form Inputs
            const [newQuestTitle, setNewQuestTitle] = useState('');
            const [newQuestType, setNewQuestType] = useState('AUTO');
            const [newQuestDiff, setNewQuestDiff] = useState('Sedang');
            const [newRewardTitle, setNewRewardTitle] = useState('');
            const [newRewardCost, setNewRewardCost] = useState('');

            const triggerNotification = (msg) => {
                setNotification(msg);
                setTimeout(() => setNotification(null), 3000);
            };

            const getDateLabel = (date = new Date()) => {
                return date.toLocaleDateString('id-ID', { day: '2-digit', month: 'short' });
            };

            const createSystemLog = (text) => ({
                id: Date.now().toString(),
                text,
                time: getDateLabel()
            });

            const inferQuestType = (title, selectedType) => {
                if (selectedType !== 'AUTO') return selectedType;

                const text = title.toLowerCase();
                const rules = [
                    { type: 'STR', words: ['olahraga', 'gym', 'lari', 'jalan', 'senam', 'push up', 'sit up', 'workout', 'fisik', 'sepeda'] },
                    { type: 'INT', words: ['baca', 'membaca', 'belajar', 'coding', 'skripsi', 'tugas', 'riset', 'nulis', 'menulis', 'mandarin', 'hsk', 'kelas'] },
                    { type: 'DEX', words: ['desain', 'edit', 'gambar', 'musik', 'latihan skill', 'praktik', 'presentasi', 'video', 'kreatif'] },
                    { type: 'WIS', words: ['doa', 'renungan', 'ibadah', 'gereja', 'meditasi', 'jurnal', 'refleksi', 'tenang', 'tidur'] }
                ];

                const matched = rules.find(rule => rule.words.some(word => text.includes(word)));
                return matched ? matched.type : 'INT';
            };

            // Capture PWA Install Prompt
            useEffect(() => {
                window.addEventListener('beforeinstallprompt', (e) => {
                    e.preventDefault();
                    setDeferredPrompt(e);
                    setShowInstallBtn(true);
                });

                window.addEventListener('appinstalled', () => {
                    setShowInstallBtn(false);
                    setDeferredPrompt(null);
                    triggerNotification("QuestLife berhasil diinstal di HP Anda!");
                });
            }, []);

            const handleInstallApp = async () => {
                if (!deferredPrompt) return;
                deferredPrompt.prompt();
                const { outcome } = await deferredPrompt.userChoice;
                if (outcome === 'accepted') {
                    console.log('User menyetujui instalasi PWA');
                }
                setDeferredPrompt(null);
                setShowInstallBtn(false);
            };

            // Ambil data saat token tersedia
            useEffect(() => {
                if (token) {
                    fetchGameState();
                }
            }, [token]);

            const fetchGameState = async () => {
                setSyncing(true);
                try {
                    const res = await fetch('/api/game/state', {
                        headers: { 'Authorization': 'Bearer ' + token }
                    });
                    if (res.ok) {
                        const data = await res.json();
                        setPlayer(data.player);
                        setQuests(data.quests);
                        setRewards(data.rewards);
                        setLogs(data.logs);
                    } else if (res.status === 403 || res.status === 401) {
                        handleLogout();
                    }
                } catch (err) {
                    console.error("Gagal sinkron data:", err);
                } finally {
                    setSyncing(false);
                }
            };

            const pushToDatabase = async (p, q, r, l) => {
                if (!token) return;
                try {
                    setSyncing(true);
                    await fetch('/api/game/save', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': 'Bearer ' + token
                        },
                        body: JSON.stringify({ player: p, quests: q, rewards: r, logs: l })
                    });
                } catch (err) {
                    console.error("Gagal menyimpan ke DB:", err);
                } finally {
                    setSyncing(false);
                }
            };

            const updateAndSave = (newPlayer, newQuests, newRewards, newLogs) => {
                setPlayer(newPlayer);
                setQuests(newQuests);
                setRewards(newRewards);
                setLogs(newLogs);
                pushToDatabase(newPlayer, newQuests, newRewards, newLogs);
            };

            // --- AUTH LOGIC ---
            const handleAuthSubmit = async (e) => {
                e.preventDefault();
                setAuthLoading(true);
                setAuthError('');
                const endpoint = isRegistering ? '/api/auth/register' : '/api/auth/login';
                try {
                    const res = await fetch(endpoint, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ email: emailInput, password: passwordInput })
                    });
                    const data = await res.json();
                    if (res.ok) {
                        localStorage.setItem('ql_token', data.token);
                        localStorage.setItem('ql_email', data.email);
                        setToken(data.token);
                        setUserEmail(data.email);
                        triggerNotification("Berhasil masuk!");
                    } else {
                        setAuthError(data.error || "Ralat sistem.");
                    }
                } catch (err) {
                    setAuthError("Koneksi gagal ke server VPS.");
                } finally {
                    setAuthLoading(false);
                }
            };

            const handleLogout = () => {
                localStorage.removeItem('ql_token');
                localStorage.removeItem('ql_email');
                setToken(null);
                setUserEmail('');
                setQuests([]);
                setRewards([]);
                setLogs([]);
            };

            // --- ACTIONS ---
            const addQuest = (e) => {
                e.preventDefault();
                if (!newQuestTitle.trim()) return;

                let xp = 10; let gold = 5;
                if (newQuestDiff === 'Sedang') { xp = 20; gold = 10; }
                else if (newQuestDiff === 'Sulit') { xp = 40; gold = 20; }

                const questType = inferQuestType(newQuestTitle, newQuestType);

                const newQ = {
                    id: Date.now().toString(),
                    title: newQuestTitle,
                    type: questType,
                    difficulty: newQuestDiff,
                    xp, gold, completedToday: false
                };

                const updatedQ = [newQ, ...quests];
                const updatedLogs = [createSystemLog('Menerima Quest: "' + newQuestTitle + '"'), ...logs];
                
                updateAndSave(player, updatedQ, rewards, updatedLogs);
                setNewQuestTitle('');
                triggerNotification("Quest berhasil ditambahkan!");
            };

            const completeQuest = (id) => {
                const quest = quests.find(q => q.id === id);
                if (!quest || quest.completedToday) return;

                const updatedQuests = quests.map(q => q.id === id ? { ...q, completedToday: true } : q);

                let newXp = player.xp + quest.xp;
                let newLevel = player.level;
                let xpNeeded = player.xpNeeded;

                if (newXp >= xpNeeded) {
                    newXp -= xpNeeded;
                    newLevel += 1;
                    xpNeeded = Math.round(xpNeeded * 1.2);
                    triggerNotification("Level up!");
                } else {
                    triggerNotification('Quest Selesai! +' + quest.xp + ' XP');
                }

                const statToUp = (quest.type || inferQuestType(quest.title, 'AUTO')).toLowerCase();
                const updatedStats = { ...player.stats };
                updatedStats[statToUp] = (updatedStats[statToUp] || 10) + 1;

                const updatedPlayer = {
                    ...player,
                    level: newLevel,
                    xp: newXp,
                    xpNeeded: xpNeeded,
                    gold: player.gold + quest.gold,
                    hp: Math.min(player.maxHp, player.hp + 5),
                    stats: updatedStats
                };

                const updatedLogs = [createSystemLog('Selesai: "' + quest.title + '" (+' + quest.xp + 'XP)'), ...logs];
                updateAndSave(updatedPlayer, updatedQuests, rewards, updatedLogs);
            };

            const deleteQuest = (id) => {
                const updatedQ = quests.filter(q => q.id !== id);
                updateAndSave(player, updatedQ, rewards, logs);
            };

            const applyPenalty = () => {
                const nextHp = Math.max(0, player.hp - 15);
                let updatedPlayer = { ...player, hp: nextHp };
                let logText = "Hukuman: Mengabaikan kebiasaan harian (-15 HP)";

                if (nextHp <= 0) {
                    logText = "Karakter pingsan! Denda 20 Gold untuk penyembuhan.";
                    updatedPlayer = {
                        ...player, hp: 30, gold: Math.max(0, player.gold - 20)
                    };
                    triggerNotification("HP habis!");
                } else {
                    triggerNotification("Aduh! HP berkurang.");
                }

                const updatedLogs = [createSystemLog(logText), ...logs];
                updateAndSave(updatedPlayer, quests, rewards, updatedLogs);
            };

            // Custom Reward Shop
            const addReward = (e) => {
                e.preventDefault();
                if (!newRewardTitle.trim() || !newRewardCost) return;

                const newR = {
                    id: Date.now().toString(),
                    title: newRewardTitle,
                    cost: parseInt(newRewardCost),
                    count: 0
                };

                const updatedR = [newR, ...rewards];
                updateAndSave(player, quests, updatedR, logs);
                setNewRewardTitle('');
                setNewRewardCost('');
                triggerNotification("Hadiah berhasil dibuat!");
            };

            const buyReward = (id) => {
                const reward = rewards.find(r => r.id === id);
                if (!reward) return;

                if (player.gold < reward.cost) {
                    triggerNotification("Gold Anda tidak mencukupi!");
                    return;
                }

                const updatedPlayer = { ...player, gold: player.gold - reward.cost };
                const updatedR = rewards.map(r => r.id === id ? { ...r, count: r.count + 1 } : r);
                const updatedLogs = [createSystemLog('Menebus Ganjaran: "' + reward.title + '" (-' + reward.cost + 'G)'), ...logs];

                updateAndSave(updatedPlayer, quests, updatedR, updatedLogs);
                triggerNotification("Berhasil ditukarkan!");
            };

            const deleteReward = (id) => {
                const updatedR = rewards.filter(r => r.id !== id);
                updateAndSave(player, quests, updatedR, logs);
            };

            const resetDailyQuests = () => {
                const updatedQ = quests.map(q => ({ ...q, completedToday: false }));
                const updatedLogs = [createSystemLog("Hari baru dimulai! Semua Quest Harian telah di-reset."), ...logs];
                updateAndSave(player, updatedQ, rewards, updatedLogs);
                triggerNotification("Semua quest harian di-reset!");
            };

            const completedToday = quests.filter(q => q.completedToday).length;
            const totalQuests = quests.length;
            const completionRate = totalQuests ? Math.round((completedToday / totalQuests) * 100) : 0;
            const xpProgress = Math.min(100, Math.round((player.xp / player.xpNeeded) * 100));
            const hpProgress = Math.min(100, Math.round((player.hp / player.maxHp) * 100));
            const completedLogs = logs.filter(log => log.text && log.text.startsWith('Selesai:'));
            const rewardLogs = logs.filter(log => log.text && log.text.startsWith('Menebus Ganjaran:'));
            const todayLabel = getDateLabel();
            const todayLogCount = completedLogs.filter(log => log.time === todayLabel).length;
            const streakScore = Math.min(7, completedToday + Math.min(3, todayLogCount));
            const characterTitle = player.level >= 15 ? 'Mythic Hero' : player.level >= 10 ? 'Elite Adventurer' : player.level >= 5 ? 'Rising Knight' : 'Novice Adventurer';
            const strongestStat = Object.entries(player.stats).sort((a, b) => b[1] - a[1])[0] || ['str', 10];
            const sevenDays = Array.from({ length: 7 }, (_, index) => {
                const date = new Date();
                date.setDate(date.getDate() - (6 - index));
                const label = getDateLabel(date);
                const count = completedLogs.filter(log => log.time === label).length;
                return { label, count };
            });
            const maxDayCount = Math.max(1, ...sevenDays.map(day => day.count), completedToday);
            const achievements = [
                { title: 'First Blood', desc: 'Quest pertama selesai', unlocked: completedLogs.length >= 1 },
                { title: 'Level Climber', desc: 'Mencapai level 5', unlocked: player.level >= 5 },
                { title: 'Gold Keeper', desc: 'Menyimpan 100 gold', unlocked: player.gold >= 100 },
                { title: 'Balanced Day', desc: 'Minimal 50% quest harian selesai', unlocked: completionRate >= 50 && totalQuests > 0 }
            ];

            // UI Render Login
            if (!token) {
                return (
                    <div className="min-h-screen flex items-center justify-center p-4">
                        <div className="bg-slate-900 border-2 border-amber-500/20 p-6 rounded-2xl w-full max-w-md shadow-2xl">
                            <div className="text-center mb-6">
                                <span className="text-4xl">🔱</span>
                                <h1 className="text-2xl font-black text-amber-500 font-mono mt-1">QUESTLIFE</h1>
                                <p className="text-xs text-slate-400">Habit Tracker RPG Berbasis PostgreSQL</p>
                            </div>

                            {authError && (
                                <div className="bg-red-950/40 border border-red-500/40 text-red-200 text-xs p-3 rounded-lg font-mono mb-4 text-center">
                                    {authError}
                                </div>
                            )}

                            <form onSubmit={handleAuthSubmit} className="space-y-4">
                                <div>
                                    <label className="text-[10px] uppercase font-mono font-bold text-slate-400 block mb-1">Email</label>
                                    <input 
                                        type="email" 
                                        value={emailInput} 
                                        onChange={e => setEmailInput(e.target.value)}
                                        required 
                                        className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-amber-500" 
                                    />
                                </div>
                                <div>
                                    <label className="text-[10px] uppercase font-mono font-bold text-slate-400 block mb-1">Password</label>
                                    <input 
                                        type="password" 
                                        value={passwordInput} 
                                        onChange={e => setPasswordInput(e.target.value)}
                                        required 
                                        className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-amber-500" 
                                    />
                                </div>
                                <button type="submit" className="w-full bg-amber-500 hover:bg-amber-400 text-slate-950 font-black py-2.5 rounded-lg text-xs uppercase tracking-wider">
                                    {isRegistering ? 'Daftar Ksatria' : 'Masuk Gerbang'}
                                </button>
                            </form>

                            <button onClick={() => setIsRegistering(!isRegistering)} className="w-full text-center text-xs font-mono text-amber-500 hover:underline mt-4">
                                {isRegistering ? 'Sudah mendaftar? Masuk di sini' : 'Karakter baru? Daftar di sini'}
                            </button>
                        </div>
                    </div>
                );
            }

            // Main UI
            return (
                <div className="max-w-5xl mx-auto p-4 pb-24">
                    {notification && (
                        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 bg-amber-500 text-slate-950 px-4 py-2.5 rounded-lg font-bold text-xs shadow-lg">
                            ✨ {notification}
                        </div>
                    )}

                    {/* Install PWA Prompt Banner */}
                    {showInstallBtn && (
                        <div className="bg-amber-600/20 border border-amber-500 text-amber-100 px-4 py-3 rounded-xl mb-4 flex justify-between items-center text-xs">
                            <div>
                                <span className="font-bold">Pasang QuestLife!</span> Tambahkan aplikasi ini ke beranda HP Anda.
                            </div>
                            <button onClick={handleInstallApp} className="bg-amber-500 text-slate-950 px-3 py-1.5 rounded-lg font-black uppercase tracking-wider">
                                Pasang
                            </button>
                        </div>
                    )}

                    <header className="flex justify-between items-center mb-6">
                        <div>
                            <h1 className="text-xl font-mono font-black text-amber-500">QUESTLIFE</h1>
                            <div className="text-[9px] text-emerald-400 font-mono uppercase">
                                {syncing ? 'Sinkronisasi...' : 'Tersambung (Cloud PG)'}
                            </div>
                        </div>
                        <div className="flex gap-2">
                            <button onClick={resetDailyQuests} className="bg-slate-900 border border-slate-800 hover:border-amber-500 px-3 py-1.5 rounded-lg text-[10px] font-mono font-bold text-amber-500">
                                Reset Harian
                            </button>
                            <button onClick={handleLogout} className="bg-slate-900 border border-slate-800 hover:border-red-900 px-3 py-1.5 rounded-lg text-[10px] font-mono font-bold text-red-400">
                                Log Out
                            </button>
                        </div>
                    </header>

                    {/* Character Card */}
                    <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 mb-6 shadow-xl">
                        <div className="flex justify-between items-center mb-3">
                            <input 
                                type="text" 
                                value={player.name}
                                onChange={(e) => {
                                    const updatedPlayer = { ...player, name: e.target.value };
                                    updateAndSave(updatedPlayer, quests, rewards, logs);
                                }}
                                className="bg-transparent border-b border-transparent hover:border-slate-800 focus:border-amber-500 focus:outline-none font-black text-lg text-slate-200"
                            />
                            <div className="text-right">
                                <span className="bg-amber-500/10 border border-amber-500/30 text-amber-400 px-2 py-0.5 rounded font-mono text-xs font-bold">LVL {player.level}</span>
                                <div className="text-[10px] text-slate-500 font-mono mt-1">{characterTitle}</div>
                            </div>
                        </div>

                        {/* HP Bar */}
                        <div className="mb-3">
                            <div className="flex justify-between text-[11px] mb-1">
                                <span className="text-red-400 font-bold flex items-center gap-1"><Icons.Heart /> Health Points</span>
                                <span className="font-mono">{player.hp}/{player.maxHp}</span>
                            </div>
                            <div className="h-2.5 bg-slate-950 rounded-full overflow-hidden border border-slate-800">
                                <div className="h-full bg-gradient-to-r from-red-600 to-rose-400 transition-all duration-300" style={{ width: hpProgress + '%' }}></div>
                            </div>
                        </div>

                        {/* XP Bar */}
                        <div className="mb-4">
                            <div className="flex justify-between text-[11px] mb-1">
                                <span className="text-emerald-400 font-bold">⭐ Experience</span>
                                <span className="font-mono">{player.xp}/{player.xpNeeded} XP</span>
                            </div>
                            <div className="h-2.5 bg-slate-950 rounded-full overflow-hidden border border-slate-800">
                                <div className="h-full bg-gradient-to-r from-emerald-600 to-green-400 transition-all duration-300" style={{ width: xpProgress + '%' }}></div>
                            </div>
                        </div>

                        {/* Gold & Penalty */}
                        <div className="grid grid-cols-3 gap-3 pt-3 border-t border-slate-800/80">
                            <div className="bg-slate-950 rounded-lg p-2 flex items-center gap-2 border border-slate-800/60">
                                <Icons.Coins />
                                <div>
                                    <div className="text-[9px] text-slate-500 uppercase font-mono font-bold">Syiling Emas</div>
                                    <div className="text-sm font-black text-amber-300 font-mono">{player.gold} G</div>
                                </div>
                            </div>
                            <button onClick={applyPenalty} className="bg-red-950/30 border border-red-900/40 hover:border-red-600 text-red-300 rounded-lg text-xs font-bold flex items-center justify-center gap-1.5">
                                Gagal Habit (-15HP)
                            </button>
                            <div className="bg-slate-950 rounded-lg p-2 border border-slate-800/60">
                                <div className="text-[9px] text-slate-500 uppercase font-mono font-bold">Stat Utama</div>
                                <div className="text-sm font-black text-cyan-300 font-mono">{strongestStat[0].toUpperCase()} {strongestStat[1]}</div>
                            </div>
                        </div>
                    </div>

                    {/* ================= TAB 0: DASHBOARD ================= */}
                    {activeTab === 'dashboard' && (
                        <div className="grid lg:grid-cols-[1.35fr_0.85fr] gap-4 mb-6">
                            <div className="space-y-4">
                                <div className="bg-slate-900 border border-slate-800 p-4 rounded-xl">
                                    <div className="flex items-center justify-between mb-4 gap-3">
                                        <div>
                                            <h2 className="text-sm font-black text-slate-100 uppercase tracking-wider">Progress 7 Hari</h2>
                                            <p className="text-xs text-slate-500">Jumlah quest selesai per hari</p>
                                        </div>
                                        <span className="text-xs font-mono text-amber-300 bg-amber-500/10 border border-amber-500/30 px-2 py-1 rounded">{completionRate}% hari ini</span>
                                    </div>
                                    <div className="h-44 flex items-end gap-2 border-b border-slate-800 pb-2">
                                        {sevenDays.map((day, index) => (
                                            <div key={day.label + index} className="flex-1 flex flex-col items-center gap-2 min-w-0">
                                                <div className="w-full bg-slate-950 border border-slate-800 rounded-t-lg overflow-hidden flex items-end" style={{ height: '132px' }}>
                                                    <div className="w-full bg-gradient-to-t from-cyan-500 to-amber-300 transition-all duration-500" style={{ height: Math.max(8, (day.count / maxDayCount) * 100) + '%', opacity: day.count ? 1 : 0.22 }}></div>
                                                </div>
                                                <div className="text-[10px] text-slate-500 font-mono truncate">{day.label}</div>
                                            </div>
                                        ))}
                                    </div>
                                </div>

                                <div className="grid sm:grid-cols-3 gap-3">
                                    <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
                                        <div className="text-[10px] uppercase font-mono text-slate-500 font-bold">Quest selesai</div>
                                        <div className="text-2xl font-black text-emerald-300">{completedLogs.length}</div>
                                    </div>
                                    <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
                                        <div className="text-[10px] uppercase font-mono text-slate-500 font-bold">Reward ditebus</div>
                                        <div className="text-2xl font-black text-amber-300">{rewardLogs.length}</div>
                                    </div>
                                    <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
                                        <div className="text-[10px] uppercase font-mono text-slate-500 font-bold">Quest aktif</div>
                                        <div className="text-2xl font-black text-cyan-300">{quests.filter(q => !q.completedToday).length}</div>
                                    </div>
                                </div>
                            </div>

                            <div className="space-y-4">
                                <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
                                    <h2 className="text-sm font-black text-slate-100 uppercase tracking-wider mb-3">Achievement</h2>
                                    <div className="space-y-2">
                                        {achievements.map(item => (
                                            <div key={item.title} className={'border rounded-lg p-3 ' + (item.unlocked ? 'bg-emerald-500/10 border-emerald-500/30' : 'bg-slate-950 border-slate-800 opacity-70')}>
                                                <div className={'text-xs font-black ' + (item.unlocked ? 'text-emerald-300' : 'text-slate-400')}>{item.title}</div>
                                                <div className="text-[10px] text-slate-500">{item.desc}</div>
                                            </div>
                                        ))}
                                    </div>
                                </div>

                                <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
                                    <h2 className="text-sm font-black text-slate-100 uppercase tracking-wider mb-3">Aktivitas Terbaru</h2>
                                    <div className="space-y-2 max-h-48 overflow-y-auto">
                                        {logs.slice(0, 6).map(log => (
                                            <div key={log.id} className="bg-slate-950 border border-slate-800 rounded-lg p-2 text-xs">
                                                <span className="text-amber-400 font-mono">[{log.time}]</span> <span className="text-slate-300">{log.text}</span>
                                            </div>
                                        ))}
                                        {logs.length === 0 && <div className="text-xs text-slate-500">Belum ada aktivitas.</div>}
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* ================= TAB 1: QUESTS ================= */}
                    {activeTab === 'quests' && (
                        <div className="space-y-4">
                            <form onSubmit={addQuest} className="bg-slate-900 border border-slate-800 p-4 rounded-xl space-y-3">
                                <input 
                                    type="text" 
                                    placeholder="Contoh: Senam Pagi / Membaca 15 Mnt..."
                                    value={newQuestTitle}
                                    onChange={e => setNewQuestTitle(e.target.value)}
                                    required
                                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none"
                                />
                                <div className="grid grid-cols-3 gap-2">
                                    <select value={newQuestType} onChange={e => setNewQuestType(e.target.value)} className="bg-slate-950 border border-slate-800 rounded-lg text-[10px] font-bold p-1.5 text-amber-500">
                                        <option value="AUTO">Auto Stat</option>
                                        <option value="STR">💪 STR (Fizikal)</option>
                                        <option value="INT">🧠 INT (Minda)</option>
                                        <option value="DEX">⚡ DEX (Kreatif)</option>
                                        <option value="WIS">🔮 WIS (Mental)</option>
                                    </select>
                                    <select value={newQuestDiff} onChange={e => setNewQuestDiff(e.target.value)} className="bg-slate-950 border border-slate-800 rounded-lg text-[10px] font-bold p-1.5 text-amber-500">
                                        <option value="Mudah">Mudah (+10XP)</option>
                                        <option value="Sedang">Sedang (+20XP)</option>
                                        <option value="Sulit">Sulit (+40XP)</option>
                                    </select>
                                    <button type="submit" className="bg-amber-500 text-slate-950 font-black text-[10px] uppercase rounded-lg">Ambil Quest</button>
                                </div>
                            </form>

                            <div className="space-y-2">
                                {quests.map(q => (
                                    <div key={q.id} className={'bg-slate-900 border border-slate-800 p-3 rounded-xl flex items-center justify-between gap-3 ' + (q.completedToday ? 'opacity-40 line-through' : '')}>
                                        <div>
                                            <p className="text-xs font-bold text-slate-200">{q.title}</p>
                                            <span className="text-[9px] text-amber-500 font-mono font-bold">+{q.xp} XP | +{q.gold} G | {q.type}</span>
                                        </div>
                                        <div className="flex gap-2">
                                            {!q.completedToday && (
                                                <button onClick={() => completeQuest(q.id)} className="bg-emerald-500 text-slate-950 px-2.5 py-1 rounded-lg text-[10px] font-black uppercase">Selesai</button>
                                            )}
                                            <button onClick={() => deleteQuest(q.id)} className="text-slate-600 hover:text-red-400 p-1"><Icons.Trash /></button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* ================= TAB 2: REWARDS ================= */}
                    {activeTab === 'rewards' && (
                        <div className="space-y-4">
                            <form onSubmit={addReward} className="bg-slate-900 border border-slate-800 p-4 rounded-xl flex gap-2">
                                <input type="text" placeholder="Ganjaran kustom (Jajan, main game dll.)" value={newRewardTitle} onChange={e=>setNewRewardTitle(e.target.value)} required className="flex-grow bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-100 placeholder-slate-700 focus:outline-none" />
                                <input type="number" placeholder="G" value={newRewardCost} onChange={e=>setNewRewardCost(e.target.value)} required className="w-14 bg-slate-950 border border-slate-800 rounded-lg px-2 py-1.5 text-xs text-center text-amber-500 font-bold" />
                                <button type="submit" className="bg-amber-500 text-slate-950 px-3 rounded-lg text-xs font-black">+</button>
                            </form>

                            <div className="space-y-2">
                                {rewards.map(r => (
                                    <div key={r.id} className="bg-slate-900 border border-slate-800 p-3 rounded-xl flex items-center justify-between">
                                        <div>
                                            <p className="text-xs font-bold text-slate-200">{r.title}</p>
                                            <span className="text-[10px] text-amber-400 font-mono font-bold">{r.cost} Gold</span>
                                        </div>
                                        <div className="flex gap-2">
                                            <button onClick={() => buyReward(r.id)} className="bg-amber-500 text-slate-950 px-3 py-1 rounded-lg text-[10px] font-black uppercase">Tebus</button>
                                            <button onClick={() => deleteReward(r.id)} className="text-slate-600 hover:text-red-400 p-1"><Icons.Trash /></button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* ================= TAB 3: PROFILE ================= */}
                    {activeTab === 'profile' && (
                        <div className="space-y-4">
                            <div className="bg-slate-900 border border-slate-800 p-4 rounded-xl">
                                <h3 className="text-xs font-mono uppercase tracking-widest text-slate-400 mb-3 font-bold">Atribut Karakter</h3>
                                <div className="grid grid-cols-2 gap-3 text-xs font-mono">
                                    <div className="bg-slate-950 p-2.5 rounded-lg border border-slate-800">
                                        <span className="text-slate-500 text-[10px] block">STRENGTH</span>
                                        <span className="text-red-400 font-bold">{player.stats.str} PT</span>
                                    </div>
                                    <div className="bg-slate-950 p-2.5 rounded-lg border border-slate-800">
                                        <span className="text-slate-500 text-[10px] block">INTELLIGENCE</span>
                                        <span className="text-blue-400 font-bold">{player.stats.int} PT</span>
                                    </div>
                                    <div className="bg-slate-950 p-2.5 rounded-lg border border-slate-800">
                                        <span className="text-slate-500 text-[10px] block">DEXTERITY</span>
                                        <span className="text-green-400 font-bold">{player.stats.dex} PT</span>
                                    </div>
                                    <div className="bg-slate-950 p-2.5 rounded-lg border border-slate-800">
                                        <span className="text-slate-500 text-[10px] block">WISDOM</span>
                                        <span className="text-purple-400 font-bold">{player.stats.wis} PT</span>
                                    </div>
                                </div>
                            </div>

                            <div className="bg-slate-900 border border-slate-800 p-4 rounded-xl">
                                <h3 className="text-xs font-mono uppercase tracking-widest text-slate-400 mb-2 font-bold">Log Aktivitas</h3>
                                <div className="bg-slate-950 p-3 rounded-lg border border-slate-800 max-h-36 overflow-y-auto space-y-1.5 font-mono text-[10px]">
                                    {logs.map(log => (
                                        <div key={log.id} className="text-slate-400 border-b border-slate-900 pb-1 last:border-0">
                                            <span className="text-amber-500">[{log.time}]</span> {log.text}
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Bottom Nav Bar */}
                    <nav className="fixed bottom-0 left-0 right-0 bg-slate-900 border-t border-slate-800 p-2 z-40">
                        <div className="max-w-md mx-auto grid grid-cols-4 gap-1">
                            <button onClick={() => setActiveTab('dashboard')} className={'py-1.5 text-center text-xs font-bold uppercase tracking-wider font-mono ' + (activeTab==='dashboard'?'text-amber-500':'text-slate-500')}>Dashboard</button>
                            <button onClick={() => setActiveTab('quests')} className={'py-1.5 text-center text-xs font-bold uppercase tracking-wider font-mono ' + (activeTab==='quests'?'text-amber-500':'text-slate-500')}>Quests</button>
                            <button onClick={() => setActiveTab('rewards')} className={'py-1.5 text-center text-xs font-bold uppercase tracking-wider font-mono ' + (activeTab==='rewards'?'text-amber-500':'text-slate-500')}>Kedai</button>
                            <button onClick={() => setActiveTab('profile')} className={'py-1.5 text-center text-xs font-bold uppercase tracking-wider font-mono ' + (activeTab==='profile'?'text-amber-500':'text-slate-500')}>Profil</button>
                        </div>
                    </nav>
                </div>
            );
        }

        // Register Service Worker for PWA
        if ('serviceWorker' in navigator) {
            window.addEventListener('load', () => {
                navigator.serviceWorker.register('/service-worker.js')
                    .then(reg => console.log('PWA Service Worker terdaftar!', reg.scope))
                    .catch(err => console.log('Registrasi Service Worker Gagal:', err));
            });
        }

        const root = ReactDOM.createRoot(document.getElementById('root'));
        root.render(<App />);
    </script>
</body>
</html>
    `);
});

app.listen(PORT, () => {
    console.log(`Server QuestLife RPG berjalan di port ${PORT}`);
});
