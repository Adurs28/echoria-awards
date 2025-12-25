require('dotenv').config();
const express = require('express');
const session = require('express-session');
const DiscordOauth2 = require('discord-oauth2');
const sqlite3 = require('sqlite3').verbose();
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, Events } = require('discord.js');
const path = require('path');

const app = express();
const oauth = new DiscordOauth2();

app.set('view engine', 'ejs');
app.use(express.static('public'));
app.set('trust proxy', 1); // Разрешаем работу через прокси (ngrok/localtunnel)
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

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
// Если переменная REDIRECT_URI не задана (локальный запуск), используем localhost
const REDIRECT_URI = process.env.REDIRECT_URI || 'http://localhost:3000/auth/callback';
const GUILD_ID = process.env.GUILD_ID;
const ADMIN_ID = process.env.ADMIN_ID;
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const LEADERBOARD_CHANNEL_ID = process.env.LEADERBOARD_CHANNEL_ID;

// Список номинаций для пагинации (должен совпадать с сайтом)
const NOMINATIONS = [
  "Одинокий волк года",
  "Шлюха года",
  "Фрик года",
  "Интернет дрочила года",
  "Активнич года",
  "Тролль года",
  "Подсос года",
  "Смехуятина года",
  "Пяточок года",
  "Душнилище года",
  "Завоз года",
  "Добряк года"
];

// --- Настройка Discord Бота ---
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

client.once(Events.ClientReady, () => {
  console.log(`🤖 Бот запущен как ${client.user.tag}`);
  if (LEADERBOARD_CHANNEL_ID) {
    console.log(`📝 Бот настроен на канал ID: ${LEADERBOARD_CHANNEL_ID}`);
  } else {
    console.log(`⚠️ ID канала для таблицы не задан!`);
  }
  updateDiscordLeaderboard(); // Обновляем таблицу при запуске
});

if (DISCORD_BOT_TOKEN) {
  client.login(DISCORD_BOT_TOKEN);
} else {
  console.log('⚠️ DISCORD_BOT_TOKEN не указан, функции бота отключены.');
}

// Обработчик нажатий на кнопки (Пагинация)
client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;
  
  // Обработка кнопки сброса голосов
  if (interaction.customId === 'reset_votes') {
    if (ADMIN_ID && interaction.user.id !== ADMIN_ID) {
      return interaction.reply({ content: '❌ У вас нет прав на это действие.', ephemeral: true });
    }

    db.run(`DELETE FROM votes_v2`, function(err) {
      if (err) {
        return interaction.reply({ content: `❌ Ошибка при очистке БД: ${err.message}`, ephemeral: true });
      }
      updateDiscordLeaderboard();
      interaction.reply({ content: '✅ Все голоса были успешно удалены. Таблица лидеров обновлена.', ephemeral: true });
    });
    return;
  }

  // Проверяем, что это наши кнопки (формат id: lb_prev_0 или lb_next_2)
  const [prefix, action, pageStr] = interaction.customId.split('_');
  if (prefix !== 'lb') return;

  const page = parseInt(pageStr);
  await sendLeaderboardPage(page, interaction);
});

// Очистка чата: удаляем сообщения пользователей в канале лидерборда
client.on('messageCreate', async message => {
  // Команда для вызова кнопки сброса (только для админа)
  if (message.content === '!reset') {
    if (ADMIN_ID && message.author.id !== ADMIN_ID) return;

    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('reset_votes')
          .setLabel('🗑️ Сбросить ВСЕ голоса')
          .setStyle(ButtonStyle.Danger)
      );
    
    await message.reply({ content: '⚠️ **Внимание!** Вы собираетесь удалить **ВСЕ** голоса из базы данных. Это действие необратимо.', components: [row] });
  }

  if (LEADERBOARD_CHANNEL_ID && message.channel.id === LEADERBOARD_CHANNEL_ID && !message.author.bot) {
    try {
      await message.delete();
    } catch (error) {
      console.error("Не удалось удалить сообщение (проверьте права бота):", error);
    }
  }
});

// Функция генерации данных для страницы
function getLeaderboardData(pageIndex, callback) {
  db.all(`SELECT nomination, choice, COUNT(*) as count FROM votes_v2 GROUP BY nomination, choice ORDER BY nomination, count DESC`, async (err, rows) => {
    if (err) return callback(err, null);

    // Группируем данные по номинациям
    const nominations = {};
    rows.forEach(row => {
      if (!nominations[row.nomination]) nominations[row.nomination] = [];
      nominations[row.nomination].push(row);
    });
    callback(null, nominations);
  });
}

// Функция отправки/обновления страницы
async function sendLeaderboardPage(pageIndex, interaction = null) {
  if (!client.isReady() || !LEADERBOARD_CHANNEL_ID) return;

  // Защита от выхода за границы
  if (pageIndex < 0) pageIndex = 0;
  if (pageIndex >= NOMINATIONS.length) pageIndex = NOMINATIONS.length - 1;

  const currentNomination = NOMINATIONS[pageIndex];

  getLeaderboardData(pageIndex, async (err, nominations) => {
    if (err) return console.error(err);

    const candidates = nominations[currentNomination] || [];
    
    // Формируем Топ-3
    const top3 = candidates.slice(0, 3).map((c, index) => {
      const medals = ['🥇', '🥈', '🥉'];
      const icon = medals[index] || '👤';
      return `${icon} **${c.choice}** — ${c.count} голосов`;
    }).join('\n\n');

    const embed = new EmbedBuilder()
      .setTitle(`🏆 ${currentNomination}`)
      .setColor(0xFFD700)
      .setDescription(top3 || '_Пока нет голосов в этой номинации_')
      .setFooter({ text: `Страница ${pageIndex + 1} из ${NOMINATIONS.length} • Echoria Awards 2025` })
      .setTimestamp();

    // Кнопки
    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`lb_prev_${pageIndex - 1}`)
          .setLabel('⬅️ Назад')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(pageIndex === 0),
        new ButtonBuilder()
          .setCustomId(`lb_next_${pageIndex + 1}`)
          .setLabel('Вперед ➡️')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(pageIndex === NOMINATIONS.length - 1)
      );

    const payload = { embeds: [embed], components: [row] };

    // Если это ответ на нажатие кнопки
    if (interaction) {
      await interaction.update(payload);
    } else {
      // Если это автоматическое обновление (новый голос)
      try {
        const channel = await client.channels.fetch(LEADERBOARD_CHANNEL_ID);
        if (!channel) return;

        const messages = await channel.messages.fetch({ limit: 10 });
        const lastBotMsg = messages.find(m => m.author.id === client.user.id);

        if (lastBotMsg) await lastBotMsg.edit(payload);
        else await channel.send(payload);
      } catch (error) {
        console.error(`❌ Ошибка отправки в Discord (Канал: ${LEADERBOARD_CHANNEL_ID}):`, error.message);
      }
    }
  });
}

// Обертка для вызова из других мест (сохраняет текущую страницу)
async function updateDiscordLeaderboard() {
  if (!client.isReady() || !LEADERBOARD_CHANNEL_ID) return;

  try {
    const channel = await client.channels.fetch(LEADERBOARD_CHANNEL_ID);
    if (!channel) return;

    const messages = await channel.messages.fetch({ limit: 10 });
    const lastBotMsg = messages.find(m => m.author.id === client.user.id);

    let pageIndex = 0;
    if (lastBotMsg && lastBotMsg.embeds[0]?.footer?.text) {
      const match = lastBotMsg.embeds[0].footer.text.match(/Страница (\d+)/);
      if (match) pageIndex = parseInt(match[1]) - 1;
    }
    
    sendLeaderboardPage(pageIndex);
  } catch (error) {
    console.error("Ошибка обновления таблицы (проверьте права бота):", error.message);
  }
}

app.get('/', (req, res) => res.render('index', { user: req.session.user }));

app.get('/login', (req, res) => {
  if(!REDIRECT_URI) return res.send("Ошибка: REDIRECT_URI не настроен. Проверьте консоль.");
  
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
    if (err) return res.status(409).send('❌ Вы уже голосовали в этой номинации.');
    res.send('✅ Спасибо за участие в Echoria Awards 2025!');
    updateDiscordLeaderboard(); // Обновляем таблицу в дискорде после успешного голоса
  });
});

app.get('/admin', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  
  // Проверка: если ID пользователя не совпадает с ADMIN_ID, доступ запрещен
  if (ADMIN_ID && req.session.user.id !== ADMIN_ID) {
    return res.status(403).send('❌ Доступ запрещен. Вы не администратор.');
  }

  db.all(`SELECT nomination, choice, COUNT(*) as count FROM votes_v2 GROUP BY nomination, choice ORDER BY nomination, count DESC`, (err, rows) => {
    if (err) return res.status(500).send(err.message);
    res.render('admin', { rows });
  });
});

app.get('/thanks', (req, res) => res.render('thanks'));

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

// Порт для Render
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
  console.log(`🔗 Используемый REDIRECT_URI: ${REDIRECT_URI}`);
  console.log(`⚠️  Убедись, что этот URL добавлен в Discord Developer Portal -> OAuth2 -> Redirects`);
  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error("❌ ОШИБКА: Не заданы CLIENT_ID или CLIENT_SECRET в файле .env");
  } else {
    console.log("✅ CLIENT_ID и CLIENT_SECRET загружены");
  }
});