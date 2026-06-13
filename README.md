# QuestLife PWA PostgreSQL

QuestLife adalah aplikasi habit RPG berbasis Node.js, Express, PostgreSQL, dan PWA.

## File utama

- `server.js` - server Express, API auth, API game state, dan frontend React inline.
- `service-worker.js` - service worker PWA.
- `manifest.json` - manifest PWA.
- `schema.sql` - struktur tabel PostgreSQL.
- `.env.example` - contoh konfigurasi server.

## Setup lokal atau VPS

Install dependency:

```bash
npm install
```

Buat database PostgreSQL:

```bash
sudo -u postgres psql
```

```sql
CREATE DATABASE questlife;
\c questlife
\i schema.sql
```

Jalankan aplikasi:

```bash
npm start
```

Konfigurasi dibaca dari file `.env`. Buat file `.env` dari contoh:

```bash
cp .env.example .env
nano .env
```

Contoh isi `.env`:

```env
PORT=3000
DB_USER=kevindar
DB_HOST=localhost
DB_NAME=questlife
DB_PASSWORD=Kevin123
DB_PORT=5432
JWT_SECRET=ganti_dengan_secret_panjang_random
APP_TIMEZONE=Asia/Bangkok
```

`APP_TIMEZONE` dipakai untuk reset quest otomatis ketika tanggal berganti.

## Deploy dengan PM2

```bash
sudo npm install -g pm2
pm2 start server.js --name questlife
pm2 startup
pm2 save
```

Periksa kondisi aplikasi dan koneksi database:

```bash
curl http://localhost:3000/health
```

Respons normal:

```json
{"status":"ok","database":"connected"}
```

Saat pertama kali dijalankan, aplikasi membuat tabel `user_daily_state`
secara otomatis untuk menyimpan tanggal reset harian. User PostgreSQL perlu
izin `CREATE` pada schema `public`.

## Nginx reverse proxy

Ganti `domainanda.com` dengan domain asli.

```nginx
server {
    listen 80;
    server_name domainanda.com www.domainanda.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

Aktifkan SSL:

```bash
sudo apt install certbot python3-certbot-nginx -y
sudo certbot --nginx -d domainanda.com -d www.domainanda.com
```
