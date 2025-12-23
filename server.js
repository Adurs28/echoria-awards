require('dotenv').config();
const express = require('express');
const session = require('express-session');
const DiscordOauth2 = require('discord-oauth2');
const sqlite3 = require('sqlite3').verbose();
const path = require('express');

const app = express();
const oauth = new DiscordOauth2();

app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false }
}));

const db = new sqlite3.Database('votes.db');
db.run(`CREATE TABLE IF NOT EXISTS votes_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  nomination TEXT,
  choice TEXT,
  UNIQUE(user_id, nomination)
)`);

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;
const GUILD_ID = process.env.GUILD_ID;
const ADMIN_ID = process.env.ADMIN_ID;

app.get('/', (req, res) => res.render('index', { user: req.session.user }));
app.get('/login', (req, res) => {
  const url = `https://discord.com/api/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=identify+guilds`;
  res.redirect(url);
});
app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  try {
    const token = await oauth.tokenRequest({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      code,
      scope: 'identify guilds',
      grantType: 'authorization_code',
      redirectUri: REDIRECT_URI
    });
    const user = await oauth.getUser(token.access_token);
    const guilds = await oauth.getUserGuilds(token.access_token);
    const isInGuild = guilds.some(g => g.id === GUILD_ID);
    if (!isInGuild) return res.send('❌ Ты не находишься на сервере Echoria.');
    req.session.user = user;
    res.redirect('/');
  } catch (err) {
    console.error(err);
    res.send('❌ Ошибка авторизации.');
  }
});
app.post('/vote', (req, res) => {
  if (!req.session.user) return res.status(401).send('❌ Авторизуйся через Discord.');
  const { nomination, choice } = req.body;
  const user_id = req.session.user.id;
  db.run(`INSERT INTO votes_v2 (user_id, nomination, choice) VALUES (?, ?, ?)`, [user_id, nomination, choice], function (err) {
    if (err) return res.status(409).send('❌ Ты уже голосовал в этой номинации.');
    res.sendStatus(200);
  });
});
app.get('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) return res.status(500).send('❌ Ошибка выхода.');
    res.redirect('/');
  });
});
app.get('/admin', (req, res) => {
  db.all(`SELECT nomination, choice, COUNT(*) as count FROM votes_v2 GROUP BY nomination, choice`, (err, rows) => {
    if (err) return res.status(500).send(err);
    res.render('admin', { rows });
  });
});

if (!process.env.CLIENT_ID) {
  console.log('⚠️  Переменные окружения не загружены – использую .env.example');
  require('dotenv').config({ path: '.env.example' });
} else {
  require('dotenv').config();
}

app.get('/thanks', (req, res) => res.render('thanks'));

app.listen(3000, () => console.log('🚀 Сервер запущен: http://localhost:3000'));