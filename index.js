import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import cron from "node-cron";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";
import nodemailer from "nodemailer";
import "dotenv/config";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const URL = process.env.URL || `http://localhost:${PORT}`;

// ----------------- Email Config -----------------
if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
  console.warn("⚠️ EMAIL_USER or EMAIL_PASS not set in environment variables.");
}
console.log(process.env.EMAIL_USER, process.env.EMAIL_PASS);

async function sendEmail({ to, subject, text, html, attachmentPath }) {
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });

  const mailOptions = {
    from: process.env.EMAIL_USER,
    to,
    subject,
    text,
    attachments: [],
  };

  if (html) {
    mailOptions.html = html;
  }

  if (attachmentPath) {
    mailOptions.attachments.push({
      filename: path.basename(attachmentPath),
      path: attachmentPath,
    });
  }

  await transporter.sendMail(mailOptions);
  console.log(`📧 Email sent to ${to} ${attachmentPath ? "with attachment" : ""}`);
}

// ----------------- Users -----------------
const USERS_FILE = path.join(__dirname, "users.json");
let users = [];
const scheduledJobs = {};

async function loadUsers() {
  try {
    const data = await fs.readFile(USERS_FILE, "utf-8");
    users = JSON.parse(data);

    Object.values(scheduledJobs).forEach(job => job.stop());
    Object.keys(scheduledJobs).forEach(key => delete scheduledJobs[key]);

    users.forEach(u => {
      if (u.username && u.password && u.email) scheduleUserJob(u);
    });

    console.log(`✅ Loaded ${users.length} users`);
  } catch {
    users = [];
    console.warn("⚠️ users.json not found or invalid");
  }
}

async function saveUsers() {
  await fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2));
}

// ----------------- Puppeteer with @sparticuz/chromium -----------------
async function launchBrowserWithRetry(retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await puppeteer.launch({
        args: chromium.args,
        defaultViewport: chromium.defaultViewport,
        executablePath: await chromium.executablePath(),
        headless: true,
        ignoreHTTPSErrors: true,
      });
    } catch (err) {
      if (err.code === "ETXTBSY" && i < retries - 1) {
        console.warn("Chromium busy, retrying in 1s...");
        await new Promise(r => setTimeout(r, 1000));
      } else {
        throw err;
      }
    }
  }
}

async function loginAndScreenshot({ name, username, password, email }) {
  const TARGET_URL = "https://lms.cuonlineedu.in/";
  const ATTENDANCE_URL = "https://lms.cuonlineedu.in/my-attendance";

  let browser;

  try {
    browser = await launchBrowserWithRetry();
    const page = await browser.newPage();

    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
    );

    await page.goto(TARGET_URL, { waitUntil: "networkidle2", timeout: 60000 });

    await page.type("#username", username, { delay: 40 });
    await page.type("#password", password, { delay: 40 });

    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 10000 }).catch(() => {}),
      page.click("#user-sign-in"),
    ]);

    await page.goto(ATTENDANCE_URL, { waitUntil: "networkidle2", timeout: 60000 });
    await new Promise(r => setTimeout(r, 2000));

    const screenshotPath = path.join(__dirname, `screenshots/${username}.png`);
    await fs.mkdir(path.dirname(screenshotPath), { recursive: true });
    await page.screenshot({ path: screenshotPath, fullPage: true });

    console.log(`[${username}] ✅ Screenshot saved: ${screenshotPath}`);

    if (email) {
      await sendEmail({
        to: email,
        subject: "✅ Attendance Automated Successfully | Daily Screenshot",
        text: `Hi ${name},\n\n✅ Your attendance has been automated!\n📸 Screenshot attached.\n⏰ Next run: Tomorrow at 8:00 AM IST\n\nBest,\nAutomation Bot`,
        attachmentPath: screenshotPath,
      });
    }
  } catch (err) {
    console.error(`[${username}] ❌ Login failed:`, err.message);
  } finally {
    if (browser) await browser.close();
  }
}

// ----------------- Cron Scheduling -----------------
function scheduleUserJob({ name, username, password, email }) {
  if (!username || !password) return;

  // Daily at 8 AM IST
  // const cronTime = "0 8 * * *";
  // for testing every minute use: const cronTime = "* * * * *";
  const cronTime = "*/2 * * * *";

  if (scheduledJobs[username]) scheduledJobs[username].stop();

  scheduledJobs[username] = cron.schedule(
    cronTime,
    () => {
      console.log(`⏰ Running login for ${username} at ${new Date().toLocaleString()}`);
      loginAndScreenshot({ name, username, password, email });
    },
    { timezone: "Asia/Kolkata" }
  );

  console.log(`🕒 Scheduled daily job for ${username}`);
}

// ----------------- Express -----------------
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.urlencoded({ extended: true }));

app.get("/", (req, res) => {
  res.render("index", { message: null, error: null });
});

app.post("/add-user", async (req, res) => {
  const { name, username, password, email } = req.body;
  if (!username || !password || !email) {
    return res.render("index", { message: null, error: "All fields are required." });
  }
  if (users.find(u => u.username === username)) {
    return res.render("index", { message: null, error: "User already exists." });
  }

  const user = { name, username, password, email };
  users.push(user);
  await saveUsers();
  scheduleUserJob(user);

  res.render("index", { message: `User ${username} scheduled daily at 8 AM`, error: null });
});

app.get("/users", async (req, res) => {
  try {
    const data = await fs.readFile(USERS_FILE, "utf-8");
    res.json(JSON.parse(data));
  } catch {
    res.status(500).json({ error: "Could not read users file" });
  }
});

app.get("/health", (req, res) => {
  res.status(200).json({ status: "UP", time: new Date().toISOString() });
});

// Health check cron job
cron.schedule("*/13 * * * *", async () => {
  try {
    const response = await fetch(`${URL}/health`);
    console.log("Health check status:", response.status);
    const data = await response.json();
    console.log("Health check response:", data);
  } catch (err) {
    console.error("Error during health check:", err.message);
  }
});

// ----------------- Start -----------------
await loadUsers();

// Reload users.json daily at 7:59 AM IST
cron.schedule("59 7 * * *", async () => {
  await loadUsers();
}, { timezone: "Asia/Kolkata" });

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
