const { Telegraf, Markup } = require('telegraf');
const { MongoClient } = require('mongodb');

const bot = new Telegraf(process.env.BOT_TOKEN);
let cachedDb = null;
let webhookConfigured = false;

// 30-minute menu lifetime for lazy timer purge
const MENU_TTL_MS = 30 * 60 * 1000;

// Reusable Database Connection
async function connectToDatabase() {
  if (cachedDb) return cachedDb;
  const client = await MongoClient.connect(process.env.MONGODB_URI, {
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 5000,
  });
  cachedDb = client.db('medrehab');
  return cachedDb;
}

// Safe Message Deletion (Catches missing bot rights or already-deleted messages)
async function safeDelete(chatId, messageIds) {
  try {
    const ids = Array.isArray(messageIds) ? messageIds : [messageIds];
    if (ids.length === 1) {
      await bot.telegram.deleteMessage(chatId, ids[0]);
    } else if (ids.length > 1) {
      await bot.telegram.deleteMessages(chatId, ids);
    }
  } catch (err) {
    if (err.response?.error_code !== 400 && err.response?.error_code !== 403) {
      console.warn('SafeDelete Notice:', err.description || err.message);
    }
  }
}

// Lazy Timer: Sweep and purge expired active menus from chat on next command
async function cleanupStaleMenus(db, chatId) {
  try {
    const now = new Date();
    const expiredMenus = await db.collection('active_menus').find({
      chatId,
      expiresAt: { $lte: now }
    }).toArray();

    for (const menu of expiredMenus) {
      if (menu.messageId) {
        await safeDelete(chatId, menu.messageId);
      }
    }

    if (expiredMenus.length > 0) {
      await db.collection('active_menus').deleteMany({
        chatId,
        expiresAt: { $lte: now }
      });
    }
  } catch (err) {
    console.warn('Stale menu cleanup notice:', err.message);
  }
}

// Admin Check (Group Creator, Administrators, or Master Super Admin)
async function isGroupAdmin(ctx, userId) {
  if (String(userId) === String(process.env.SUPER_ADMIN_ID)) return true;
  try {
    const member = await ctx.telegram.getChatMember(ctx.chat.id, userId);
    return ['creator', 'administrator'].includes(member.status);
  } catch {
    return false;
  }
}

// Identify if the message context is the General tab / Main root
function isGeneralTab(ctx) {
  const threadId = ctx.message?.message_thread_id;
  return !threadId || threadId === 1;
}

// Course Code Normalizer ("med 101", "MED-101", "Intro to MED 101" -> "MED101")
function extractCourseCode(text) {
  if (!text) return null;
  const match = text.match(/([a-zA-Z]{3})\s*[-_]?\s*([0-9]{3})/i);
  return match ? `${match[1].toUpperCase()}${match[2]}` : null;
}

// Strict Type Classifier: Word boundaries prevent false triggers (e.g., "opaque", "equipment")
function detectMaterialType(rawTitle, caption = '') {
  const cleanedText = `${rawTitle} ${caption}`
    .replace(/\.(pdf|docx?|pptx?|epub|txt)/gi, ' ')
    .replace(/[_.\-]+/g, ' ')
    .toLowerCase();

  const isPQ = /\b(pq|pqs|past\s*questions?|pastquestions?|exams?|examination|test|tests|continuous\s*assessment|ca)\b/i.test(cleanedText);
  return isPQ ? 'pq' : 'doc';
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Topic Auto-Index: Newly created forum topics
bot.on('forum_topic_created', async (ctx) => {
  const topic = ctx.message.forum_topic_created;
  const courseCode = extractCourseCode(topic.name);

  if (courseCode) {
    const db = await connectToDatabase();
    await db.collection('topics').updateOne(
      { chatId: ctx.chat.id, courseCode },
      { 
        $set: { 
          threadId: ctx.message.message_thread_id, 
          topicName: topic.name, 
          updatedAt: new Date() 
        } 
      },
      { upsert: true }
    );
  }
});

// Topic Auto-Index: Edited or renamed forum topics
bot.on('forum_topic_edited', async (ctx) => {
  const edited = ctx.message.forum_topic_edited;
  if (!edited?.name) return;

  const courseCode = extractCourseCode(edited.name);
  if (courseCode) {
    const db = await connectToDatabase();
    await db.collection('topics').updateOne(
      { chatId: ctx.chat.id, courseCode },
      { 
        $set: { 
          threadId: ctx.message.message_thread_id, 
          topicName: edited.name, 
          updatedAt: new Date() 
        } 
      },
      { upsert: true }
    );
  }
});

// Manual Topic Linker: /setcourse MED101
bot.command('setcourse', async (ctx) => {
  const chatId = ctx.chat.id;
  await safeDelete(chatId, ctx.message.message_id);

  const isAdmin = await isGroupAdmin(ctx, ctx.from.id);
  if (!isAdmin) return;

  if (isGeneralTab(ctx)) {
    const warn = await ctx.reply('⚠️ Cannot map the General tab. Run this inside a specific course topic.');
    setTimeout(() => safeDelete(chatId, warn.message_id), 6000);
    return;
  }

  const threadId = ctx.message.message_thread_id;
  const courseCode = extractCourseCode(ctx.message.text);

  if (!courseCode) {
    const warn = await ctx.reply('⚠️ Provide a course code. Example: <code>/setcourse MED101</code>', { parse_mode: 'HTML' });
    setTimeout(() => safeDelete(chatId, warn.message_id), 6000);
    return;
  }

  const db = await connectToDatabase();
  await db.collection('topics').updateOne(
    { chatId, courseCode },
    { $set: { threadId, updatedAt: new Date() } },
    { upsert: true }
  );

  const confirm = await ctx.reply(`✅ Topic mapped to <b>${courseCode}</b>.`, { parse_mode: 'HTML' });
  setTimeout(() => safeDelete(chatId, confirm.message_id), 5000);
});

// --- /save Handler with Confirmation & Declination Alerts ---
bot.command('save', async (ctx) => {
  const chatId = ctx.chat.id;
  const userMsgId = ctx.message.message_id;
  const currentThreadId = ctx.message.message_thread_id;

  await safeDelete(chatId, userMsgId);

  const isAdmin = await isGroupAdmin(ctx, ctx.from.id);
  if (!isAdmin) return;

  const replyTarget = ctx.message.reply_to_message;
  if (!replyTarget) {
    const declination = await ctx.reply('⚠️ <b>Declined:</b> Reply directly to the material you want to save.', { parse_mode: 'HTML' });
    setTimeout(() => safeDelete(chatId, declination.message_id), 6000);
    return;
  }

  const db = await connectToDatabase();
  await cleanupStaleMenus(db, chatId);

  const rawInput = ctx.message.text.trim().split(/\s+/).slice(1).join(' ');
  let courseCode = null;

  // 1. Argument passed: /save MED101 or /save Anatomy
  if (rawInput) {
    courseCode = extractCourseCode(rawInput);
    if (!courseCode) {
      const matchedTopic = await db.collection('topics').findOne({
        chatId,
        topicName: { $regex: new RegExp(rawInput, 'i') }
      });
      if (matchedTopic) courseCode = matchedTopic.courseCode;
    }
  }

  // 2. Infer from current topic if inside one
  if (!courseCode && !isGeneralTab(ctx)) {
    const topicEntry = await db.collection('topics').findOne({ chatId, threadId: currentThreadId });
    if (topicEntry) courseCode = topicEntry.courseCode;
  }

  // Declination: Course cannot be resolved
  if (!courseCode) {
    const declination = await ctx.reply(
      '⚠️ <b>Declined:</b> Specify the course or topic name.\nExample: <code>/save MED101</code> or reply inside that course\'s topic.',
      { parse_mode: 'HTML' }
    );
    setTimeout(() => safeDelete(chatId, declination.message_id), 8000);
    return;
  }

  const doc = replyTarget.document;
  const caption = replyTarget.caption || '';
  const textContent = replyTarget.text || '';

  let rawTitle = doc?.file_name || caption || textContent.split('\n')[0] || 'Course Material';
  let cleanTitle = rawTitle.replace(/\.[^/.]+$/, '').replace(/[_]+/g, ' ').trim();

  const fileType = detectMaterialType(rawTitle, caption);

  const cleanChatId = String(chatId).replace(/^-100/, '');
  const jumpLink = currentThreadId && !isGeneralTab(ctx)
    ? `https://t.me/c/${cleanChatId}/${currentThreadId}/${replyTarget.message_id}`
    : `https://t.me/c/${cleanChatId}/${replyTarget.message_id}`;

  await db.collection('resources').updateOne(
    { course: courseCode, jumpLink },
    {
      $set: {
        title: cleanTitle,
        type: fileType,
        uploadedBy: ctx.from.id,
        topicId: currentThreadId || null,
        updatedAt: new Date()
      }
    },
    { upsert: true }
  );

  const confirmation = await ctx.reply(
    `✅ Saved to <b>${courseCode}</b>\n${fileType === 'pq' ? '📝' : '📄'} <b>${escapeHtml(cleanTitle)}</b>`,
    { parse_mode: 'HTML' }
  );
  setTimeout(() => safeDelete(chatId, confirmation.message_id), 5000);
});

// --- /move Handler with Reclassification Alerts ---
bot.command('move', async (ctx) => {
  const chatId = ctx.chat.id;
  await safeDelete(chatId, ctx.message.message_id);

  const isAdmin = await isGroupAdmin(ctx, ctx.from.id);
  if (!isAdmin) return;

  const replyTarget = ctx.message.reply_to_message;
  if (!replyTarget) {
    const declination = await ctx.reply('⚠️ <b>Declined:</b> Reply directly to the material you want to move.', { parse_mode: 'HTML' });
    setTimeout(() => safeDelete(chatId, declination.message_id), 6000);
    return;
  }

  const rawArgs = ctx.message.text.trim().split(/\s+/).slice(1);
  const newCourseCode = extractCourseCode(ctx.message.text);
  const wantsPQ = rawArgs.some(arg => ['pq', 'exam', 'test'].includes(arg.toLowerCase()));
  const wantsDoc = rawArgs.some(arg => ['doc', 'slide', 'note', 'book'].includes(arg.toLowerCase()));
  const newType = wantsPQ ? 'pq' : (wantsDoc ? 'doc' : null);

  if (!newCourseCode && !newType) {
    const declination = await ctx.reply(
      '⚠️ <b>Declined:</b> Specify updates.\n• <code>/move MED102</code>\n• <code>/move pq</code>\n• <code>/move doc</code>',
      { parse_mode: 'HTML' }
    );
    setTimeout(() => safeDelete(chatId, declination.message_id), 8000);
    return;
  }

  const cleanChatId = String(chatId).replace(/^-100/, '');
  const currentThreadId = ctx.message.message_thread_id;
  const jumpLink = currentThreadId && !isGeneralTab(ctx)
    ? `https://t.me/c/${cleanChatId}/${currentThreadId}/${replyTarget.message_id}`
    : `https://t.me/c/${cleanChatId}/${replyTarget.message_id}`;

  const updateFields = { updatedAt: new Date() };
  if (newCourseCode) updateFields.course = newCourseCode;
  if (newType) updateFields.type = newType;

  const db = await connectToDatabase();
  const result = await db.collection('resources').updateOne({ jumpLink }, { $set: updateFields });

  if (result.matchedCount === 0) {
    const declination = await ctx.reply('⚠️ <b>Declined:</b> This material is not indexed. Use <code>/save</code> first.', { parse_mode: 'HTML' });
    setTimeout(() => safeDelete(chatId, declination.message_id), 6000);
    return;
  }

  const changes = [];
  if (newCourseCode) changes.push(`Course: <b>${newCourseCode}</b>`);
  if (newType) changes.push(`Type: <b>${newType === 'pq' ? '📝 Past Question' : '📄 Document'}</b>`);

  const confirmation = await ctx.reply(`✅ <b>Updated:</b>\n${changes.join('\n')}`, { parse_mode: 'HTML' });
  setTimeout(() => safeDelete(chatId, confirmation.message_id), 5000);
});

// --- /remove Handler with Declination Alerts ---
bot.command(['remove', 'delete'], async (ctx) => {
  const chatId = ctx.chat.id;
  await safeDelete(chatId, ctx.message.message_id);

  const isAdmin = await isGroupAdmin(ctx, ctx.from.id);
  if (!isAdmin) return;

  const db = await connectToDatabase();
  const replyTarget = ctx.message.reply_to_message;
  const rawInput = ctx.message.text.trim().split(/\s+/).slice(1).join(' ');

  if (replyTarget) {
    const cleanChatId = String(chatId).replace(/^-100/, '');
    const currentThreadId = ctx.message.message_thread_id;
    const jumpLink = currentThreadId && !isGeneralTab(ctx)
      ? `https://t.me/c/${cleanChatId}/${currentThreadId}/${replyTarget.message_id}`
      : `https://t.me/c/${cleanChatId}/${replyTarget.message_id}`;

    const result = await db.collection('resources').deleteOne({ jumpLink });
    const notice = result.deletedCount > 0 
      ? await ctx.reply('🗑 Resource removed from the index.')
      : await ctx.reply('⚠️ <b>Declined:</b> Material not found in index.', { parse_mode: 'HTML' });
    setTimeout(() => safeDelete(chatId, notice.message_id), 5000);
    return;
  }

  const courseCode = extractCourseCode(rawInput);
  const searchTitle = rawInput.replace(/([a-zA-Z]{3})\s*[-_]?\s*([0-9]{3})/i, '').trim();

  if (!courseCode || !searchTitle) {
    const declination = await ctx.reply('⚠️ <b>Declined:</b> Reply with <code>/remove</code> or type: <code>/remove MED101 Title</code>', { parse_mode: 'HTML' });
    setTimeout(() => safeDelete(chatId, declination.message_id), 8000);
    return;
  }

  const result = await db.collection('resources').deleteOne({
    course: courseCode,
    title: { $regex: new RegExp(searchTitle, 'i') }
  });

  const notice = result.deletedCount > 0
    ? await ctx.reply(`🗑 Removed "<b>${escapeHtml(searchTitle)}</b>" from <b>${courseCode}</b>.`, { parse_mode: 'HTML' })
    : await ctx.reply(`⚠️ <b>Declined:</b> No material matching "${escapeHtml(searchTitle)}" under <b>${courseCode}</b>.`, { parse_mode: 'HTML' });
  setTimeout(() => safeDelete(chatId, notice.message_id), 5000);
});

// --- /course Handler ---
bot.command('course', async (ctx) => {
  const chatId = ctx.chat.id;
  const userMsgId = ctx.message.message_id;
  const requesterId = ctx.from.id;
  const currentThreadId = ctx.message.message_thread_id;
  const topicScopeKey = isGeneralTab(ctx) ? 'general' : String(currentThreadId);

  await safeDelete(chatId, userMsgId);

  const db = await connectToDatabase();
  await cleanupStaleMenus(db, chatId);

  const rawInput = ctx.message.text.trim().split(/\s+/).slice(1).join(' ');
  let courseCode = extractCourseCode(rawInput);

  if (!courseCode && !isGeneralTab(ctx)) {
    const topicEntry = await db.collection('topics').findOne({ chatId, threadId: currentThreadId });
    if (topicEntry) courseCode = topicEntry.courseCode;
  }

  if (!courseCode) {
    const warn = await ctx.reply('⚠️ Please provide a course code.\nExample: <code>/course MED101</code>', { parse_mode: 'HTML' });
    setTimeout(() => safeDelete(chatId, warn.message_id), 6000);
    return;
  }

  const resources = await db.collection('resources').find({ course: courseCode }).toArray();

  if (!resources.length) {
    const notFound = await ctx.reply(`No resources indexed for <b>${courseCode}</b> yet.`, { parse_mode: 'HTML' });
    setTimeout(() => safeDelete(chatId, notFound.message_id), 6000);
    return;
  }

  const activeMenus = db.collection('active_menus');
  const existingMenu = await activeMenus.findOne({ chatId, topicScopeKey });
  if (existingMenu?.messageId) {
    await safeDelete(chatId, existingMenu.messageId);
  }

  const buttons = resources.map(res => [
    Markup.button.url(`${res.type === 'pq' ? '📝' : '📄'} ${res.title}`, res.jumpLink)
  ]);

  buttons.push([Markup.button.callback('🗑 Close Menu', `dismiss_${requesterId}`)]);

  const menuMsg = await ctx.reply(
    `📚 <b>${courseCode} Resources</b>\nTap any item to jump directly to the post:`,
    {
      parse_mode: 'HTML',
      reply_markup: Markup.inlineKeyboard(buttons).reply_markup
    }
  );

  const expiresAt = new Date(Date.now() + MENU_TTL_MS);
  await activeMenus.updateOne(
    { chatId, topicScopeKey },
    { 
      $set: { 
        messageId: menuMsg.message_id, 
        expiresAt,
        updatedAt: new Date() 
      } 
    },
    { upsert: true }
  );
});

// Scoped Dismiss Callback
bot.action(/^dismiss_(\d+)$/, async (ctx) => {
  const allowedUserId = ctx.match[1];
  const clickerId = ctx.from.id;

  const isAdmin = await isGroupAdmin(ctx, clickerId);
  if (String(clickerId) !== String(allowedUserId) && !isAdmin) {
    return ctx.answerCbQuery('⚠️ Only the student who opened this menu or an admin can close it.', { show_alert: true });
  }

  await ctx.answerCbQuery('Menu closed');
  await safeDelete(ctx.chat.id, ctx.callbackQuery.message.message_id);

  const db = await connectToDatabase();
  await db.collection('active_menus').deleteOne({
    chatId: ctx.chat.id,
    messageId: ctx.callbackQuery.message.message_id
  });
});

// Serverless Webhook Handler & Auto-Configuration
module.exports = async (req, res) => {
  if (!webhookConfigured && process.env.VERCEL_URL) {
    const host = process.env.VERCEL_URL.startsWith('http')
      ? process.env.VERCEL_URL
      : `https://${process.env.VERCEL_URL}`;
    await bot.telegram.setWebhook(`${host}/api/webhook`);
    webhookConfigured = true;
  }

  if (req.method === 'POST') {
    try {
      await bot.handleUpdate(req.body, res);
      if (!res.writableEnded) res.status(200).send('OK');
    } catch (err) {
      console.error('Webhook execution failure:', err);
      res.status(500).send('Internal Error');
    }
  } else {
    res.status(200).send('UNN Medical Rehabilitation Telegram Gateway is active.');
  }
};