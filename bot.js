require("dotenv").config();
const { Telegraf } = require("telegraf");
const axios = require("axios");
const cron = require("node-cron");
const fs = require("fs");
const path = require("path");

const BOT_TOKEN = process.env.BOT_TOKEN;
const HEMIS_TOKEN = process.env.HEMIS_TOKEN;
const HEMIS_BASE = process.env.HEMIS_BASE || "https://student.sies.uz/rest";
const EMPLOYEE_TYPES = (process.env.EMPLOYEE_TYPES || "staff")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const TZ = process.env.TZ || "Asia/Tashkent";
const CRON_TIME = process.env.CRON_TIME || "0 9 * * *";
const TYPE_LIST_PAGE_SIZE = Math.max(
  5,
  Math.min(25, Number.parseInt(process.env.TYPE_LIST_PAGE_SIZE || "15", 10) || 15)
);

const ADMIN_IDS = (process.env.ADMIN_IDS || "")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);

const EMPLOYEE_TYPE_ALIASES = {
  staff: "staff",
  staffs: "staff",
  teacher: "teacher",
  teachers: "teacher",
  employee: "employee",
  employees: "employee",
};

if (!BOT_TOKEN || !HEMIS_TOKEN) {
  console.error("❌ BOT_TOKEN yoki HEMIS_TOKEN yo‘q. .env ni tekshiring.");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

const STATE_FILE = path.join(__dirname, "state.json");
const CACHE_FILE = path.join(__dirname, "employees_cache.json");
const CUSTOM_COMMANDS_FILE = path.join(__dirname, "custom_commands.json");
const CUSTOM_COMMAND_NAME_RE = /^[a-z0-9_]{1,32}$/;
const RESERVED_COMMANDS = new Set([
  "start",
  "employees",
  "list",
  "teachers",
  "staffs",
  "employees_all",
  "search",
  "sync",
  "types",
  "setchat",
  "status",
  "run",
  "cmd_add",
  "cmd_del",
  "cmd_list",
  "cmd_show",
  "cmd_help",
  "cmd_off",
  "cmd_on",
  "cmd_disabled",
]);

const LOCKED_COMMANDS = new Set(["cmd_add", "cmd_del", "cmd_list", "cmd_show", "cmd_help", "cmd_off", "cmd_on", "cmd_disabled"]);

function loadJsonSafe(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return fallback;
  }
}
function saveJsonSafe(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf-8");
}

let state = loadJsonSafe(STATE_FILE, {
  targetChatId: process.env.TARGET_CHAT_ID || "",
  lastSentDate: "",
});

function saveState() {
  saveJsonSafe(STATE_FILE, state);
}

function loadCustomCommands() {
  const payload = loadJsonSafe(CUSTOM_COMMANDS_FILE, { updatedAt: 0, commands: {}, disabledCommands: {} });
  if (!payload || typeof payload !== "object") {
    return { updatedAt: 0, commands: {}, disabledCommands: {} };
  }
  if (!payload.commands || typeof payload.commands !== "object" || Array.isArray(payload.commands)) {
    payload.commands = {};
  }
  if (!payload.disabledCommands || typeof payload.disabledCommands !== "object" || Array.isArray(payload.disabledCommands)) {
    payload.disabledCommands = {};
  }
  return payload;
}

let customCommandsStore = loadCustomCommands();

function saveCustomCommands() {
  customCommandsStore.updatedAt = Date.now();
  saveJsonSafe(CUSTOM_COMMANDS_FILE, customCommandsStore);
}

function normalizeCommandName(raw) {
  const token = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/^\/+/, "");
  return token.split("@")[0];
}

function getCommandTokenFromText(text) {
  const first = String(text || "")
    .trim()
    .split(/\s+/)[0];
  if (!first || !first.startsWith("/")) return "";
  return normalizeCommandName(first);
}

function getCommandTail(text) {
  return String(text || "")
    .trim()
    .replace(/^\/\S+\s*/i, "");
}

function parseCmdAddPayload(text) {
  const tail = getCommandTail(text);
  if (!tail) return { nameRaw: "", replyText: "" };

  if (tail.includes("|")) {
    const [nameRaw, ...rest] = tail.split("|");
    return { nameRaw: nameRaw.trim(), replyText: rest.join("|").trim() };
  }

  const [nameRaw, ...rest] = tail.split(/\s+/);
  return { nameRaw: String(nameRaw || "").trim(), replyText: rest.join(" ").trim() };
}

function listCustomCommandNames() {
  return Object.keys(customCommandsStore.commands || {}).sort();
}

function getCustomCommand(name) {
  return customCommandsStore.commands?.[name] || null;
}

function isCommandDisabled(name) {
  return Boolean(customCommandsStore.disabledCommands?.[name]);
}

function listDisabledCommands() {
  return Object.keys(customCommandsStore.disabledCommands || {}).sort();
}

function renderCustomCommandReply(template) {
  return String(template || "")
    .replace(/\{HEMIS_BASE\}/g, HEMIS_BASE)
    .replace(/\{EMPLOYEE_TYPES\}/g, EMPLOYEE_TYPES.join(", "))
    .replace(/\{TZ\}/g, TZ);
}

function isAdmin(ctx) {
  const id = String(ctx.from?.id || "");
  return ADMIN_IDS.length === 0 ? true : ADMIN_IDS.includes(id);
}

function normalizeText(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[_\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function resolveEmployeeType(raw) {
  const t = normalizeText(raw).replace(/\s+/g, "");
  if (!t) return "";
  if (EMPLOYEE_TYPE_ALIASES[t]) return EMPLOYEE_TYPE_ALIASES[t];
  return EMPLOYEE_TYPES.includes(t) ? t : "";
}

function parsePositiveInt(raw, fallback = 1) {
  const n = Number.parseInt(String(raw || ""), 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function pick(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] != null && obj[k] !== "") return obj[k];
  }
  return "";
}

function toTextOrName(v) {
  if (v == null) return "";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
    return String(v).trim();
  }
  if (typeof v === "object") {
    return pick(v, ["name", "title", "full_name", "short_name"]);
  }
  return "";
}

function employeeKey(e) {
  // dublikatlarni yo‘qotish uchun
  return (
    pick(e, ["id", "employee_id", "uuid"]) ||
    pick(e, ["login", "username", "user_login"]) ||
    JSON.stringify(e).slice(0, 80)
  );
}

// obyekt ichidagi hamma matn/sonlarni yig‘ib qidiramiz
function employeeToSearchText(e) {
  const parts = [];
  const walk = (v) => {
    if (v == null) return;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      parts.push(String(v));
      return;
    }
    if (Array.isArray(v)) return v.forEach(walk);
    if (typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(e);
  return normalizeText(parts.join(" "));
}

function formatEmployeeShort(e) {
  // turli ehtimoliy fieldlar
  const fio =
    pick(e, ["full_name", "fio"]) ||
    [pick(e, ["last_name", "surname", "family_name"]), pick(e, ["first_name", "name", "given_name"]), pick(e, ["middle_name", "patronymic"])]
      .filter(Boolean)
      .join(" ")
      .trim();

  const login = pick(e, ["login", "username", "user_login", "employee_login"]);
  const pos = toTextOrName(pick(e, ["position", "job_title", "staff_position", "post", "staffPosition"]));
  const dept = toTextOrName(
    pick(e, ["department", "department_name", "department_title", "faculty", "faculty_name"])
  );
  const type = toTextOrName(pick(e, ["type", "employee_type", "employeeType"])) || "";

  return `${fio || "Noma'lum"}${login ? ` (${login})` : ""}${pos ? ` — ${pos}` : ""}${dept ? ` | ${dept}` : ""}${type ? ` | type=${type}` : ""}`;
}

function getEmployeesByTypeFromCache(cache, type) {
  if (Array.isArray(cache?.byType?.[type])) return cache.byType[type];
  return (cache?.items || []).filter((e) => resolveEmployeeType(e?.type) === type);
}

function buildTypeListUsage() {
  const types = EMPLOYEE_TYPES.join(", ");
  return (
    `Foydalanish:\n` +
    `/list <type> [page]\n` +
    `Masalan: /list teacher 1\n` +
    `Type: ${types}`
  );
}

function buildCustomCommandsUsage() {
  return (
    "Custom command boshqaruvi (admin):\n" +
    "/cmd_add <nom> | <javob matni>\n" +
    "/cmd_del <nom>\n" +
    "/cmd_show <nom>\n" +
    "/cmd_list\n" +
    "/cmd_off <nom>  (vaqtincha o'chirish)\n" +
    "/cmd_on <nom>   (qayta yoqish)\n" +
    "/cmd_disabled\n\n" +
    "Qoidalar:\n" +
    "- nom: faqat a-z, 0-9, _ (1-32)\n" +
    "- reserved buyruq nomlarini ishlatib bo'lmaydi\n" +
    "- namuna: /cmd_add teacher_api | " +
    `${HEMIS_BASE}/v1/data/employee-list?type=teacher&page=1&limit=200&l=uz-UZ\n` +
    "- placeholder: {HEMIS_BASE}, {EMPLOYEE_TYPES}, {TZ}"
  );
}

function makeTypeListText(type, people, page, totalApiCount) {
  if (!people.length) return `${type} bo'yicha hodim topilmadi.`;

  const pageCount = Math.max(1, Math.ceil(people.length / TYPE_LIST_PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), pageCount);
  const start = (safePage - 1) * TYPE_LIST_PAGE_SIZE;
  const chunk = people.slice(start, start + TYPE_LIST_PAGE_SIZE);
  const lines = chunk.map((e, i) => `${start + i + 1}) ${formatEmployeeShort(e)}`).join("\n");

  const shownFrom = start + 1;
  const shownTo = start + chunk.length;
  const nextPage = safePage < pageCount ? safePage + 1 : pageCount;

  const countLine =
    totalApiCount != null && Number(totalApiCount) !== people.length
      ? `Ko'rsatildi: ${shownFrom}-${shownTo}/${people.length} | API count=${totalApiCount}`
      : `Ko'rsatildi: ${shownFrom}-${shownTo}/${people.length}`;

  return (
    `Ro'yxat: ${type} (sahifa ${safePage}/${pageCount})\n\n` +
    `${lines}\n\n` +
    `${countLine}\n` +
    `Keyingi sahifa: /list ${type} ${nextPage}`
  );
}

// HEMIS timestamp: seconds yoki milliseconds bo‘lishi mumkin
function parseHemTimestamp(ts) {
  if (ts == null) return null;
  const n = Number(ts);
  if (!Number.isFinite(n)) return null;
  const ms = n < 1e12 ? n * 1000 : n;
  const d = new Date(ms);
  return isNaN(d.getTime()) ? null : d;
}

function formatDateTz(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  return `${y}-${m}-${d}`;
}

function monthDayTz(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  return `${m}-${d}`;
}

function getBirthField(e) {
  // tug‘ilgan sana maydoni turlicha bo‘lishi mumkin
  return pick(e, [
    "birth_date",
    "birthDate",
    "birthday",
    "birth_day",
    "date_of_birth",
    "dob",
    "birthdate",
  ]);
}

/* =========================
   HEMIS API
========================= */

async function hemisGetEmployeePage(type, page, limit) {
  const url =
    `${HEMIS_BASE}/v1/data/employee-list` +
    `?type=${encodeURIComponent(type)}` +
    `&page=${page}&limit=${limit}&l=uz-UZ`;

  const res = await axios.get(url, {
    headers: { Authorization: `Bearer ${HEMIS_TOKEN}` },
    timeout: 25000,
  });

  const payload = res.data;
  const items = payload?.data?.items || [];
  const pagination = payload?.data?.pagination || null;

  return { items, pagination, raw: payload };
}

async function hemisGetAllEmployeesByTypes(types) {
  const limit = 200;
  const merged = [];
  const seen = new Set();
  const counts = {};
  const byType = {};

  for (const type of types) {
    let page = 1;
    let totalForType = 0;
    const listForType = [];
    const seenInType = new Set();

    while (true) {
      const { items, pagination, raw } = await hemisGetEmployeePage(type, page, limit);
      if (!Array.isArray(items)) {
        console.log("⚠️ Unexpected format for type:", type, raw);
        break;
      }

      for (const e of items) {
        const item = e && typeof e === "object" ? { ...e, type } : e;
        const k = employeeKey(item);

        if (!seenInType.has(k)) {
          seenInType.add(k);
          listForType.push(item);
        }

        if (!seen.has(k)) {
          seen.add(k);
          merged.push(item);
        }

        totalForType += 1;
      }

      const pageCount = pagination?.pageCount;
      if (!pageCount || page >= pageCount) break;
      page += 1;
    }

    counts[type] = totalForType;
    byType[type] = listForType;
  }

  return { merged, counts, byType };
}

/* =========================
   CACHE
========================= */

function loadCache() {
  const cache = loadJsonSafe(CACHE_FILE, {
    updatedAt: 0,
    types: [],
    counts: {},
    byType: {},
    items: [],
  });

  if (!cache.byType || typeof cache.byType !== "object") {
    cache.byType = {};
  }
  return cache;
}

function saveCache(cache) {
  saveJsonSafe(CACHE_FILE, cache);
}

async function syncEmployeesCache(force = false) {
  const cache = loadCache();
  const now = Date.now();

  // 6 soatda bir yangilash (force bo‘lmasa)
  const SIX_HOURS = 6 * 60 * 60 * 1000;
  const hasTypeLists = EMPLOYEE_TYPES.every((type) => Array.isArray(cache.byType?.[type]));
  if (!force && cache.updatedAt && now - cache.updatedAt < SIX_HOURS && cache.items?.length && hasTypeLists) {
    return cache;
  }

  const { merged, counts, byType } = await hemisGetAllEmployeesByTypes(EMPLOYEE_TYPES);
  const newCache = {
    updatedAt: now,
    types: EMPLOYEE_TYPES,
    counts,
    byType,
    items: merged,
  };
  saveCache(newCache);
  return newCache;
}

/* =========================
   BIRTHDAY JOB
========================= */

async function sendBirthdayGreetings() {
  if (!state.targetChatId) {
    console.log("⚠️ TARGET_CHAT_ID yo‘q. /setchat bilan o‘rnating.");
    return;
  }

  const now = new Date();
  const today = formatDateTz(now, TZ);

  if (state.lastSentDate === today) {
    console.log(`✅ Bugun (${today}) allaqachon yuborilgan.`);
    return;
  }

  const cache = await syncEmployeesCache(false);
  const employees = cache.items || [];

  const todayMD = monthDayTz(now, TZ);

  const birthdayPeople = employees.filter((e) => {
    const b = getBirthField(e);
    const d = parseHemTimestamp(b);
    if (!d) return false;
    return monthDayTz(d, TZ) === todayMD;
  });

  // Agar birth field umuman kelmayotgan bo‘lsa, shuni ham aytib qo‘yamiz
  const anyBirth = employees.some((e) => parseHemTimestamp(getBirthField(e)));

  if (!anyBirth) {
    await bot.telegram.sendMessage(
      state.targetChatId,
      `⚠️ API hodimlarda tug‘ilgan sana (birth_date) maydonini qaytarmayapti.\nShu sabab tabrik avtomat ishlamaydi.\n(${today})`
    );
    state.lastSentDate = today;
    saveState();
    return;
  }

  if (birthdayPeople.length === 0) {
    await bot.telegram.sendMessage(state.targetChatId, `Bugun tug‘ilgan hodim topilmadi. 📅 (${today})`);
    state.lastSentDate = today;
    saveState();
    return;
  }

  const lines = birthdayPeople.slice(0, 30).map((e) => `🎉 ${formatEmployeeShort(e)} — Tug‘ilgan kun muborak!`);

  const text =
    `🎂 Bugungi tug‘ilgan kunlar (${today}):\n\n` +
    lines.join("\n") +
    (birthdayPeople.length > 30 ? `\n\n(+${birthdayPeople.length - 30} ta yana bor)` : "");

  await bot.telegram.sendMessage(state.targetChatId, text);

  state.lastSentDate = today;
  saveState();
}

async function replyTypeList(ctx, forcedType = "") {
  const args = String(ctx.message?.text || "")
    .trim()
    .split(/\s+/)
    .slice(1);

  const rawType = forcedType || args[0] || "";
  const rawPage = forcedType ? args[0] : args[1];

  const type = resolveEmployeeType(rawType);
  if (!type) return ctx.reply(buildTypeListUsage());

  const page = parsePositiveInt(rawPage, 1);
  const cache = await syncEmployeesCache(false);
  const people = getEmployeesByTypeFromCache(cache, type);
  const text = makeTypeListText(type, people, page, cache.counts?.[type]);
  return ctx.reply(text);
}

/* =========================
   COMMANDS
========================= */

bot.use((ctx, next) => {
  const command = getCommandTokenFromText(ctx.message?.text || "");
  if (!command) return next();
  if (LOCKED_COMMANDS.has(command)) return next();
  if (!isCommandDisabled(command)) return next();
  return ctx.reply(`/${command} vaqtincha o'chirilgan. Yoqish: /cmd_on ${command}`);
});

bot.start((ctx) => {
  ctx.reply(
    "Salom!\n\n" +
      "✅ /employees — 10 ta hodim (test)\n" +
      "✅ /list <type> [page] — type bo‘yicha ro‘yxat\n" +
      "✅ /teachers [page] — teacher ro‘yxati\n" +
      "✅ /search <ism/login> — hodim qidirish\n" +
      "✅ /sync — cache yangilash (admin)\n" +
      "✅ /types — qaysi type nechta kelayapti (admin)\n" +
      "✅ /setchat — tabrik yuboriladigan chatni saqlash (admin)\n" +
      "✅ /run — tabrikni qo‘lda ishga tushirish (admin)\n" +
      "✅ /status — holat (admin)\n" +
      "✅ /cmd_add — bot ichida yangi command qo‘shish (admin)\n" +
      "✅ /cmd_del — custom command o‘chirish (admin)\n" +
      "✅ /cmd_list — custom commandlar ro‘yxati (admin)\n" +
      "✅ /cmd_show — custom command matnini ko‘rish (admin)\n" +
      "✅ /cmd_off — buyruqni vaqtincha o‘chirish (admin)\n" +
      "✅ /cmd_on — buyruqni qayta yoqish (admin)\n" +
      "✅ /cmd_disabled — o‘chirilgan buyruqlar (admin)\n" +
      "✅ /cmd_help — custom command yordam (admin)\n"
  );
});

bot.command("employees", async (ctx) => {
  try {
    // cachedan o‘qib tez ko‘rsatamiz
    const cache = await syncEmployeesCache(false);
    const items = cache.items || [];
    const sample = items.slice(0, 10);

    if (!sample.length) return ctx.reply("Hodimlar topilmadi.");

    const lines = sample.map((e, i) => `${i + 1}) ${formatEmployeeShort(e)}`).join("\n");
    ctx.reply(
      `📋 Hodimlar (namuna):\n\n${lines}\n\n` +
        `📌 Cache: ${items.length} ta | Types: ${EMPLOYEE_TYPES.join(", ")}`
    );
  } catch (err) {
    const status = err?.response?.status;
    const data = err?.response?.data;
    console.error("Employees Error:", status, data || err.message);
    ctx.reply("❌ Xatolik. Konsol logini tekshiring.");
  }
});

bot.command("list", async (ctx) => {
  try {
    await replyTypeList(ctx);
  } catch (err) {
    const status = err?.response?.status;
    const data = err?.response?.data;
    console.error("List Error:", status, data || err.message);
    ctx.reply("❌ Type ro'yxatini olishda xatolik. Konsol logini tekshiring.");
  }
});

bot.command("teachers", async (ctx) => {
  try {
    await replyTypeList(ctx, "teacher");
  } catch (err) {
    const status = err?.response?.status;
    const data = err?.response?.data;
    console.error("Teachers Error:", status, data || err.message);
    ctx.reply("❌ Teacher ro'yxatini olishda xatolik. Konsol logini tekshiring.");
  }
});

bot.command("staffs", async (ctx) => {
  try {
    await replyTypeList(ctx, "staff");
  } catch (err) {
    const status = err?.response?.status;
    const data = err?.response?.data;
    console.error("Staffs Error:", status, data || err.message);
    ctx.reply("❌ Staff ro'yxatini olishda xatolik. Konsol logini tekshiring.");
  }
});

bot.command("employees_all", async (ctx) => {
  try {
    await replyTypeList(ctx, "employee");
  } catch (err) {
    const status = err?.response?.status;
    const data = err?.response?.data;
    console.error("EmployeesAll Error:", status, data || err.message);
    ctx.reply("❌ Employee ro'yxatini olishda xatolik. Konsol logini tekshiring.");
  }
});

bot.command("cmd_help", (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("❌ Ruxsat yo'q (admin emas).");
  ctx.reply(buildCustomCommandsUsage());
});

bot.command("cmd_add", (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("❌ Ruxsat yo'q (admin emas).");

  const { nameRaw, replyText } = parseCmdAddPayload(ctx.message?.text || "");
  const name = normalizeCommandName(nameRaw);
  if (!name || !CUSTOM_COMMAND_NAME_RE.test(name)) {
    return ctx.reply("❌ Command nomi noto'g'ri.\n" + buildCustomCommandsUsage());
  }
  if (RESERVED_COMMANDS.has(name)) {
    return ctx.reply(`❌ /${name} reserved. Boshqa nom tanlang.`);
  }
  if (!replyText) {
    return ctx.reply("❌ Javob matni bo'sh.\n" + buildCustomCommandsUsage());
  }

  const existed = Boolean(getCustomCommand(name));
  customCommandsStore.commands[name] = {
    replyText,
    updatedAt: Date.now(),
    updatedBy: String(ctx.from?.id || ""),
  };
  delete customCommandsStore.disabledCommands[name];
  saveCustomCommands();

  return ctx.reply(existed ? `✅ Yangilandi: /${name}` : `✅ Qo'shildi: /${name}`);
});

bot.command("cmd_del", (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("❌ Ruxsat yo'q (admin emas).");

  const tail = getCommandTail(ctx.message?.text || "");
  const name = normalizeCommandName(tail.split(/\s+/)[0] || "");
  if (!name) return ctx.reply("❌ Foydalanish: /cmd_del <nom>");
  if (!getCustomCommand(name)) return ctx.reply(`❌ /${name} topilmadi.`);

  delete customCommandsStore.commands[name];
  delete customCommandsStore.disabledCommands[name];
  saveCustomCommands();
  return ctx.reply(`✅ O'chirildi: /${name}`);
});

bot.command("cmd_show", (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("❌ Ruxsat yo'q (admin emas).");

  const tail = getCommandTail(ctx.message?.text || "");
  const name = normalizeCommandName(tail.split(/\s+/)[0] || "");
  if (!name) return ctx.reply("❌ Foydalanish: /cmd_show <nom>");

  const item = getCustomCommand(name);
  if (!item) return ctx.reply(`❌ /${name} topilmadi.`);

  return ctx.reply(`/` + name + " =>\n" + String(item.replyText || ""));
});

bot.command("cmd_list", (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("❌ Ruxsat yo'q (admin emas).");

  const names = listCustomCommandNames();
  if (!names.length) return ctx.reply("Custom command yo'q.");

  const lines = names.map((name, i) => {
    const txt = String(getCustomCommand(name)?.replyText || "").replace(/\s+/g, " ").trim();
    const preview = txt.length > 55 ? `${txt.slice(0, 55)}...` : txt;
    const off = isCommandDisabled(name) ? " [off]" : "";
    return `${i + 1}) /${name}${off} -> ${preview}`;
  });

  return ctx.reply("Custom commandlar:\n\n" + lines.join("\n"));
});

bot.command("cmd_off", (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("❌ Ruxsat yo'q (admin emas).");

  const tail = getCommandTail(ctx.message?.text || "");
  const name = normalizeCommandName(tail.split(/\s+/)[0] || "");
  if (!name || !CUSTOM_COMMAND_NAME_RE.test(name)) return ctx.reply("❌ Foydalanish: /cmd_off <nom>");
  if (LOCKED_COMMANDS.has(name)) return ctx.reply(`❌ /${name} ni o'chirib bo'lmaydi.`);

  const exists = RESERVED_COMMANDS.has(name) || Boolean(getCustomCommand(name));
  if (!exists) return ctx.reply(`❌ /${name} topilmadi.`);
  if (isCommandDisabled(name)) return ctx.reply(`ℹ️ /${name} allaqachon o'chirilgan.`);

  customCommandsStore.disabledCommands[name] = true;
  saveCustomCommands();
  return ctx.reply(`✅ Vaqtincha o'chirildi: /${name}`);
});

bot.command("cmd_on", (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("❌ Ruxsat yo'q (admin emas).");

  const tail = getCommandTail(ctx.message?.text || "");
  const name = normalizeCommandName(tail.split(/\s+/)[0] || "");
  if (!name || !CUSTOM_COMMAND_NAME_RE.test(name)) return ctx.reply("❌ Foydalanish: /cmd_on <nom>");

  if (!isCommandDisabled(name)) return ctx.reply(`ℹ️ /${name} hozir ham yoqilgan.`);
  delete customCommandsStore.disabledCommands[name];
  saveCustomCommands();
  return ctx.reply(`✅ Qayta yoqildi: /${name}`);
});

bot.command("cmd_disabled", (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("❌ Ruxsat yo'q (admin emas).");

  const disabled = listDisabledCommands();
  if (!disabled.length) return ctx.reply("O'chirilgan buyruqlar yo'q.");

  const lines = disabled.map((name, i) => `${i + 1}) /${name}`);
  return ctx.reply("O'chirilgan buyruqlar:\n\n" + lines.join("\n"));
});

bot.command("search", async (ctx) => {
  try {
    const queryRaw = ctx.message.text.split(" ").slice(1).join(" ");
    const q = normalizeText(queryRaw);
    if (!q) return ctx.reply("Masalan: /search ali\nMasalan: /search avalov\nMasalan: /search azizbek");

    const cache = await syncEmployeesCache(false);
    const employees = cache.items || [];

    const found = [];
    for (const e of employees) {
      const hay = employeeToSearchText(e);
      if (hay.includes(q)) found.push(e);
      if (found.length >= 15) break;
    }

    if (!found.length) {
      return ctx.reply(
        "Topilmadi ❌\n\n" +
          "Eslatma: Agar siz talaba bo‘lsangiz, bu employee-listda chiqmaydi.\n" +
          "Agar siz hodim bo‘lsangiz ham chiqmasa, ehtimol type boshqa yoki inactive.\n" +
          "Admin bo‘lsangiz: /types ni ko‘ring."
      );
    }

    const lines = found.map((e, i) => `${i + 1}) ${formatEmployeeShort(e)}`).join("\n");
    ctx.reply("✅ Topildi:\n\n" + lines);
  } catch (err) {
    const status = err?.response?.status;
    const data = err?.response?.data;
    console.error("Search Error:", status, data || err.message);
    ctx.reply("❌ Qidiruvda xatolik. Konsol logini tekshiring.");
  }
});

bot.command("sync", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("❌ Ruxsat yo‘q (admin emas).");
  ctx.reply("⏳ Sync qilinyapti...");
  try {
    const cache = await syncEmployeesCache(true);
    ctx.reply(
      `✅ Sync tayyor.\n` +
        `Hodimlar: ${cache.items.length}\n` +
        `Types: ${cache.types.join(", ")}\n` +
        `Counts: ${Object.entries(cache.counts).map(([k, v]) => `${k}=${v}`).join(", ")}`
    );
  } catch (e) {
    console.error(e);
    ctx.reply("❌ Sync xatolik. Konsolni tekshiring.");
  }
});

bot.command("types", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("❌ Ruxsat yo‘q (admin emas).");
  try {
    const cache = await syncEmployeesCache(false);
    const counts = cache.counts || {};
    const cacheByType = EMPLOYEE_TYPES.map((t) => `${t}=${getEmployeesByTypeFromCache(cache, t).length}`).join(", ");
    ctx.reply(
      `EMPLOYEE_TYPES = ${EMPLOYEE_TYPES.join(", ")}\n` +
        `Counts: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(", ")}\n` +
        `Cache byType: ${cacheByType}\n` +
        `Cache total: ${cache.items.length}\n` +
        `Ro'yxat: /list teacher 1`
    );
  } catch (e) {
    console.error(e);
    ctx.reply("❌ Xatolik.");
  }
});

bot.command("setchat", (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("❌ Ruxsat yo‘q (admin emas).");
  state.targetChatId = String(ctx.chat.id);
  saveState();
  ctx.reply(`✅ TARGET_CHAT_ID saqlandi: ${state.targetChatId}`);
});

bot.command("status", (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("❌ Ruxsat yo‘q (admin emas).");
  const cache = loadCache();
  const cacheByType = EMPLOYEE_TYPES.map((t) => `${t}=${getEmployeesByTypeFromCache(cache, t).length}`).join(", ");
  ctx.reply(
    "⚙️ Status:\n" +
      `EMPLOYEE_TYPES = ${EMPLOYEE_TYPES.join(", ")}\n` +
      `TZ = ${TZ}\n` +
      `CRON_TIME = ${CRON_TIME}\n` +
      `TARGET_CHAT_ID = ${state.targetChatId || "(yo‘q)"}\n` +
      `lastSentDate = ${state.lastSentDate || "(yo‘q)"}\n` +
      `cacheUpdated = ${cache.updatedAt ? new Date(cache.updatedAt).toLocaleString() : "(yo‘q)"}\n` +
      `cacheByType = ${cacheByType}\n` +
      `cacheCount = ${cache.items?.length || 0}`
  );
});

bot.command("run", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("❌ Ruxsat yo‘q (admin emas).");
  ctx.reply("⏳ Tabrik ishga tushyapti...");
  try {
    await sendBirthdayGreetings();
    ctx.reply("✅ Tayyor.");
  } catch (e) {
    console.error(e);
    ctx.reply("❌ Xatolik. Konsol logini tekshiring.");
  }
});

bot.on("text", async (ctx, next) => {
  const command = getCommandTokenFromText(ctx.message?.text || "");
  if (!command || RESERVED_COMMANDS.has(command)) return next();

  const item = getCustomCommand(command);
  if (!item) return next();

  const replyText = renderCustomCommandReply(item.replyText || "");
  if (!replyText.trim()) return ctx.reply(`/${command} uchun javob matni bo'sh.`);
  return ctx.reply(replyText);
});

/* =========================
   CRON
========================= */

cron.schedule(
  CRON_TIME,
  async () => {
    try {
      console.log("⏰ Cron ishga tushdi...");
      await sendBirthdayGreetings();
    } catch (e) {
      console.error("Cron error:", e);
    }
  },
  { timezone: TZ }
);

bot.launch().then(() => console.log("✅ Bot ishga tushdi"));
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
