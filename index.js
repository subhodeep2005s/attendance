import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import cron from "node-cron";
import puppeteer from "puppeteer";
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

// FIXED: Added html parameter and proper structure
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
    attachments: [
      {
        filename: path.basename(attachmentPath),
        path: attachmentPath,
      },
    ],
  };

  // Add HTML if provided
  if (html) {
    mailOptions.html = html;
  }

  await transporter.sendMail(mailOptions);
  console.log(`📧 Email sent to ${to} with attachment ${attachmentPath}`);
}

// ----------------- Users -----------------
const USERS_FILE = path.join(__dirname, "users.json");
let users = [];
const scheduledJobs = {};

async function loadUsers() {
  try {
    const data = await fs.readFile(USERS_FILE, "utf-8");
    users = JSON.parse(data);

    // Stop old jobs before rescheduling
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

// ----------------- Puppeteer Login + Email -----------------
async function loginAndScreenshot({ name, username, password, email }) {
  const TARGET_URL = "https://lms.cuonlineedu.in/";
  const ATTENDANCE_URL = "https://lms.cuonlineedu.in/my-attendance";

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();
    await page.goto(TARGET_URL, { waitUntil: "networkidle2", timeout: 60000 });

    await page.type("#username", username, { delay: 40 });
    await page.type("#password", password, { delay: 40 });

    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 10000 }).catch(() => {}),
      page.click("#user-sign-in"),
    ]);

    await page.goto(ATTENDANCE_URL, { waitUntil: "networkidle2", timeout: 60000 });
    await new Promise((r) => setTimeout(r, 2000));

    const screenshotPath = path.join(__dirname, `screenshots/${username}.png`);
    await fs.mkdir(path.dirname(screenshotPath), { recursive: true });
    await page.screenshot({ path: screenshotPath, fullPage: true });

    console.log(`[${username}] ✅ Screenshot saved: ${screenshotPath}`);

    // FIXED: Proper email sending with html parameter
    if (email) {
      await sendEmail({
        to: email,
        subject: "✅ Attendance Automated Successfully | Daily Screenshot",
        text: `Hi ${name},

✅ Your attendance has been successfully automated!
📸 Screenshot captured and attached
⏰ Next automation: Tomorrow at 8:00 AM IST

For more info, visit https://subhodeep.tech

Best regards,
Attendance Automation Team`,

        html: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: linear-gradient(135deg, #667eea, #764ba2); padding: 20px; border-radius: 10px;"><div style="background: white; padding: 30px; border-radius: 10px; box-shadow: 0 10px 30px rgba(0,0,0,0.1);"><div style="text-align: center; margin-bottom: 30px;"><div style="width: 60px; height: 60px; background: linear-gradient(135deg, #667eea, #764ba2); border-radius: 50%; margin: 0 auto 15px; display: flex; align-items: center; justify-content: center; font-size: 24px; color: white;">✓</div><h2 style="color: #333; margin: 0;">Attendance Automated!</h2></div><p style="color: #333; font-size: 16px; line-height: 1.6;">Hi <strong>${name}</strong>,</p><div style="background: #f0f8ff; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #667eea;"><p style="color: #333; margin: 0; font-size: 16px;">✅ Your attendance screenshot has been captured successfully!<br>📸 Screenshot is attached to this email<br>⏰ Next automation: Tomorrow at 8:00 AM IST</p></div><p style="color: #333; font-size: 16px; line-height: 1.6;">This automation is brought to you by <a href="https://subhodeep.tech" style="color: #667eea; text-decoration: none;">subhodeep.tech</a></p><div style="text-align: center; margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee;"><p style="color: #666; font-size: 12px; margin: 0;">Powered by Attendance Automation System</p></div></div></div>`,
        
        attachmentPath: screenshotPath,
      });
    }
  } catch (err) {
    console.error(`[${username}] ❌ Login failed:`, err.message);
  } finally {
    await browser.close();
  }
}

// ----------------- Cron Scheduling -----------------
function scheduleUserJob({ name, username, password, email }) {
  if (!username || !password) return;

  // Daily at 8 AM IST (change if needed)
  const cronTime = "0 8 * * *";
  // 🔹 For testing, change to run every 2 minutes:
  // const cronTime = "*/1 * * * *";

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

// FIXED: Health check cron job with proper error handling
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