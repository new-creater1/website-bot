const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const { delay } = require('@whiskeysockets/baileys/lib/Utils');
const fs = require('fs');
const path = require('path');
const P = require('pino');
const qrcode = require('qrcode-terminal');
const gTTS = require('gtts');
const SpotifyWebApi = require('spotify-web-api-node');
const ytdlp = require('yt-dlp-exec');
require('dotenv').config();
const groupLangs = {};
const axios = require('axios');
const tttGames = {};
const welcomeSettings = {}; // stores which groups have welcome ON/OFF
const welcomeImage = 'pic/welcome.jpg'; // Path to your JPG file
const goodbyeImage = 'pic/goodbye.jpg'; // Optional goodbye image
const hangmanGames = {};
const hangmanWords = ['javascript', 'whatsapp', 'discord', 'nodejs', 'bot', 'spotify', 'youtube', 'hangman'];
const simonGames = {};
const simonEmojis = ['🟦','🟥','🟩','🟨','🟪','🟧']; // emoji pool


function renderBoard(board) {
    return `
${board[0]} | ${board[1]} | ${board[2]}
---------
${board[3]} | ${board[4]} | ${board[5]}
---------
${board[6]} | ${board[7]} | ${board[8]}
`;
}

function checkWinner(b) {
    const winCombos = [
        [0,1,2],[3,4,5],[6,7,8],
        [0,3,6],[1,4,7],[2,5,8],
        [0,4,8],[2,4,6]
    ];
    for (const [a,b1,c] of winCombos) {
        if (b[a] === b[b1] && b[a] === b[c] && (b[a] === 'X' || b[a] === 'O')) return b[a];
    }
    return null;
}


async function translateText(text, lang) {
  lang = lang.toLowerCase();

  if (lang === 'pirate') {
    let words = text.toLowerCase().split(' ');
    return words.map(w => pirateMap[w] || w).join(' ');
  } else if (lang === 'gibberish') {
    return gibberish(text);
  } else {
    try {
      const res = await axios.post(`https://libretranslate.de/translate`, {
        q: text,
        source: "auto",
        target: lang
      }, { headers: { "accept": "application/json" }});
      return res.data.translatedText;
    } catch (e) {
      console.error("Translate error:", e);
      return "❌ Translation failed";
    }
  }
}
// -------------------- Admins --------------------
let admins = ['639551628160@s.whatsapp.net'];
let originalAdmin = '639551628160@s.whatsapp.net';

// -------------------- Spotify Setup --------------------
const spotifyApi = new SpotifyWebApi({
  clientId: process.env.SPOTIFY_CLIENT_ID || "45c86f9cae77493589ecf45080400c3d",
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET || "5b4ef30793884b66930b2cfb08c511ae",
});
let spotifyTokenExpiry = 0;

async function ensureSpotifyToken() {
  const now = Date.now();
  if (!process.env.SPOTIFY_CLIENT_ID || !process.env.SPOTIFY_CLIENT_SECRET) return;
  if (now < spotifyTokenExpiry - 60_000) return;
  const grant = await spotifyApi.clientCredentialsGrant();
  spotifyApi.setAccessToken(grant.body.access_token);
  spotifyTokenExpiry = now + grant.body.expires_in * 1000;
}

async function resolveSpotifyTrack(queryOrUrl) {
  try {
    await ensureSpotifyToken();
    if (/open\.spotify\.com\/track\/([a-zA-Z0-9]+)/.test(queryOrUrl)) {
      const id = queryOrUrl.match(/track\/([a-zA-Z0-9]+)/)[1].split("?")[0];
      const { body } = await spotifyApi.getTrack(id);
      return body;
    }
    const { body } = await spotifyApi.searchTracks(String(queryOrUrl), { limit: 1 });
    if (body?.tracks?.items?.length) return body.tracks.items[0];
    return null;
  } catch (e) {
    console.error("Spotify resolve error:", e);
    return null;
  }
}

// -------------------- YouTube Download (Medium Quality) --------------------
async function downloadFromYouTube(query) {
  const filename = `yt_${Date.now()}.mp3`;
  const outputPath = path.join(__dirname, filename);

  try {
    await ytdlp(`ytsearch1:${query}`, {
      extractAudio: true,
      audioFormat: 'mp3',
      audioQuality: 5,        // medium (~122 kbps)
      output: outputPath,
      noPlaylist: true,
      quiet: true,
    });
    return outputPath;
  } catch (err) {
    console.error('YT Download error:', err);
    return null;
  }
}

// -------------------- Flags & Variables --------------------
let targetNumbers = [];
let targetLastMsgs = {};
let lastRepliedMsgId = {};
let isSpamming = {};
let spamInterval = {};
let gcNameInterval = {};
let hasPrintedActive = false;
let disabledChats = [];
let coAdminsLocked = false;
let welcomeEnabledGroups = {}; // { groupId: true/false }

// -------------------- Start Bot --------------------
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth');
  const sock = makeWASocket({
    auth: state,
    logger: P({ level: 'silent' }),
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) qrcode.generate(qr, { small: true });
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) startBot();
    } else if (connection === 'open' && !hasPrintedActive) {
      console.log('✅ Bot is active!');
      hasPrintedActive = true;
    }
  });

  sock.ev.on('messages.upsert', async (msgUpdate) => {
    const msg = msgUpdate.messages[0];
    if (!msg?.message) return;

    const from = msg.key.remoteJid;
    const sender = msg.key.participant || msg.key.remoteJid;
    const messageText =
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      msg.message?.imageMessage?.caption ||
      msg.message?.videoMessage?.caption ||
      '';

    const botJid = (sock.user?.id?.split(':')[0] || '') + '@s.whatsapp.net';
    const isBotItself = sender === botJid;

    if (disabledChats.includes(from) && !['/restartchat','/statuschat'].includes(messageText)) return;

    // -------------------- Target Auto Reply --------------------
    if (targetNumbers.includes(sender)) {
      targetLastMsgs[sender] = msg.key;
      if (isSpamming[from]) {
        if (lastRepliedMsgId[sender] !== targetLastMsgs[sender].id) {
          lastRepliedMsgId[sender] = targetLastMsgs[sender].id;
          const replies = [
            'tmkb rndike ', 'tri bhen rndy', 'lamgde chlmajduri kr',
            'teti ma galat chiod di lekin', 'aj teri behen nilam hogi', 'papa bol bsdk'
          ];
          const randomReply = replies[Math.floor(Math.random() * replies.length)];
          try {
            await delay(1500);
            await sock.sendMessage(from, { text: randomReply }, { quoted: msg });
          } catch (e) { console.log("Slide reply failed", e); }
        }
      }
    }

    // -------------------- ✅ Only allowed users --------------------
    const allowedUsers = [originalAdmin, ...admins, botJid];
    if (!allowedUsers.includes(sender) && !isBotItself) return;

    // -------------------- Spotify Command --------------------
    if (messageText.startsWith('/spotify ')) {
      const query = messageText.replace('/spotify ', '').trim();
      if (!query) return sock.sendMessage(from, { text: '❌ Provide a song name or Spotify link.' }, { quoted: msg });

      const track = await resolveSpotifyTrack(query);
      if (!track) return sock.sendMessage(from, { text: '❌ No track found.' }, { quoted: msg });

      await sock.sendMessage(from, { text: '⏳ Downloading from YouTube...' }, { quoted: msg });
      let filePath;
      try {
        filePath = await downloadFromYouTube(`${track.name} ${track.artists[0].name}`);
        if (!filePath) throw new Error('Download failed');

        const audioBuffer = fs.readFileSync(filePath);
        await sock.sendMessage(from, { audio: audioBuffer, mimetype: 'audio/mpeg', ptt: true }, { quoted: msg });
        await sock.sendMessage(from, { text: '✅ Sent!' }, { quoted: msg });
      } catch (err) {
        console.error(err);
        await sock.sendMessage(from, { text: '❌ Failed to download the song.' }, { quoted: msg });
      } finally {
        if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
      }
      return;
    }

// Command: /welcome on or /welcome off
if (messageText.startsWith('/welcome ')) {
    if (!from.endsWith('@g.us')) return sock.sendMessage(from, { text: '❌ This command works only in groups.' }, { quoted: msg });
    
    const action = messageText.replace('/welcome ', '').trim().toLowerCase();
    if (action !== 'on' && action !== 'off') {
        return sock.sendMessage(from, { text: '⚠️ Usage: /welcome on OR /welcome off' }, { quoted: msg });
    }

    welcomeSettings[from] = action === 'on';
    await sock.sendMessage(from, { text: `✅ Welcome messages are now *${action.toUpperCase()}*` }, { quoted: msg });
}

// Event listener for group participants update
sock.ev.on('group-participants.update', async (update) => {
    const groupId = update.id; // group JID
    const action = update.action; // 'add' or 'remove'
    const participants = update.participants; // array of JIDs

    // Only send welcome if enabled
    if (!welcomeSettings[groupId]) return;

    for (let user of participants) {
        const username = user.split('@')[0];

        if (action === 'add') {
            const welcomeMsg = `👋 Welcome @${username} to the group! Enjoy your stay 🎉`;
            await sock.sendMessage(groupId, {
                image: fs.readFileSync(welcomeImage), 
                caption: welcomeMsg, 
                mentions: [user]
            });
        } 
        else if (action === 'remove') {
            const goodbyeMsg = `👋 @${username} left the group. We'll miss you!`;
            if (fs.existsSync(goodbyeImage)) {
                await sock.sendMessage(groupId, {
                    image: fs.readFileSync(goodbyeImage),
                    caption: goodbyeMsg,
                    mentions: [user]
                });
            } else {
                await sock.sendMessage(groupId, { text: goodbyeMsg, mentions: [user] });
            }
        }
    }
});

// Listen to group participant updates
sock.ev.on('group-participants.update', async (update) => {
  const gid = update.id;
  if (!welcomeEnabledGroups[gid]) return; // welcome disabled

  for (const participant of update.participants) {
    if (update.action === 'add') {
      const ppUrl = await sock.profilePictureUrl(participant, 'image').catch(() => null);
      const caption = `👋 Welcome @${participant.split('@')[0]} to the group!`;
      if (ppUrl) {
        await sock.sendMessage(gid, {
          image: { url: ppUrl },
          caption: caption,
          mentions: [participant]
        });
      } else {
        await sock.sendMessage(gid, { text: caption, mentions: [participant] });
      }
    }
  }
});

    // -------------------- YouTube Command --------------------
    if (messageText.startsWith('/yt ')) {
      const query = messageText.replace('/yt ', '').trim();
      if (!query) return sock.sendMessage(from, { text: '❌ Please provide a song name.' }, { quoted: msg });

      await sock.sendMessage(from, { text: '⏳ Downloading, please wait...' }, { quoted: msg });

      let filePath;
      try {
        filePath = await downloadFromYouTube(query);
        if (!filePath) throw new Error('Download failed');

        const audioBuffer = fs.readFileSync(filePath);
        await sock.sendMessage(from, { audio: audioBuffer, mimetype: 'audio/mpeg', ptt: true }, { quoted: msg });
        await sock.sendMessage(from, { text: '✅ Sent!' }, { quoted: msg });
      } catch (err) {
        console.error(err);
        await sock.sendMessage(from, { text: '❌ Failed to download the song.' }, { quoted: msg });
      } finally {
        if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
      }
      return;
    }

// ===== Group Management Features =====

// /tagall
else if (messageText === '/tagall') {
  if (!from.endsWith('@g.us')) return sock.sendMessage(from, { text: '❌ Only works in groups.' }, { quoted: msg });
  const metadata = await sock.groupMetadata(from);
  const members = metadata.participants.map(p => p.id);
  let textMsg = `📢 *Tagging All Members in ${metadata.subject}* 📢\n\n`;
  for (let mem of members) textMsg += `👤 @${mem.split('@')[0]}\n`;
  await sock.sendMessage(from, { text: textMsg, mentions: members }, { quoted: msg });
}

// /tagadmins
else if (messageText === '/tagadmins') {
  if (!from.endsWith('@g.us')) return sock.sendMessage(from, { text: '❌ Only works in groups.' }, { quoted: msg });
  const metadata = await sock.groupMetadata(from);
  const admins = metadata.participants.filter(p => p.admin).map(p => p.id);
  let textMsg = `⚡ *Tagging All Admins in ${metadata.subject}* ⚡\n\n`;
  for (let mem of admins) textMsg += `⭐ @${mem.split('@')[0]}\n`;
  await sock.sendMessage(from, { text: textMsg, mentions: admins }, { quoted: msg });
}

// /promote
else if (messageText.startsWith('/promote ')) {
  const mentionedJid = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
  if (!mentionedJid) 
    return sock.sendMessage(from, { text: '⚠️ Usage: /promote @user' }, { quoted: msg });

  try {
    await sock.groupParticipantsUpdate(from, [mentionedJid], 'promote');
    await sock.sendMessage(from, { text: `✅ Promoted @${mentionedJid.split('@')[0]}`, mentions: [mentionedJid] }, { quoted: msg });
  } catch (e) {
    console.error("Promote Error:", e);
    await sock.sendMessage(from, { text: '❌ Failed! Make sure bot is *admin*.' }, { quoted: msg });
  }
}

// /demote
else if (messageText.startsWith('/demote ')) {
  const mentionedJid = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
  if (!mentionedJid) 
    return sock.sendMessage(from, { text: '⚠️ Usage: /demote @user' }, { quoted: msg });

  try {
    await sock.groupParticipantsUpdate(from, [mentionedJid], 'demote');
    await sock.sendMessage(from, { text: `❌ Demoted @${mentionedJid.split('@')[0]}`, mentions: [mentionedJid] }, { quoted: msg });
  } catch (e) {
    console.error("Demote Error:", e);
    await sock.sendMessage(from, { text: '❌ Failed! Make sure bot is *admin*.' }, { quoted: msg });
  }
}

// /kick
else if (messageText.startsWith('/kick ')) {
  const mentionedJid = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
  if (!mentionedJid) 
    return sock.sendMessage(from, { text: '⚠️ Usage: /kick @user' }, { quoted: msg });

  try {
    await sock.groupParticipantsUpdate(from, [mentionedJid], 'remove');
    await sock.sendMessage(from, { text: `🚫 Removed @${mentionedJid.split('@')[0]}`, mentions: [mentionedJid] }, { quoted: msg });
  } catch (e) {
    console.error("Kick Error:", e);
    await sock.sendMessage(from, { text: '❌ Failed to remove. Bot must be *admin*.' }, { quoted: msg });
  }
}

// /add
else if (messageText.startsWith('/add ')) {
  const number = messageText.replace('/add ', '').trim();
  if (!number) 
    return sock.sendMessage(from, { text: '⚠️ Usage: /add 91xxxxxxxx' }, { quoted: msg });

  const userJid = number.replace(/[^0-9]/g, '') + '@s.whatsapp.net';

  try {
    await sock.groupParticipantsUpdate(from, [userJid], 'add');
    await sock.sendMessage(from, { text: `✅ Added @${number}`, mentions: [userJid] }, { quoted: msg });
  } catch (e) {
    console.error("Add Error:", e);
    await sock.sendMessage(from, { text: '❌ Failed to add user. Bot must be *admin*.' }, { quoted: msg });
  }
}

// /leave
else if (messageText === '/leave') {
  await sock.sendMessage(from, { text: '👋 Leaving group...' }, { quoted: msg });
  await sock.groupLeave(from);
}

// /ginfo
else if (messageText === '/ginfo') {
  if (!from.endsWith('@g.us')) return sock.sendMessage(from, { text: '❌ Only works in groups.' }, { quoted: msg });
  const metadata = await sock.groupMetadata(from);
  const groupName = metadata.subject || "Unnamed Group";
  const groupId = from;
  const membersCount = metadata.participants?.length || 0;
  const admins = metadata.participants.filter(p => p.admin).map(p => "@" + p.id.split('@')[0]).join(', ');
  const infoText = `
📊 *Group Information* 📊
👥 *Name:* ${groupName}
🆔 *ID:* ${groupId}
👤 *Members:* ${membersCount}
⭐ *Admins:* ${admins || "None"}
  `;
  await sock.sendMessage(from, { text: infoText, mentions: metadata.participants.map(p => p.id) }, { quoted: msg });
}

// /roast
else if (messageText.startsWith('/roast ')) {
  const mentionedJid = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
  if (!mentionedJid) {
    return sock.sendMessage(from, { text: '⚠️ Usage: /roast @user' }, { quoted: msg });
  }

  try {
    // Get profile picture
    let ppUrl;
    try {
      ppUrl = await sock.profilePictureUrl(mentionedJid, "image");
    } catch {
      ppUrl = null; // no dp
    }

    // Get bio/status
    let bio;
    try {
      const status = await sock.fetchStatus(mentionedJid);
      bio = status.status || "🤐 No bio, empty like their brain.";
    } catch {
      bio = "🤐 No bio, empty like their brain.";
    }

    // Roast lines (you can add more)
    const roasts = [
      `😂 @${mentionedJid.split('@')[0]} has a DP that even ghosts are scared of.`,
      `📛 Bio says: "${bio}"\nBruh, that’s deeper than their brain cells.`,
      `🤣 People say "don’t judge a book by its cover", but looking at @${mentionedJid.split('@')[0]}, even the cover is a warning sign.`,
      `⚡ Fun fact: @${mentionedJid.split('@')[0]} tries to be cool... WhatsApp is still buffering.`,
      `😜 If brains were currency, @${mentionedJid.split('@')[0]} would still be in debt.`
    ];

    // Pick a random roast
    const roastText = roasts[Math.floor(Math.random() * roasts.length)];

    // Send roast (with DP if available)
    if (ppUrl) {
      await sock.sendMessage(from, {
        image: { url: ppUrl },
        caption: roastText,
        mentions: [mentionedJid]
      }, { quoted: msg });
    } else {
      await sock.sendMessage(from, { text: roastText, mentions: [mentionedJid] }, { quoted: msg });
    }

  } catch (e) {
    console.error("Roast Error:", e);
    await sock.sendMessage(from, { text: '❌ Failed to roast this user.' }, { quoted: msg });
  }
}



    // -------------------- VN --------------------
    if (messageText.startsWith('/vn ')) {
      const textToSpeak = messageText.replace('/vn ', '').trim();
      if (!textToSpeak) return;
      const gtts = new gTTS(textToSpeak, 'en');
      const chunks = [];
      const stream = gtts.stream();
      stream.on('data', chunk => chunks.push(chunk));
      stream.on('end', async () => {
        const buffer = Buffer.concat(chunks);
        try {
          await sock.sendMessage(from, { audio: buffer, mimetype: 'audio/mp4', ptt: true }, { quoted: msg });
        } catch (e) { console.log('VN send failed', e); }
      });
      stream.on('error', console.error);
      return;
    }
// /emoji <text> → converts each letter to regional indicator emojis
if (messageText.startsWith('/emoji ')) {
    const inputText = messageText.replace('/emoji ', '').trim();
    if (!inputText) return sock.sendMessage(from, { text: '⚠️ Please provide text. Example: /emoji hello' }, { quoted: msg });

    const emojiText = inputText
        .toLowerCase()
        .split('')
        .map(char => {
            if (char >= 'a' && char <= 'z') return `:regional_indicator_${char}:`;
            if (char === ' ') return '   '; // preserve spaces
            if (char >= '0' && char <= '9') return `:${char}:`; // optional for numbers
            return char; // keep other symbols as is
        })
        .join(' ');

    await sock.sendMessage(from, { text: emojiText }, { quoted: msg });
}

// /mock <text> → SpongeBob mocking text
if (messageText.startsWith('/mock ')) {
    const inputText = messageText.replace('/mock ', '').trim();
    if (!inputText) return sock.sendMessage(from, { text: '⚠️ Please provide text. Example: /mock hello world' }, { quoted: msg });

    const mockingText = inputText
        .split('')
        .map((char, i) => i % 2 === 0 ? char.toLowerCase() : char.toUpperCase())
        .join('');

    await sock.sendMessage(from, { text: mockingText }, { quoted: msg });
}

if (messageText === '/hangman') {
    if (!from.endsWith('@g.us')) return sock.sendMessage(from, { text: '❌ Hangman can only be played in groups.' }, { quoted: msg });
    if (hangmanGames[from]) return sock.sendMessage(from, { text: '⚠️ A Hangman game is already running in this group!' }, { quoted: msg });

    const word = hangmanWords[Math.floor(Math.random() * hangmanWords.length)];
    const display = '_'.repeat(word.length);

    hangmanGames[from] = {
        word,
        display,
        attemptsLeft: 6,
        guessedLetters: []
    };

    await sock.sendMessage(from, { text: `🎮 Hangman started!\nWord: ${display.split('').join(' ')}\nAttempts left: 6\n\nGuess letters using /guess <letter>` }, { quoted: msg });
}

if (messageText.startsWith('/guess ')) {
    if (!from.endsWith('@g.us')) return sock.sendMessage(from, { text: '❌ Hangman can only be played in groups.' }, { quoted: msg });
    const game = hangmanGames[from];
    if (!game) return sock.sendMessage(from, { text: '⚠️ No active Hangman game. Start one using /hangman' }, { quoted: msg });

    const guess = messageText.replace('/guess ', '').trim().toLowerCase();
    if (!guess || guess.length !== 1 || !/[a-z]/.test(guess)) {
        return sock.sendMessage(from, { text: '⚠️ Guess must be a single letter (a-z).' }, { quoted: msg });
    }

    if (game.guessedLetters.includes(guess)) {
        return sock.sendMessage(from, { text: `⚠️ Letter '${guess}' has already been guessed.` }, { quoted: msg });
    }

    game.guessedLetters.push(guess);

    if (game.word.includes(guess)) {
        // Reveal letters
        let newDisplay = '';
        for (let i = 0; i < game.word.length; i++) {
            newDisplay += (game.word[i] === guess || game.guessedLetters.includes(game.word[i])) ? game.word[i] : '_';
        }
        game.display = newDisplay;

        if (!game.display.includes('_')) {
            await sock.sendMessage(from, { text: `🎉 Congratulations! Word guessed: *${game.word}*` }, { quoted: msg });
            delete hangmanGames[from];
        } else {
            await sock.sendMessage(from, { text: `✅ Correct guess!\nWord: ${game.display.split('').join(' ')}\nAttempts left: ${game.attemptsLeft}` }, { quoted: msg });
        }
    } else {
        game.attemptsLeft -= 1;
        if (game.attemptsLeft <= 0) {
            await sock.sendMessage(from, { text: `💀 Game over! The word was: *${game.word}*` }, { quoted: msg });
            delete hangmanGames[from];
        } else {
            await sock.sendMessage(from, { text: `❌ Wrong guess! Letter: '${guess}'\nWord: ${game.display.split('').join(' ')}\nAttempts left: ${game.attemptsLeft}` }, { quoted: msg });
        }
    }
}

if (messageText.startsWith('/tictactoe')) {
    if (!from.endsWith('@g.us')) return sock.sendMessage(from, { text: '❌ Tic-Tac-Toe can only be played in groups.' }, { quoted: msg });

    if (tttGames[from]) return sock.sendMessage(from, { text: '⚠️ A Tic-Tac-Toe game is already running in this group!' }, { quoted: msg });

    const mentions = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
    let opponent, isBot = false;

    if (mentions.length === 0 || mentions[0] === sock.user?.id) {
        opponent = 'BOT';
        isBot = true;
    } else {
        opponent = mentions[0];
    }

    tttGames[from] = {
        board: ['1','2','3','4','5','6','7','8','9'],
        players: [sender, opponent],
        turn: sender,
        isBot
    };

    await sock.sendMessage(from, { text: `🎮 Tic-Tac-Toe started!\n${renderBoard(tttGames[from].board)}\n\nIt’s <@${sender.split('@')[0]}>'s turn!\nUse /place <number> to make a move.` , mentions: [sender] }, { quoted: msg });
}

if (messageText.startsWith('/place ')) {
    const game = tttGames[from];
    if (!game) return sock.sendMessage(from, { text: '⚠️ No active Tic-Tac-Toe game. Start one using /tictactoe @user' }, { quoted: msg });

    if (game.turn !== sender) return sock.sendMessage(from, { text: "⚠️ It's not your turn!" }, { quoted: msg });

    const move = parseInt(messageText.replace('/place ', '').trim());
    if (!move || move < 1 || move > 9 || game.board[move - 1] === 'X' || game.board[move - 1] === 'O') {
        return sock.sendMessage(from, { text: '⚠️ Invalid move! Pick an empty number from 1-9.' }, { quoted: msg });
    }

    const symbol = game.players[0] === sender ? 'X' : 'O';
    game.board[move - 1] = symbol;

    // Check win
    const winner = checkWinner(game.board);
    if (winner) {
        await sock.sendMessage(from, { text: `${renderBoard(game.board)}\n🎉 ${winner === 'X' ? `<@${game.players[0].split('@')[0]}>` : `<@${game.players[1] === 'BOT' ? 'BOT' : game.players[1].split('@')[0]}>`} wins!` , mentions: game.players[1] === 'BOT' ? [] : game.players}, { quoted: msg });
        delete tttGames[from];
        return;
    }

    // Check draw
    if (game.board.every(c => c === 'X' || c === 'O')) {
        await sock.sendMessage(from, { text: `${renderBoard(game.board)}\n🤝 It's a draw!` }, { quoted: msg });
        delete tttGames[from];
        return;
    }

    // Switch turn
    if (game.turn === game.players[0]) game.turn = game.players[1]; else game.turn = game.players[0];

    await sock.sendMessage(from, { text: `${renderBoard(game.board)}\nIt’s <@${game.turn === 'BOT' ? 'BOT' : game.turn.split('@')[0]}>'s turn!` , mentions: game.turn === 'BOT' ? [] : [game.turn]}, { quoted: msg });

    // Bot move if bot's turn
    if (game.turn === 'BOT') {
        await delay(1000); // simulate thinking
        const empty = game.board.map((v,i) => (v !== 'X' && v !== 'O') ? i : null).filter(v=>v!==null);
        const botMove = empty[Math.floor(Math.random()*empty.length)];
        game.board[botMove] = 'O';

        const botWinner = checkWinner(game.board);
        if (botWinner) {
            await sock.sendMessage(from, { text: `${renderBoard(game.board)}\n💀 BOT wins!` }, { quoted: msg });
            delete tttGames[from];
            return;
        }

        if (game.board.every(c => c === 'X' || c === 'O')) {
            await sock.sendMessage(from, { text: `${renderBoard(game.board)}\n🤝 It's a draw!` }, { quoted: msg });
            delete tttGames[from];
            return;
        }

        game.turn = game.players[0];
        await sock.sendMessage(from, { text: `${renderBoard(game.board)}\nIt’s <@${game.turn.split('@')[0]}>'s turn!` , mentions: [game.turn]}, { quoted: msg });
    }
}

// Example feature flags (you can update dynamically elsewhere in your bot)
let features = {
    nc: false,
    spam: false,
    sticker: true,
    tts: true,
    ai: false
};

// -------------------- Menu --------------------
if (messageText === '/menu') {
  const menuText = `
╔═══✦✦✦✦✦✦✦═══╗
   🤖 *BOT MASTER MENU* 🤖
╚═══✦✦✦✦✦✦✦═══╝

📌 *ADMIN COMMANDS*  
👑 /coadmin <num> → Add co-admin by number  
❌ /removeadmin <num> → Remove co-admin rights  
🛑 /stopall → Remove all co-admins  
📋 /adminlist → Show current admin list  
🔒 /disable → Lock co-admin control  
🔓 /enable → Unlock co-admin control  

🎯 *TARGET CONTROL*  
🎯 /target <num ...> → Set target numbers  
➖ /removetarget <num> → Remove number from targets  
🚀 /spam <text> → Start spam messages  
▶️ /startspam → Start auto spam  
⏹ /stop → Stop spam & all actions  

👥 *GROUP MANAGEMENT*  
👥 /tagall → Tag everyone in group  
⭐ /tagadmins → Tag only admins  
⤴️ /promote @user → Promote user  
⤵️ /demote @user → Demote admin  
🚫 /kick @user → Remove user  
➕ /add <num> → Add user to group  
👋 /leave → Bot leaves group  
✏️ /gcname <name> → Auto rename group  
ℹ️ /ginfo → Show group info  
🫳 /welcome on // /welcome off 

🎶 *MEDIA & FUN*  
▶️ /yt <song> → Download song from YouTube  
🎵 /spotify <song/link> → Download via Spotify  
🔊 /tts <text> → Text-to-speech  
🎙 /vn <text> → Voice note from text  
🔥 /roast @user → Roast a user  
🪶 /joke > make random joke
🦇 /love @us @us calc love %
🦋 /emoji <text> reg->h
🐥 /mock <text>

🌍 *LANGUAGE SETTINGS*  
🌍 /langs → Show available languages  
📝 /setlang <code> → Set language for TTS  

⚡ *UTILITIES*  
🏓 /ping → Check bot response  
📡 /status → Bot active status  
🔇 /stopchat → Pause bot in chat  
🔄 /restartchat → Reactivate bot in chat  
📊 /statuschat → Show chat status 

🎮 *GAMES*

1. > /hangman > word guess game 
2. > /tictactoe > chl game`;
  await sock.sendMessage(from, { text: menuText }, { quoted: msg });
  return;
}

// langs.js
const LANGUAGES = { 
    "en": "English",
    "hi": "Hindi",
    "fr": "French",
    "es": "Spanish",
    "de": "German",
    "it": "Italian",
    "ja": "Japanese",
    "ko": "Korean",
    "zh-cn": "Chinese (Simplified)",
    "zh-tw": "Chinese (Traditional)",
    "ru": "Russian",
    "ar": "Arabic",
    "pt": "Portuguese"
};

/**
 * Returns formatted language list as string
 */
function getLangsList() {
    let langsList = "🌍 *Available Languages:*\n\n";
    for (const [code, name] of Object.entries(LANGUAGES)) {
        langsList += `• ${code} → ${name}\n`;
    }
    return langsList;
}

module.exports = {
    LANGUAGES,
    getLangsList
};

if (messageText === "/langs") {
    const list = getLangsList();
    await sock.sendMessage(from, { text: list }, { quoted: msg });
}


if (messageText.startsWith("/setlang ")) {
    const lang = messageText.replace("/setlang ", "").trim();
    if (!LANGUAGES[lang]) {
        return sock.sendMessage(from, { text: "❌ Invalid code. Use /langs" }, { quoted: msg });
    }
    groupLangs[from] = lang;
    await sock.sendMessage(from, { text: `✅ Language set to *${LANGUAGES[lang]}* (${lang})` }, { quoted: msg });
}

if (messageText.startsWith("/tts ")) {
    const speakText = messageText.replace("/tts ", "").trim();
    if (!speakText) return;

    const lang = groupLangs[from] || "en"; // default English

    try {
        const gtts = new gTTS(speakText, lang);
        const filePath = `tts_${Date.now()}.mp3`;

        gtts.save(filePath, async (err) => {
            if (err) {
                console.error("TTS Error:", err);
                return sock.sendMessage(from, { text: "❌ Failed to generate TTS" }, { quoted: msg });
            }
            await sock.sendMessage(from, { audio: { url: filePath }, mimetype: "audio/mpeg", ptt: true }, { quoted: msg });
            fs.unlinkSync(filePath);
        });
    } catch (e) {
        console.error("TTS Exception:", e);
        await sock.sendMessage(from, { text: "❌ Error generating TTS" }, { quoted: msg });
    }
}

// /compatibility @user1 @user2 → fun percentage
if (messageText.startsWith('/love')) {
    const mentions = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
    if (mentions.length < 2) {
        return sock.sendMessage(from, { text: '⚠️ Please mention *two users*! Example: /compatibility @user1 @user2' }, { quoted: msg });
    }

    const user1 = mentions[0].split('@')[0];
    const user2 = mentions[1].split('@')[0];
    const percentage = Math.floor(Math.random() * 101);

    const response = `💖 Compatibility between @${user1} and @${user2} is *${percentage}%*! 💖`;

    await sock.sendMessage(from, { text: response, mentions: mentions }, { quoted: msg });
}

// /joke → sends a random joke
if (messageText === '/joke') {
    try {
        const res = await axios.get('https://v2.jokeapi.dev/joke/Any');
        const joke = res.data.type === 'single'
            ? res.data.joke
            : `${res.data.setup}\n\n${res.data.delivery}`;
        await sock.sendMessage(from, { text: joke }, { quoted: msg });
    } catch (err) {
        await sock.sendMessage(from, { text: '😅 Could not fetch a joke right now!' }, { quoted: msg });
    }
}

    // -------------------- Other Admin/Spam/GC Commands --------------------
    // /ping
    if (messageText === '/ping') {
      const start = Date.now();
      await sock.sendMessage(from, { text: '🏓 Pong!' }, { quoted: msg });
      const diff = Date.now() - start;
      await sock.sendMessage(from, { text: `🏓 Pong! Response time: ${diff} ms` }, { quoted: msg });
    }

    // /coadmin
    else if (messageText.startsWith('/coadmin ')) {
      const num = messageText.split(' ')[1].replace(/[^0-9]/g, '');
      const jid = `${num}@s.whatsapp.net`;
      if (!admins.includes(jid)) {
        admins.push(jid);
        await sock.sendMessage(from, { text: `✅ Added co-admin: ${num}` }, { quoted: msg });
      } else await sock.sendMessage(from, { text: `⚠️ Already an admin.` }, { quoted: msg });
    }

    // /removeadmin
    else if (messageText.startsWith('/removeadmin ')) {
      const num = messageText.split(' ')[1]?.replace(/[^0-9]/g, '');
      if (!num) return sock.sendMessage(from, { text: '⚠️ Usage: /removeadmin 91XXXXXXXXXX' }, { quoted: msg });
      const jid = `${num}@s.whatsapp.net`;
      if (jid === originalAdmin) return sock.sendMessage(from, { text: '❌ Cannot remove original admin.' }, { quoted: msg });
      if (!admins.includes(jid)) return sock.sendMessage(from, { text: '⚠️ Not an admin.' }, { quoted: msg });
      admins = admins.filter(a => a !== jid);
      await sock.sendMessage(from, { text: `🗑️ Removed admin: ${num}` }, { quoted: msg });
    }

    // /stopall
    else if (messageText === '/stopall') {
      const coAdmins = admins.filter(a => a !== originalAdmin);
      if (coAdmins.length === 0) return sock.sendMessage(from, { text: '✅ No co-admins to remove.' }, { quoted: msg });
      admins = [originalAdmin];
      await sock.sendMessage(from, { text: `🗑️ Removed all co-admins.` }, { quoted: msg });
    }

    // /adminlist
    else if (messageText === '/adminlist') {
      let mainAdminLine = `👑 Main Admin:\n• ${originalAdmin.replace('@s.whatsapp.net', '')}`;
      let coAdmins = admins.filter(a => a !== originalAdmin);
      let coAdminLines = coAdmins.map(a => `• ${a.replace('@s.whatsapp.net', '')}`).join('\n') || 'None';
      await sock.sendMessage(from, { text: `${mainAdminLine}\n\n🤝 Co-Admins:\n${coAdminLines}` }, { quoted: msg });
    }

// /status → Show bot system status
if (messageText === '/status') {
    const uptime = process.uptime(); // in seconds
    const uptimeHrs = Math.floor(uptime / 3600);
    const uptimeMin = Math.floor((uptime % 3600) / 60);
    const uptimeSec = Math.floor(uptime % 60);

    const usedMem = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
    const totalMem = (process.memoryUsage().heapTotal / 1024 / 1024).toFixed(2);

    const statusMsg = `📊 *Bot Status* 📊\n
⏱️ Uptime: *${uptimeHrs}h ${uptimeMin}m ${uptimeSec}s*
💾 Memory: *${usedMem} MB / ${totalMem} MB*
🤖 Platform: *${process.platform}*
📡 Ping: *${Date.now() - msg.messageTimestamp * 1000}ms*
`;

    await sock.sendMessage(from, { text: statusMsg }, { quoted: msg });
}

    // /target
    else if (messageText.startsWith('/target ')) {
      const nums = messageText.split(' ').slice(1).map(n => n.replace(/[^0-9]/g, ''));
      targetNumbers = nums.map(n => `${n}@s.whatsapp.net`);
      targetLastMsgs = {};
      lastRepliedMsgId = {};
      await sock.sendMessage(from, { text: `🎯 Targets set:\n${nums.join('\n')}` }, { quoted: msg });
    }

    // /removetarget
    else if (messageText.startsWith('/removetarget ')) {
      const num = messageText.split(' ')[1]?.replace(/[^0-9]/g, '');
      if (!num) return sock.sendMessage(from, { text: '⚠️ Usage: /removetarget <number>' }, { quoted: msg });
      const jid = `${num}@s.whatsapp.net`;
      if (!targetNumbers.includes(jid)) return sock.sendMessage(from, { text: '⚠️ Not a target.' }, { quoted: msg });
      targetNumbers = targetNumbers.filter(t => t !== jid);
      delete targetLastMsgs[jid]; delete lastRepliedMsgId[jid];
      await sock.sendMessage(from, { text: `🗑️ Removed target: ${num}` }, { quoted: msg });
    }

    // /startspam
    else if (messageText === '/startspam') {
      if (targetNumbers.length === 0) return sock.sendMessage(from, { text: '❌ Set target first using /target' }, { quoted: msg });
      if (isSpamming[from]) return sock.sendMessage(from, { text: '⚠️ Already spamming here!' }, { quoted: msg });
      isSpamming[from] = true;
      await sock.sendMessage(from, { text: '✅ Spam started here.' }, { quoted: msg });
    }

    // /spam
    else if (messageText.startsWith('/spam ')) {
      const spamText = messageText.replace('/spam ', '').trim();
      if (isSpamming[from]) return sock.sendMessage(from, { text: '⚠️ Already spamming!' }, { quoted: msg });
      isSpamming[from] = true;
      await sock.sendMessage(from, { text: '🚀 Spamming started here!' }, { quoted: msg });
      spamInterval[from] = setInterval(async () => {
        if (isSpamming[from]) {
          try {
            // 👇 quoted hata diya, ab normal msg bhejega
            await sock.sendMessage(from, { text: spamText });
            await delay(3000);
          } catch (e) { console.log("Spam send failed", e); }
        }
      }, 2000);
    }

    // /stop
    else if (messageText === '/stop') {
      if (spamInterval[from]) { clearInterval(spamInterval[from]); delete spamInterval[from]; }
      if (gcNameInterval[from]) { clearInterval(gcNameInterval[from]); delete gcNameInterval[from]; }
      isSpamming[from] = false;
      lastRepliedMsgId = {};
      await sock.sendMessage(from, { text: '🛑 Actions stopped.' }, { quoted: msg });
    }



    // /gcname
    else if (messageText.startsWith('/gcname ')) {
      const nameText = messageText.replace('/gcname ', '').trim();
      const emoji = ['🪶','🦋','🦇','🐣','🐦','🐧','🐌'];
      if (from.endsWith('@g.us')) {
        if (gcNameInterval[from]) clearInterval(gcNameInterval[from]);
        gcNameInterval[from] = setInterval(async () => {
          try {
            const randomEmoji = emoji[Math.floor(Math.random() * emoji.length)];
            await sock.groupUpdateSubject(from, `${randomEmoji} ${nameText}`);
            await delay(2000);
          } catch (e) { console.log("Group name change failed", e); }
        }, 900); // ✅ 5s delay rakha
      } else await sock.sendMessage(from, { text: '❌ Not a group chat!' }, { quoted: msg });
    }

    // /stopchat
    else if (messageText === '/stopchat') {
      if (!disabledChats.includes(from)) {
        disabledChats.push(from);
        await sock.sendMessage(from, { text: '🔕 Bot deactivated here.' }, { quoted: msg });
      } else await sock.sendMessage(from, { text: '⚠️ Already inactive.' }, { quoted: msg });
    }

    // /restartchat
    else if (messageText === '/restartchat') {
      disabledChats = disabledChats.filter(chat => chat !== from);
      await sock.sendMessage(from, { text: '✅ Bot reactivated here.' }, { quoted: msg });
    }

    // /statuschat
    else if (messageText === '/statuschat') {
      const status = disabledChats.includes(from) ? '❌ Inactive' : '✅ Active';
      await sock.sendMessage(from, { text: `📊 Status in this chat: ${status}` }, { quoted: msg });
    }

    // /disable
    else if (messageText === '/disable') {
      coAdminsLocked = true;
      await sock.sendMessage(from, { text: '🔒 Co-admins restricted.' }, { quoted: msg });
    }

    // /enable
    else if (messageText === '/enable') {
      coAdminsLocked = false;
      await sock.sendMessage(from, { text: '🔓 Co-admins allowed again.' }, { quoted: msg });
    }
  });
}

startBot();