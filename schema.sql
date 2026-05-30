CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    player_name TEXT DEFAULT 'Satria Baru',
    level INTEGER DEFAULT 1,
    xp INTEGER DEFAULT 0,
    xp_needed INTEGER DEFAULT 100,
    hp INTEGER DEFAULT 100,
    max_hp INTEGER DEFAULT 100,
    gold INTEGER DEFAULT 50,
    stat_str INTEGER DEFAULT 10,
    stat_int INTEGER DEFAULT 10,
    stat_dex INTEGER DEFAULT 10,
    stat_wis INTEGER DEFAULT 10,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE quests (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    type TEXT NOT NULL,
    difficulty TEXT NOT NULL,
    xp INTEGER DEFAULT 0,
    gold INTEGER DEFAULT 0,
    completed_today BOOLEAN DEFAULT FALSE
);

CREATE TABLE rewards (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    cost INTEGER NOT NULL,
    count INTEGER DEFAULT 0
);

CREATE TABLE logs (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    log_time TEXT NOT NULL
);
