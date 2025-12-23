require('dotenv').config();
const express = require('express');
const session = require('express-session');
const DiscordOauth2 = require('discord-oauth2');
const sqlite3 = require('sqlite3').verbose();
const path = require('path'); // Исправлено: был require('express')

const app = express();
const oauth = new DiscordOauth2();

app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Настройка сессий (на Render secure должен быть true, если используешь https, 
// но для начала оставим false для тестов)
app.use(session({
  secret: process.env.SESSION_SECRET || 'super-secret-key',
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

// Переменные окружения из панели Render
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI; // Должен быть https://echoria-awards.onrender.com/auth/callback
const GUILD_ID = process.env.GUILD_ID;

app.get('/', (req, res) => res.render('index', { user: req.session.user }));

app.get('/login', (req, res) => {
  // Проверка: если REDIRECT_URI не задан, будет ошибка
  if(!REDIRECT_URI) return res.send("Ошибка: REDIRECT_URI не настроен в панели Render");

  const manualRedirect = "https://echoria-awards.onrender.com/auth/callback";
  
  const url = `https://discord.com/api/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=identify+guilds`;
  res.redirect(url);
});

// Этот путь должен СТРОГО совпадать с концом вашего REDIRECT_URI
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
    console.error("Ошибка авторизации:", err);
    res.status(500).send('❌ Ошибка авторизации. Проверьте логи сервера.');
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

app.get('/thanks', (req, res) => res.render('thanks'));

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

// Порт для Render
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Сервер запущен на порту ${PORT}`));