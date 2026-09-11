const { Telegraf, Markup } = require('telegraf');
const { MongoClient } = require('mongodb');

const bot = new Telegraf(process.env.BOT_TOKEN);
let cachedDb = null;
let webhookConfigured = false;

// Standard 30-minute menu lifetime for member menus
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

// Safe Message Deletion (Catches missing permissions or deleted messages gracefully)
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

// Lazy Timer: Purges expired banners, menus, and transient notices
async function cleanupStaleMenus(db, chatId) {
  try {
    const now = new Date();
    const expiredMenus = await db.collection('active_menus').find({
      chatId,
      expiresAt: { $ne: null, $lte: now }
    }).toArray();

    for (const menu of expiredMenus) {
      if (menu.messageId) {
        await safeDelete(chatId, menu.messageId);
      }
    }

    if (expiredMenus.length > 0) {
      await db.collection('active_menus').deleteMany({
        chatId,
        expiresAt: { $ne: null, $lte: now }
      });
    }
  } catch (err) {
    console.warn('Stale menu cleanup notice:', err.message);
  }
}

// Admin Check: Exempts admins from cooldowns and forced deletions
async function isGroupAdmin(ctx, userId) {
  if (String(userId) === String(process.env.SUPER_ADMIN_ID)) return true;
  try {
    const member = await ctx.telegram.getChatMember(ctx.chat.id, userId);
    return ['creator', 'administrator'].includes(member.status);
  } catch {
    return false;
  }
}

function isGeneralTab(ctx) {
  const threadId = ctx.message?.message_thread_id;
  return !threadId || threadId === 1;
}

// Course Code Normalizer: 2 to 4 letters followed by 3 digits
function extractCourseCode(text) {
  if (!text) return null;
  const match = text.match(/\b([a-zA-Z]{2,4})\s*[-_]?\s*([0-9]{3})\b/i);
  return match ? `${match[1].toUpperCase()}${match[2]}` : null;
}

// Strict Type Classifier: Prevents false positive substring matches
function detectMaterialType(rawTitle, caption = '') {
  const cleanedText = `${rawTitle} ${caption}`
    .replace(/\.(pdf|docx?|pptx?|epub|txt)/gi, ' ')
    .replace(/[_.\-]+/g, ' ')
    .toLowerCase();

  const isPQ = /\b(pq|pqs|past\s*questions?|pastquestions?|exams?|examination|test|tests|continuous\s*assessment|ca)\b/i.test(cleanedText);
  return isPQ ? 'pq' : 'doc';
}

// Duration Parser: Distinguishes hours, minutes, and days cleanly
function parseDuration(input) {
  if (!input) return null;
  const clean = input.trim().toLowerCase();
  if (['0', 'off', 'perm', 'permanent', 'never'].includes(clean)) return 0;

  const match = clean.match(/^(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/i);
  if (!match) return null;

  const val = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();

  if (/^(m|min|mins|minute|minutes)$/.test(unit)) return val * 60 * 1000;
  if (/^(h|hr|hrs|hour|hours)$/.test(unit)) return val * 60 * 60 * 1000;
  if (/^(d|day|days)$/.test(unit)) return val * 24 * 60 * 60 * 1000;
  return null;
}

function formatDuration(ms) {
  if (!ms || ms <= 0) return 'permanent';
  const hours = ms / (60 * 60 * 1000);
  if (hours >= 24) return `${Math.round(hours / 24)} day(s)`;
  if (hours >= 1) return `${Math.round(hours)} hr(s)`;
  return `${Math.round(ms / (60 * 1000))} min(s)`;
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Topic Auto-Index: On Forum Topic Created
bot.on('forum_topic_created', async (ctx) => {
  const topic = ctx.message.forum_topic_created;
  const courseCode = extractCourseCode(topic.name);

  if (courseCode) {
    const db = await connectToDatabase();
    await db.collection('topics').deleteMany({ chatId: ctx.chat.id, threadId: ctx.message.message_thread_id });
    await db.collection('topics').updateOne(
      { chatId: ctx.chat.id, threadId: ctx.message.message_thread_id },
      { 
        $set: { 
          courseCode, 
          topicName: topic.name, 
          updatedAt: new Date() 
        } 
      },
      { upsert: true }
    );
  }
});

// Topic Auto-Index: On Forum Topic Renamed
bot.on('forum_topic_edited', async (ctx) => {
  const edited = ctx.message.forum_topic_edited;
  if (!edited?.name) return;

  const courseCode = extractCourseCode(edited.name);
  if (courseCode) {
    const db = await connectToDatabase();
    await db.collection('topics').deleteMany({ chatId: ctx.chat.id, threadId: ctx.message.message_thread_id });
    await db.collection('topics').updateOne(
      { chatId: ctx.chat.id, threadId: ctx.message.message_thread_id },
      { 
        $set: { 
          courseCode, 
          topicName: edited.name, 
          updatedAt: new Date() 
        } 
      },
      { upsert: true }
    );
  }
});

// Manual Topic Linker: /setcourse CHEM108
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
    const warn = await ctx.reply('⚠️ Provide a valid course code. Example: <code>/setcourse CHEM108</code>', { parse_mode: 'HTML' });
    setTimeout(() => safeDelete(chatId, warn.message_id), 6000);
    return;
  }

  const db = await connectToDatabase();
  await db.collection('topics').deleteMany({ chatId, threadId });
  await db.collection('topics').updateOne(
    { chatId, threadId },
    { $set: { courseCode, updatedAt: new Date() } },
    { upsert: true }
  );

  const confirm = await ctx.reply(`✅ Topic successfully mapped to <b>${courseCode}</b>.`, { parse_mode: 'HTML' });
  setTimeout(() => safeDelete(chatId, confirm.message_id), 5000);
});

// --- Dynamic Bot Introduction (/hello) ---
bot.command('hello', async (ctx) => {
  const chatId = ctx.chat.id;
  const userMsgId = ctx.message.message_id;
  const userId = ctx.from.id;

  await safeDelete(chatId, userMsgId);
  const isAdmin = await isGroupAdmin(ctx, userId);

  const introText = 
`👋 <b>Greetings, Elite Physios!</b>

I am your official departmental academic assistant, built to keep our lecture slides, past questions, and study resources structured and instantly accessible right inside our forum topics.

• <b>Browse materials:</b> Type <code>/course</code> inside any course topic, or <code>/course &lt;CODE&gt;</code> anywhere.
• <b>Command list &amp; guide:</b> Tap my profile bio or check the chat menu for full instructions.`;

  const banner = await ctx.reply(introText, { parse_mode: 'HTML' });

  // Admins never trigger cooldowns or auto-deletion timers
  if (!isAdmin) {
    const THREE_HOURS_MS = 3 * 60 * 60 * 1000;
    const db = await connectToDatabase();

    await db.collection('active_menus').insertOne({
      chatId,
      messageId: banner.message_id,
      type: 'intro',
      expiresAt: new Date(Date.now() + THREE_HOURS_MS),
      createdAt: new Date()
    });

    setTimeout(async () => {
      const stillActive = await db.collection('active_menus').findOne({
        chatId,
        messageId: banner.message_id
      });
      if (stillActive && stillActive.expiresAt && stillActive.expiresAt <= new Date()) {
        await safeDelete(chatId, banner.message_id);
        await db.collection('active_menus').deleteOne({ chatId, messageId: banner.message_id });
      }
    }, THREE_HOURS_MS);
  }
});

// --- Showcase Motivation Command (/greet [time] [--keep]) ---
bot.command('greet', async (ctx) => {
  const chatId = ctx.chat.id;
  const userMsgId = ctx.message.message_id;
  const userId = ctx.from.id;

  const rawArgs = ctx.message.text.trim().split(/\s+/).slice(1);
  const isAdmin = await isGroupAdmin(ctx, userId);

  const shouldKeepCommand = isAdmin && rawArgs.some(arg => ['--keep', '-k', 'keep'].includes(arg.toLowerCase()));
  if (!shouldKeepCommand) {
    await safeDelete(chatId, userMsgId);
  }

  const timeArg = rawArgs.find(arg => !['--keep', '-k', 'keep'].includes(arg.toLowerCase()));
  let durationMs = 0;

  // Regular members default to 3 hours; admins default to permanent (0 ms) unless specified
  if (!isAdmin) {
    durationMs = 3 * 60 * 60 * 1000;
  } else if (timeArg) {
    const parsed = parseDuration(timeArg);
    if (parsed !== null) durationMs = parsed;
  }

  // West Africa Time (WAT / UTC+1)
  const watHour = (new Date().getUTCHours() + 1) % 24;
  let greeting = 'Good evening';
  let punchline = "Finish today strong, consolidate your reading, and lay down tomorrow's foundation tonight.";

  if (watHour >= 5 && watHour < 12) {
    greeting = 'Good morning';
    punchline = 'Step out with absolute clarity, dominate your lectures, and set the pace for excellence.';
  } else if (watHour >= 12 && watHour < 17) {
    greeting = 'Good afternoon';
    punchline = 'Maintain your focus and keep the momentum alive. True distinction is forged in relentless daily consistency.';
  } else if (watHour >= 22 || watHour < 5) {
    greeting = 'Late hours grind';
    punchline = 'The midnight oil always compounds into mastery. Lock in, stay sharp, and own the night.';
  }

  const welcomeText = 
`⚡ <b>${greeting}, Elite Physios! Win big today.</b>

${punchline} Excellence in Medical Rehabilitation isn't an accident—it's built lecture by lecture, slide by slide, and concept by concept. Show up with relentless standard and conquer every hurdle.

• <b>Access Departmental Vault:</b> Type <code>/course</code> inside any course topic or <code>/course &lt;CODE&gt;</code> anywhere.
• <b>Bot Commands:</b> Tap my profile bio or the chat menu button for the full documentation.

<i>📌 Pinned portal guide by admin</i>`;

  const banner = await ctx.reply(welcomeText, { parse_mode: 'HTML' });

  if (durationMs > 0) {
    const db = await connectToDatabase();
    await db.collection('active_menus').insertOne({
      chatId,
      messageId: banner.message_id,
      type: 'broadcast',
      expiresAt: new Date(Date.now() + durationMs),
      createdAt: new Date()
    });

    setTimeout(async () => {
      const stillActive = await db.collection('active_menus').findOne({
        chatId,
        messageId: banner.message_id
      });
      if (stillActive && stillActive.expiresAt && stillActive.expiresAt <= new Date()) {
        await safeDelete(chatId, banner.message_id);
        await db.collection('active_menus').deleteOne({ chatId, messageId: banner.message_id });
      }
    }, durationMs);
  }
});

// --- /keep Command (Admins set custom/permanent; Members add +10m) ---
bot.command('keep', async (ctx) => {
  const chatId = ctx.chat.id;
  const userMsgId = ctx.message.message_id;
  const userId = ctx.from.id;

  const isAdmin = await isGroupAdmin(ctx, userId);
  const rawText = ctx.message.text.trim();
  const args = rawText.split(/\s+/).slice(1);

  const shouldKeepCommand = isAdmin && args.some(arg => ['--keep', '-k'].includes(arg.toLowerCase()));
  if (!shouldKeepCommand) {
    await safeDelete(chatId, userMsgId);
  }

  const replyTarget = ctx.message.reply_to_message;
  if (!replyTarget) {
    const declination = await ctx.reply('⚠️ <b>Declined:</b> Reply directly with <code>/keep</code> to the message or menu you want to preserve.', { parse_mode: 'HTML' });
    setTimeout(() => safeDelete(chatId, declination.message_id), 6000);
    return;
  }

  const targetId = replyTarget.message_id;
  const db = await connectToDatabase();
  const existingRecord = await db.collection('active_menus').findOne({ chatId, messageId: targetId });

  let newExpiresAt = null;
  let statusText = '';

  if (isAdmin) {
    const timeArg = args.find(arg => !['--keep', '-k'].includes(arg.toLowerCase()));
    if (timeArg) {
      const parsedMs = parseDuration(timeArg);
      if (parsedMs === null) {
        const warn = await ctx.reply('⚠️ Invalid format. Use e.g. <code>/keep 30m</code>, <code>/keep 2hrs</code>, or <code>/keep perm</code>.', { parse_mode: 'HTML' });
        setTimeout(() => safeDelete(chatId, warn.message_id), 6000);
        return;
      }
      if (parsedMs === 0) {
        newExpiresAt = null;
        statusText = 'Permanent';
      } else {
        newExpiresAt = new Date(Date.now() + parsedMs);
        statusText = `Extended by Admin (${formatDuration(parsedMs)})`;
      }
    } else {
      newExpiresAt = null;
      statusText = 'Permanent';
    }
  } else {
    // Member execution: extend current expiration by 10 minutes
    const TEN_MINS_MS = 10 * 60 * 1000;
    const currentExpiry = existingRecord?.expiresAt ? new Date(existingRecord.expiresAt).getTime() : Date.now();
    const baseTime = Math.max(currentExpiry, Date.now());
    newExpiresAt = new Date(baseTime + TEN_MINS_MS);
    statusText = '+10 mins added';
  }

  // Update Database Record
  if (newExpiresAt === null) {
    await db.collection('active_menus').deleteMany({ chatId, messageId: targetId });
  } else {
    await db.collection('active_menus').updateOne(
      { chatId, messageId: targetId },
      { $set: { expiresAt: newExpiresAt, updatedAt: new Date() } },
      { upsert: true }
    );
  }

  // Cleanly Update Message Footer
  try {
    let originalText = replyTarget.text || replyTarget.caption || '';
    originalText = originalText.replace(/\n\n<i>(Self-destructs.*?|📌 Pinned.*?|📌 Kept.*?|⏳ Expires in.*?)<\/i>/gis, '');

    const footer = newExpiresAt === null
      ? `\n\n<i>📌 Pinned by Admin • Permanent</i>`
      : `\n\n<i>📌 Kept • ${statusText} (Expires: ${newExpiresAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})</i>`;

    await ctx.telegram.editMessageText(
      chatId,
      targetId,
      undefined,
      originalText + footer,
      {
        parse_mode: 'HTML',
        reply_markup: replyTarget.reply_markup
      }
    );

    const alert = await ctx.reply(`✅ <b>Keep applied:</b> ${statusText}.`, { parse_mode: 'HTML' });
    setTimeout(() => safeDelete(chatId, alert.message_id), 4000);
  } catch {
    const alert = await ctx.reply(`✅ <b>Keep applied:</b> ${statusText}.`, { parse_mode: 'HTML' });
    setTimeout(() => safeDelete(chatId, alert.message_id), 4000);
  }
});

// --- /save Handler ---
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

  if (!courseCode && !isGeneralTab(ctx)) {
    const topicEntry = await db.collection('topics').findOne({ chatId, threadId: currentThreadId });
    if (topicEntry) courseCode = topicEntry.courseCode;
  }

  if (!courseCode) {
    const declination = await ctx.reply(
      '⚠️ <b>Declined:</b> Specify the course code or topic name.\nExample: <code>/save CHEM108</code> or reply inside that course\'s topic.',
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

// --- /move Handler ---
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
      '⚠️ <b>Declined:</b> Specify updates.\n• <code>/move CHEM108</code>\n• <code>/move pq</code>\n• <code>/move doc</code>',
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

// --- /remove Handler ---
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
  const searchTitle = rawInput.replace(/\b([a-zA-Z]{2,4})\s*[-_]?\s*([0-9]{3})\b/i, '').trim();

  if (!courseCode || !searchTitle) {
    const declination = await ctx.reply('⚠️ <b>Declined:</b> Reply with <code>/remove</code> or type: <code>/remove CHEM108 Title</code>', { parse_mode: 'HTML' });
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

// --- /course Query Handler with Explicit Expiration & Admin Exemption ---
bot.command('course', async (ctx) => {
  const chatId = ctx.chat.id;
  const userMsgId = ctx.message.message_id;
  const requesterId = ctx.from.id;
  const currentThreadId = ctx.message.message_thread_id;
  const topicScopeKey = isGeneralTab(ctx) ? 'general' : String(currentThreadId);

  await safeDelete(chatId, userMsgId);

  // Check admin privileges: Admins do NOT trigger auto-cleanup/cooldown
  const isAdmin = await isGroupAdmin(ctx, requesterId);

  const db = await connectToDatabase();
  await cleanupStaleMenus(db, chatId);

  const rawInput = ctx.message.text.trim().split(/\s+/).slice(1).join(' ');
  let courseCode = extractCourseCode(rawInput);

  if (!courseCode && !isGeneralTab(ctx)) {
    const topicEntry = await db.collection('topics').findOne({ chatId, threadId: currentThreadId });
    if (topicEntry) courseCode = topicEntry.courseCode;
  }

  if (!courseCode) {
    const warn = await ctx.reply('⚠️ Please provide a course code.\nExample: <code>/course CHEM108</code>', { parse_mode: 'HTML' });
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

  // Expiration footer logic: Permanent for admins, 30m countdown for students
  const expiryFooter = isAdmin 
    ? `\n\n<i>📌 Pinned Menu by Admin • Permanent</i>`
    : `\n\n<i>⏳ Expires in 30m • Reply /keep to extend</i>`;

  const menuMsg = await ctx.reply(
    `📚 <b>${courseCode} Resources</b>\nTap any item to jump directly to the post:${expiryFooter}`,
    {
      parse_mode: 'HTML',
      reply_markup: Markup.inlineKeyboard(buttons).reply_markup
    }
  );

  // Admin menus stay indefinitely; student menus expire in 30 minutes
  const expiresAt = isAdmin ? null : new Date(Date.now() + MENU_TTL_MS);

  await activeMenus.updateOne(
    { chatId, topicScopeKey },
    { 
      $set: { 
        messageId: menuMsg.message_id, 
        type: 'course_menu',
        expiresAt,
        updatedAt: new Date() 
      } 
    },
    { upsert: true }
  );

  // Fallback in-memory timeout for warm instances (only for non-admin invocations)
  if (!isAdmin) {
    setTimeout(async () => {
      const currentRecord = await activeMenus.findOne({ chatId, messageId: menuMsg.message_id });
      if (currentRecord && currentRecord.expiresAt && currentRecord.expiresAt <= new Date()) {
        await safeDelete(chatId, menuMsg.message_id);
        await activeMenus.deleteOne({ chatId, messageId: menuMsg.message_id });
      }
    }, MENU_TTL_MS);
  }
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
