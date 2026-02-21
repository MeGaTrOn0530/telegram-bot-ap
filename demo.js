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
| "Asia/Tashkent";N_TIME = process.env.CRON_TIME || "0 9 * * *";
const