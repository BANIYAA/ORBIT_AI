import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { Type } from "@google/genai";
import dotenv from "dotenv";
import { OAuth2Client } from "google-auth-library";
import { google } from "googleapis";
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { db } from "./src/db";
import { users } from "./src/db/schema";
import { eq } from "drizzle-orm";
import { retryGenerateContent } from "./services/geminiService";
import { routeGenerativeRequest, parseWithRuleEngine, aiMetrics, resetAiCooldowns } from "./services/aiRouter";
import { taskRepo, habitRepo, directiveRepo, dailyPlanRepo, reflectionRepo, reminderRepo, focusSessionRepo, productivityDnaRepo, journalInsightsRepo, userProfileSummaryRepo, sessionContext, userRepo } from "./src/services/dbService";
import { logger, metricsRegistry } from "./services/logger";

// AI Coach Cache
let aiCoachCache = {
  timestamp: 0,
  data: null as any
};

function invalidateAiCoachCache() {
  aiCoachCache.timestamp = 0;
  aiCoachCache.data = null;
}

// Validation schemas (unchanged)
import { validate } from "./src/middleware/validate";
import { taskListRequestSchema } from "./src/schemas/task.schema";
import { habitListRequestSchema } from "./src/schemas/habit.schema";
import { reflectionRequestSchema } from "./src/schemas/reflection.schema";
import { planRequestSchema } from "./src/schemas/plan.schema";
import { coachRequestSchema } from "./src/schemas/coach.schema";
import { briefingRequestSchema, reviewRequestSchema, taskReminderRequestSchema } from "./src/schemas/reminder.schema";
import { sanitizeTask, sanitizeHabit, sanitizeJournal, sanitizeText } from "./src/utils/sanitize";

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '50mb' }));

// Observability and latency logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - start;
    logger.recordApi(req.path, res.statusCode, duration);
  });
  next();
});

const JWT_SECRET = process.env.JWT_SECRET || 'orbit_ai_super_secret_key_123';

// Auth Middleware
app.use((req, res, next) => {
  if (req.path.startsWith('/api/auth') || req.path === '/api/health/ai' || req.path === '/api/health' || !req.path.startsWith('/api/')) {
    return next();
  }
  
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing token' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { userId: string };
    sessionContext.run({ userId: decoded.userId }, next);
  } catch (err) {
    return res.status(401).json({ error: 'Unauthorized: Invalid token' });
  }
});

// Auth Routes
app.post('/api/auth/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: "Missing fields" });
  
  try {
    const existing = await userRepo.getByEmail(email);
    if (existing) {
      logger.recordAuth("loginFailure");
      return res.status(400).json({ error: "Email already registered" });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const userId = `user_${Date.now()}`;
    await userRepo.create({
      id: userId,
      name,
      email,
      passwordHash,
      createdAt: new Date().toISOString()
    });

    const token = jwt.sign({ userId }, JWT_SECRET, { expiresIn: '7d' });
    logger.recordAuth("loginSuccess");
    logger.log("AUTH", `Registered new user: ${email}`);
    res.json({ token, user: { id: userId, name, email } });
  } catch (e: any) {
    logger.recordAuth("loginFailure");
    logger.error("AUTH", `Registration failed for ${email}`, e);
    res.status(500).json({ error: "Registration failed" });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Missing fields" });

  try {
    const user = await userRepo.getByEmail(email);
    if (!user) {
      logger.recordAuth("loginFailure");
      logger.log("AUTH", `Failed login attempt for ${email} (User not found)`);
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const isValid = await bcrypt.compare(password, user.passwordHash);
    if (!isValid) {
      logger.recordAuth("loginFailure");
      logger.log("AUTH", `Failed login attempt for ${email} (Invalid password)`);
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
    let onboardingCompleted = false;
    await sessionContext.run({ userId: user.id }, async () => {
      const summary = await userProfileSummaryRepo.get();
      if (summary?.onboardingCompleted) {
        onboardingCompleted = true;
      }
    });

    logger.recordAuth("loginSuccess");
    logger.log("AUTH", `Successful login for user: ${email}`);
    res.json({ token, user: { id: user.id, name: user.name, email: user.email }, onboardingCompleted });
  } catch (e: any) {
    logger.recordAuth("loginFailure");
    logger.error("AUTH", `Login failed for ${email}`, e);
    res.status(500).json({ error: "Login failed" });
  }
});

app.post('/api/auth/google', async (req, res) => {
  const { email, name, uid } = req.body;
  if (!email || !uid) return res.status(400).json({ error: "Missing fields" });

  try {
    let user = await userRepo.getByEmail(email);
    let userId;
    
    if (!user) {
      userId = `google_${uid}`;
      const passwordHash = await bcrypt.hash(uid, 10);
      await userRepo.create({
        id: userId,
        name: name || 'Google User',
        email,
        passwordHash,
        createdAt: new Date().toISOString()
      });
    } else {
      userId = user.id;
    }

    const token = jwt.sign({ userId }, JWT_SECRET, { expiresIn: '7d' });
    let onboardingCompleted = false;
    await sessionContext.run({ userId }, async () => {
      const summary = await userProfileSummaryRepo.get();
      if (summary?.onboardingCompleted) {
        onboardingCompleted = true;
      }
    });

    logger.recordAuth("loginSuccess");
    logger.log("AUTH", `Successful Google login for user: ${email}`);
    res.json({ token, user: { id: userId, name: name || 'Google User', email }, onboardingCompleted });
  } catch (e: any) {
    logger.recordAuth("loginFailure");
    logger.error("AUTH", `Google login failed for ${email}`, e);
    res.status(500).json({ error: "Google login failed" });
  }
});

app.post('/api/auth/demo', async (req, res) => {
  try {
    const demoEmail = 'demo@orbit.ai';
    let user = await userRepo.getByEmail(demoEmail);
    
    let userId;
    if (!user) {
      userId = `demo_${Date.now()}`;
      const passwordHash = await bcrypt.hash('demo123', 10);
      await userRepo.create({
        id: userId,
        name: 'Demo User',
        email: demoEmail,
        passwordHash,
        createdAt: new Date().toISOString()
      });
    } else {
      userId = user.id;
    }

    // Always seed/reset Demo Account Data to ensure a beautiful, fully-populated, fresh experience
    await sessionContext.run({ userId }, async () => {
      const now = new Date();
      const ymd = now.toISOString().split('T')[0];
      
      const yesterdayDate = new Date();
      yesterdayDate.setDate(yesterdayDate.getDate() - 1);
      const ymdYesterday = yesterdayDate.toISOString().split('T')[0];

      await taskRepo.saveAll([
        {
          id: 'dt1',
          title: 'Review Orbit AI Architecture',
          deadline: ymd + 'T17:00',
          importance: 'high',
          duration: 45,
          completed: false,
          createdAt: new Date().toISOString(),
          subtasks: [
            { id: 'dts1', title: 'Inspect aiRouter fallback rules', status: 'Completed' },
            { id: 'dts2', title: 'Verify db connection pool logs', status: 'Pending' },
            { id: 'dts3', title: 'Test validation middleware performance', status: 'Pending' }
          ]
        },
        {
          id: 'dt2',
          title: 'Prepare Demo Pitch',
          deadline: ymd + 'T17:00',
          importance: 'medium',
          duration: 30,
          completed: false,
          createdAt: new Date().toISOString(),
          subtasks: []
        },
        {
          id: 'dt3',
          title: 'Complete Feedback Survey',
          deadline: ymd + 'T17:00',
          importance: 'low',
          duration: 15,
          completed: false,
          createdAt: new Date().toISOString(),
          subtasks: []
        },
        {
          id: 'dt4',
          title: 'Complete Launch Checklist',
          deadline: ymdYesterday + 'T18:00',
          importance: 'high',
          duration: 60,
          completed: true,
          completedAt: ymdYesterday + 'T16:30',
          createdAt: yesterdayDate.toISOString(),
          subtasks: []
        },
        {
          id: 'dt5',
          title: 'Design UI Theme',
          deadline: ymdYesterday + 'T14:00',
          importance: 'medium',
          duration: 45,
          completed: true,
          completedAt: ymdYesterday + 'T11:15',
          createdAt: yesterdayDate.toISOString(),
          subtasks: []
        }
      ]);

      await habitRepo.saveAll([
        { id: 'dh1', title: 'Morning Meditation', frequency: 'daily', streak: 12, bestStreak: 12, completedDays: [ymdYesterday, ymd], createdAt: new Date().toISOString() },
        { id: 'dh2', title: 'Read 30 Pages', frequency: 'daily', streak: 5, bestStreak: 8, completedDays: [ymdYesterday], createdAt: new Date().toISOString() },
        { id: 'dh3', title: 'Hydration 2L', frequency: 'daily', streak: 15, bestStreak: 15, completedDays: [ymdYesterday, ymd], createdAt: new Date().toISOString() }
      ]);

      await dailyPlanRepo.save({
        date: ymd,
        events: [
          { id: 'evt1', taskId: 'dt1', title: 'Review Orbit AI Architecture', startTime: '10:00', endTime: '10:45' },
          { id: 'evt2', taskId: 'dt2', title: 'Prepare Demo Pitch', startTime: '13:00', endTime: '13:30' }
        ],
        insights: [
          'Demo day is here! Keep your presentation concise.',
          'Your cognitive capacity is high this morning. Handle the Architecture review first.',
          'Plan a 5-minute movement break after the midday pitch.'
        ],
        productivityScore: 85,
        productivityTrend: 'Rising'
      });

      await userProfileSummaryRepo.save({
        onboardingCompleted: true,
        workHours: { start: "09:00", end: "17:00" },
        focusDuration: 45,
        weeklyGoals: ["Ship the MVP", "Stay healthy", "Perfect the Pitch"]
      });

      await productivityDnaRepo.save({
        analysisDate: ymd,
        bestWorkHours: "9 AM – 12 PM",
        productiveDay: "Tuesday",
        completionRate: 92,
        focusScore: 88,
        habitScore: 90,
        procrastinationScore: 8,
        recommendations: [
          "Your focus is peak in the morning; protect 9 AM - 12 PM for deep work.",
          "Habit completion rate is 95% on Tuesdays, but drops on Fridays. Try scheduling reminders on Friday afternoons.",
          "Complex engineering tasks are best tackled in 45-minute focus intervals as shown by your telemetry."
        ]
      });

      await reflectionRepo.save({
        id: `ref_${ymdYesterday}`,
        date: ymdYesterday,
        completionRate: 85,
        habitConsistency: 90,
        focusScore: 88,
        momentumScore: 87,
        missedWork: 0,
        extraWork: 1,
        dailyReflection: "Had an extremely productive day yesterday. Handled the complex backend architecture review cleanly during my morning peak hour.",
        performanceAnalysis: "Morning focus session lasted 45 minutes with zero interruptions. Energy levels were optimal.",
        personalizedCoaching: "Excellent management of your cognitive load. Continue protecting your morning slot.",
        positiveReinforcement: "You are consistent with meditation which correlates strongly with high focus scores.",
        futurePlanningSuggestions: ["Schedule the pitch preparation early in the afternoon.", "Keep tasks modular."],
        distractionPatterns: ["Slack notifications during late afternoon."],
        energyPatterns: ["High in morning", "Slight dip at 2 PM", "Recovery at 4 PM"],
        weeklyTrends: "Focus is up 12% week over week."
      });

      await focusSessionRepo.save({
        id: `fs_demo_1`,
        taskId: 'dt4',
        startTime: yesterdayDate.toISOString(),
        endTime: new Date(yesterdayDate.getTime() + 45 * 60000).toISOString(),
        durationMinutes: 45,
        completed: true,
        createdAt: yesterdayDate.toISOString()
      });

      await focusSessionRepo.save({
        id: `fs_demo_2`,
        taskId: 'dt5',
        startTime: yesterdayDate.toISOString(),
        endTime: new Date(yesterdayDate.getTime() + 30 * 60000).toISOString(),
        durationMinutes: 30,
        completed: true,
        createdAt: yesterdayDate.toISOString()
      });

      await journalInsightsRepo.save({
        id: `ji_demo_1`,
        journalId: 'demo_journal_1',
        analysis: "Expressed high clarity and satisfaction with the team's engineering velocity. Noted slight physical fatigue toward the end of the day.",
        score: 85,
        improvements: ["Ensure proper hydration after lunch.", "Step away from screen every 90 minutes."],
        createdAt: yesterdayDate.toISOString()
      });
    });

    const token = jwt.sign({ userId }, JWT_SECRET, { expiresIn: '7d' });
    logger.recordAuth("loginSuccess");
    logger.log("AUTH", `Demo login processed for user ID: ${userId}`);
    res.json({ token, user: { id: userId, name: 'Demo User', email: demoEmail } });
  } catch (e: any) {
    logger.recordAuth("loginFailure");
    logger.error("AUTH", "Demo login failed", e);
    res.status(500).json({ error: "Demo login failed" });
  }
});

// We removed /api/auth/onboarding from here, moving it down below the auth middleware

app.get('/api/auth/me', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { userId: string };
    const user = await userRepo.getById(decoded.userId);
    if (!user) return res.status(401).json({ error: "User not found" });
    res.json({ id: user.id, name: user.name, email: user.email, preferences: user.preferences });
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
});

app.post('/api/onboarding', async (req, res) => {
  try {
    const { preferences } = req.body;
    await userProfileSummaryRepo.save({ ...preferences, onboardingCompleted: true });

    // Also pre-create a default productivity_dna record so that a row exists and userId is correctly associated
    const today = new Date().toISOString().split('T')[0];
    await productivityDnaRepo.save({
      analysisDate: today,
      bestWorkHours: "9 AM – 12 PM",
      productiveDay: "Tuesday",
      completionRate: 0,
      focusScore: 0,
      habitScore: 0,
      procrastinationScore: 0,
      recommendations: [
        "Create and complete tasks in Orbit AI to populate your Behavioral Intelligence profile.",
        "Start tracking daily habits in Orbit AI to build your Behavioral Intelligence profile.",
        "Launch focus sessions from the Focus tab to record behavioral telemetry."
      ]
    });

    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: "Failed to save onboarding" });
  }
});

// Google Calendar Integration
const auth = new OAuth2Client();

const getCalendar = (req: express.Request) => {
  const token = req.headers['x-goog-workspace-access-token'];
  if (!token) {
    return null; // Return null instead of throwing to allow graceful fallback
  }

  auth.setCredentials({ access_token: token as string });
  return google.calendar({ version: 'v3', auth: auth as any });
};

app.post('/api/calendar/sync', async (req, res) => {
  try {
    const calendar = getCalendar(req);
    const { tasks } = req.body;
    
    if (!tasks || !Array.isArray(tasks)) {
      return res.status(400).json({ error: "Invalid tasks payload" });
    }

    if (!calendar) {
      // Graceful fallback for preview environment where token is not injected
      console.log("No Workspace access token found. Mocking calendar sync.");
      let mockSynced = 0;
      for (const task of tasks) {
        if (!task.completed && task.deadline && new Date(task.deadline) > new Date()) {
          mockSynced++;
        }
      }
      return res.json({ 
        success: true, 
        syncedCount: mockSynced, 
        message: "Simulated sync in preview mode (OAuth token missing)." 
      });
    }


    // A simple sync: for demonstration we will fetch the upcoming events,
    // and insert new tasks as events. To avoid duplicates, we can check by summary.
    // In a real app we'd store event IDs.
    
    const now = new Date();
    const timeMin = now.toISOString();
    
    const response = await calendar.events.list({
      calendarId: 'primary',
      timeMin: timeMin,
      maxResults: 100,
      singleEvents: true,
      orderBy: 'startTime',
    });
    
    const existingEvents = response.data.items || [];
    let syncedCount = 0;
    
    for (const task of tasks) {
      if (task.completed || !task.deadline) continue;
      
      const eventSummary = `Orbit AI: ${task.title}`;
      const isExisting = existingEvents.some(event => event.summary === eventSummary);
      
      if (!isExisting) {
        const taskTime = new Date(task.deadline);
        // If task deadline is in the past, don't sync
        if (taskTime < now) continue;
        
        const endTime = new Date(taskTime.getTime() + (task.duration || 30) * 60000);
        
        await calendar.events.insert({
          calendarId: 'primary',
          requestBody: {
            summary: eventSummary,
            description: `Priority: ${task.importance}\nDuration: ${task.duration} mins`,
            start: { dateTime: taskTime.toISOString() },
            end: { dateTime: endTime.toISOString() },
          }
        });
        syncedCount++;
      }
    }
    
    res.json({ success: true, syncedCount });
  } catch (err: any) {
    console.log("Calendar sync error:", err);
    res.status(500).json({ error: err.message || "Failed to sync with calendar" });
  }
});

const getFitness = (req: express.Request) => {
  const token = req.headers['x-goog-workspace-access-token'];
  if (!token) {
    return null;
  }
  auth.setCredentials({ access_token: token as string });
  return google.fitness({ version: 'v1', auth: auth as any });
};

app.post('/api/fit/sync', async (req, res) => {
  try {
    const fitness = getFitness(req);
    const { habits } = req.body;
    
    if (!habits || !Array.isArray(habits)) {
      return res.status(400).json({ error: "Invalid habits payload" });
    }

    if (!fitness) {
      console.log("No Workspace access token found. Mocking fitness sync.");
      return res.json({ 
        success: true, 
        message: "Simulated Google Fit sync in preview mode (OAuth token missing).",
        updatedHabits: habits.map((h: any) => ({
          ...h,
          currentStreak: h.currentStreak + (Math.random() > 0.5 ? 1 : 0),
          lastCompleted: new Date().toISOString()
        }))
      });
    }

    const now = new Date();
    const startTimeMillis = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const endTimeMillis = now.getTime();

    // Query step count as an example
    const response: any = await (fitness.users.dataset.aggregate as any)({
      userId: 'me',
      requestBody: {
        aggregateBy: [{
          dataTypeName: 'com.google.step_count.delta',
          dataSourceId: 'derived:com.google.step_count.delta:com.google.android.gms:estimated_steps'
        }],
        bucketByTime: { durationMillis: 86400000 },
        startTimeMillis,
        endTimeMillis
      }
    });

    let todaySteps = 0;
    const buckets = response.data?.bucket || [];
    for (const bucket of buckets) {
      const datasets = bucket.dataset || [];
      for (const dataset of datasets) {
        const points = dataset.point || [];
        for (const point of points) {
          const values = point.value || [];
          for (const value of values) {
            todaySteps += value.intVal || 0;
          }
        }
      }
    }

    const updatedHabits = habits.map((h: any) => {
      const isStepHabit = h.title.toLowerCase().includes('step') || h.title.toLowerCase().includes('walk');
      const isExerciseHabit = h.title.toLowerCase().includes('exercise') || h.title.toLowerCase().includes('workout');
      
      let completedToday = false;
      if (isStepHabit && todaySteps > 5000) completedToday = true;
      if (isExerciseHabit && buckets.length > 0) completedToday = true; // just a rough proxy

      if (completedToday) {
        return {
          ...h,
          currentStreak: h.currentStreak + 1,
          lastCompleted: new Date().toISOString()
        };
      }
      return h;
    });

    res.json({ success: true, updatedHabits, message: `Synced with Google Fit (Steps today: ${todaySteps})` });
  } catch (err: any) {
    console.log("Fit sync error:", err);
    res.status(500).json({ error: err.message || "Failed to sync with Google Fit" });
  }
});

// Load and Save persistent tasks
const getGmail = (req: express.Request) => {
  const token = req.headers['x-goog-workspace-access-token'];
  if (!token) {
    return null;
  }
  auth.setCredentials({ access_token: token as string });
  return google.gmail({ version: 'v1', auth: auth as any });
};

app.post('/api/mail/sync', async (req, res) => {
  try {
    const gmail = getGmail(req);
    if (!gmail) {
      console.log("No Workspace access token found. Mocking gmail sync.");
      return res.json({ 
        success: true, 
        message: "Simulated Gmail sync in preview mode (OAuth token missing).",
        newTasks: [
          { id: 'mock1', title: 'Review mock email from manager', deadline: new Date().toISOString(), importance: 'high' }
        ]
      });
    }

    const response = await gmail.users.messages.list({
      userId: 'me',
      q: 'is:unread',
      maxResults: 5
    });

    const messages = response.data.messages || [];
    const newTasks = [];
    
    for (const msg of messages) {
      if (msg.id) {
        const detail = await gmail.users.messages.get({ userId: 'me', id: msg.id });
        const headers = detail.data.payload?.headers || [];
        const subjectHeader = headers.find(h => h.name === 'Subject');
        const subject = subjectHeader ? subjectHeader.value : 'No Subject';
        
        newTasks.push({
          id: `mail_${msg.id}`,
          title: `Reply: ${subject}`,
          importance: 'medium',
          duration: 15,
          createdAt: new Date().toISOString()
        });
      }
    }

    res.json({ success: true, newTasks, message: `Synced ${newTasks.length} unread emails as tasks.` });
  } catch (err: any) {
    console.log("Gmail sync error:", err);
    res.status(500).json({ error: err.message || "Failed to sync with Gmail" });
  }
});

app.get("/api/tasks", async (req, res) => {
  try {
    const tasks = await taskRepo.getAll();
    res.json({ tasks });
  } catch (error) {
    console.error("Error fetching tasks:", error);
    res.status(500).json({ error: "Failed to fetch tasks" });
  }
});

app.post("/api/tasks", validate(taskListRequestSchema), async (req, res) => {
  const { tasks } = req.body;
  if (tasks && Array.isArray(tasks)) {
    try {
      const sanitizedTasks = tasks.map(sanitizeTask);
      await taskRepo.saveAll(sanitizedTasks);
      invalidateAiCoachCache();
    } catch (error) {
      console.error("Error saving tasks:", error);
      return res.status(500).json({ error: "Failed to save tasks" });
    }
  }
  res.json({ success: true });
});

// Load and Save persistent habits
app.get("/api/habits", async (req, res) => {
  try {
    const habits = await habitRepo.getAll();
    res.json({ habits });
  } catch (error) {
    console.error("Error fetching habits:", error);
    res.status(500).json({ error: "Failed to fetch habits" });
  }
});

app.post("/api/habits", validate(habitListRequestSchema), async (req, res) => {
  const { habits } = req.body;
  if (habits && Array.isArray(habits)) {
    try {
      const sanitizedHabits = habits.map(sanitizeHabit);
      await habitRepo.saveAll(sanitizedHabits);
      invalidateAiCoachCache();
    } catch (error) {
      console.error("Error saving habits:", error);
      return res.status(500).json({ error: "Failed to save habits" });
    }
  }
  res.json({ success: true });
});

// Load and Save persistent directive
app.get("/api/directive", async (req, res) => {
  try {
    const dailyDirective = await directiveRepo.get();
    res.json({ dailyDirective });
  } catch (error) {
    console.error("Error fetching directive:", error);
    res.status(500).json({ error: "Failed to fetch directive" });
  }
});

app.post("/api/directive", async (req, res) => {
  const { dailyDirective } = req.body;
  if (typeof dailyDirective === "string") {
    try {
      await directiveRepo.save(dailyDirective);
    } catch (error) {
      console.error("Error saving directive:", error);
      return res.status(500).json({ error: "Failed to save directive" });
    }
  }
  res.json({ success: true });
});


// Load and Save focus sessions
app.get("/api/focus_sessions", async (req, res) => {
  try {
    const sessions = await focusSessionRepo.getAll();
    res.json({ sessions });
  } catch (error) {
    console.error("Error fetching focus sessions:", error);
    res.status(500).json({ error: "Failed to fetch focus sessions" });
  }
});

app.post("/api/focus_sessions", async (req, res) => {
  const { session } = req.body;
  if (session) {
    try {
      await focusSessionRepo.save(session);
      invalidateAiCoachCache();
      res.json({ success: true });
    } catch (error) {
      console.error("Error saving focus session:", error);
      res.status(500).json({ error: "Failed to save focus session" });
    }
  } else {
    res.status(400).json({ error: "Invalid focus session payload" });
  }
});

// Offline Fallback Rule Engine for Productivity DNA
function calculateOfflineDna(tasks: any[], habits: any[], reflections: any[], focusSessions: any[], reminders: any[]) {
  const totalTasks = tasks.length;
  const completedTasks = tasks.filter(t => t.completed).length;
  const completionRate = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

  let habitScore = 0;
  if (habits.length > 0) {
    const totalStreaks = habits.reduce((sum, h) => sum + (h.streak || 0), 0);
    habitScore = Math.min(100, Math.max(30, 50 + totalStreaks * 5));
  }

  let focusScore = 0;
  if (focusSessions.length > 0) {
    const completedSessions = focusSessions.filter(s => s.completed).length;
    focusScore = Math.round((completedSessions / focusSessions.length) * 100);
  }

  let procrastinationScore = 0;
  const overdueCount = tasks.filter(t => !t.completed && t.deadline && new Date(t.deadline) < new Date()).length;
  const rescheduledCount = tasks.filter(t => t.isRescheduled).length;
  if (totalTasks > 0) {
    procrastinationScore = Math.min(100, Math.round(((overdueCount * 2 + rescheduledCount) / totalTasks) * 100));
  }

  return {
    bestWorkHours: focusSessions.length > 0 ? "9 AM – 12 PM" : "No data yet",
    productiveDay: tasks.filter(t => t.completed).length > 0 ? "Tuesday" : "No data yet",
    completionRate,
    focusScore,
    habitScore,
    procrastinationScore,
    recommendations: [
      totalTasks > 0 ? `Your current task completion rate is ${completionRate}%. Try to prioritize high-importance items first thing in the morning to maintain momentum.` : "Create and complete tasks in Orbit AI to populate your Behavioral Intelligence profile.",
      habits.length > 0 ? `Your habits show active momentum with a consistency score of ${habitScore}%. Keep checking in daily.` : "Start tracking daily habits in Orbit AI to build your Behavioral Intelligence profile.",
      focusSessions.length > 0 ? `Your focus sessions reliability is at ${focusScore}%. Setting dedicated 25-minute blocks will help eliminate interruptions.` : "Launch focus sessions from the Focus tab to record behavioral telemetry.",
      totalTasks > 0 ? (procrastinationScore > 40 ? `Procrastination risk is high (${procrastinationScore}%). Break down larger tasks automatically using the AI breakdown feature.` : "Procrastination risk is well-managed. Continue using Orbit planning tools to stay on track.") : "Maintain a clean scheduling sequence to optimize your procrastination defense score."
    ]
  };
}

// GET Productivity DNA profile
app.get("/api/productivity-dna", async (req, res) => {
  try {
    const refresh = req.query.refresh === 'true';
    const latest = await productivityDnaRepo.getLatest();
    const today = new Date().toISOString().split('T')[0];

    if (latest && latest.analysisDate === today && !refresh) {
      return res.json(latest);
    }

    // Load actual user data for analysis (Last 30 days)
    const tasksData = await taskRepo.getRecent(30);
    const habitsData = await habitRepo.getActive();
    const reflectionsData = await reflectionRepo.getRecent(30);
    const focusSessionsData = await focusSessionRepo.getRecentFocusSessions(30);
    const remindersData = await reminderRepo.getAll(); // Wait, reminderRepo doesn't have getRecent, but there are few reminders probably. Let's just keep getAll() for now or calculate summary.

    const completedTasks = tasksData.filter(t => t.completed).length;
    const taskCompletionRate = tasksData.length ? Math.round((completedTasks / tasksData.length) * 100) : 0;
    const rescheduledTasks = tasksData.filter(t => t.isRescheduled).length;

    const completedSessions = focusSessionsData.filter(s => s.completed).length;
    const focusReliability = focusSessionsData.length ? Math.round((completedSessions / focusSessionsData.length) * 100) : 0;

    const avgHabitStreak = habitsData.length ? Math.round(habitsData.map(h => h.streak).reduce((a,b)=>a+b,0) / habitsData.length) : 0;
    
    // Group tasks and sessions by day of week and hour to help Gemini determine best time/day without seeing all rows
    const dayCounts: Record<number, number> = { 0:0, 1:0, 2:0, 3:0, 4:0, 5:0, 6:0 };
    const hourCounts: Record<number, number> = {};
    focusSessionsData.forEach(s => {
      if (s.completed && s.startTime) {
        const d = new Date(s.startTime);
        dayCounts[d.getDay()]++;
        hourCounts[d.getHours()] = (hourCounts[d.getHours()] || 0) + 1;
      }
    });

    const summary = {
      taskCompletionRate,
      rescheduledTasksCount: rescheduledTasks,
      totalFocusSessions: focusSessionsData.length,
      focusReliability,
      avgHabitStreak,
      activeHabits: habitsData.length,
      completedSessionsByDayOfWeek: dayCounts,
      completedSessionsByHour: hourCounts,
      remindersSent: remindersData.length
    };

    // Prepare prompt and schema for Gemini
    const prompt = `
Analyze the user's productivity data to compile a personalized Behavioral Intelligence Profile ("Productivity DNA").
Data provided (Last 30 days summary):
${JSON.stringify(summary, null, 2)}
Habits: ${JSON.stringify(habitsData.map(h => ({ title: h.title, streak: h.streak })), null, 2)}
Reflections Summary: ${JSON.stringify(reflectionsData.map(r => ({ date: r.date, completionRate: r.completionRate, focusScore: r.focusScore })), null, 2)}

Based on this real data, generate:
1. Best Working Hours (e.g. "9 AM – 12 PM", "2 PM – 5 PM") based on completed tasks, focus sessions, and reflections.
2. Most Productive Day (e.g. "Tuesday", "Monday") based on when completion rates and focus times are highest.
3. Average Task Completion Rate (0-100).
4. Focus Reliability Score (0-100) representing how reliably they finish their focus sessions.
5. Habit Consistency Score (0-100) representing how consistent they are with checking off habits.
6. Procrastination Risk Score (0-100) based on overdue/rescheduled tasks and reminder responses.
7. 3-5 deeply personalized recommendations. Citing specific items from their data, explain WHY patterns exist and HOW they can improve.

Return a JSON object conforming to the expected schema.
`;

    const schema = {
      type: Type.OBJECT,
      properties: {
        bestWorkHours: { type: Type.STRING },
        productiveDay: { type: Type.STRING },
        completionRate: { type: Type.INTEGER },
        focusScore: { type: Type.INTEGER },
        habitScore: { type: Type.INTEGER },
        procrastinationScore: { type: Type.INTEGER },
        recommendations: {
          type: Type.ARRAY,
          items: { type: Type.STRING }
        }
      },
      required: ["bestWorkHours", "productiveDay", "completionRate", "focusScore", "habitScore", "procrastinationScore", "recommendations"]
    };

    const fallbackResponse = calculateOfflineDna(tasksData, habitsData, reflectionsData, focusSessionsData, remindersData);

    const routerResponse = await routeGenerativeRequest(prompt, schema, fallbackResponse);
    const data = routerResponse.data || fallbackResponse;

    // Standardize data keys and structure
    const dnaResult = {
      id: latest?.id || `dna_${today}`,
      analysisDate: today,
      bestWorkHours: data.bestWorkHours || fallbackResponse.bestWorkHours,
      productiveDay: data.productiveDay || fallbackResponse.productiveDay,
      completionRate: typeof data.completionRate === 'number' ? data.completionRate : fallbackResponse.completionRate,
      focusScore: typeof data.focusScore === 'number' ? data.focusScore : fallbackResponse.focusScore,
      habitScore: typeof data.habitScore === 'number' ? data.habitScore : fallbackResponse.habitScore,
      procrastinationScore: typeof data.procrastinationScore === 'number' ? data.procrastinationScore : fallbackResponse.procrastinationScore,
      recommendations: data.recommendations || fallbackResponse.recommendations
    };

    await productivityDnaRepo.save(dnaResult);

    // Update Rolling User Profile
    await userProfileSummaryRepo.save({
      bestFocusTime: dnaResult.bestWorkHours,
      strongestHabit: habitsData.length > 0 ? habitsData.reduce((prev, current) => (prev.streak > current.streak) ? prev : current).title : "None",
      weeklyCompletionRate: dnaResult.completionRate
    });

    res.json(dnaResult);
  } catch (error: any) {
    console.error("Error compiling Productivity DNA:", error);
    res.status(500).json({ error: "Failed to generate Productivity DNA profile" });
  }
});

// Offline Fallback for Productivity Intelligence recommendations
function calculateOfflineIntelligence(tasks: any[], habits: any[], reflections: any[], focusSessions: any[]) {
  const pendingTasks = tasks.filter(t => !t.completed);
  const overdueTasks = pendingTasks.filter(t => t.deadline && new Date(t.deadline) < new Date());
  const lowStreakHabit = habits.length > 0 ? [...habits].sort((a, b) => (a.streak || 0) - (b.streak || 0))[0] : null;
  const rescheduledTasks = pendingTasks.filter(t => t.isRescheduled);

  let whatToPrioritize = "Focus on outstanding core tasks. Ensure that your highest priority objective is isolated and tackled first thing in the morning.";
  if (pendingTasks.length > 0) {
    const highestPriority = pendingTasks.sort((a, b) => {
      const pA = a.importance === 'high' ? 3 : a.importance === 'medium' ? 2 : 1;
      const pB = b.importance === 'high' ? 3 : b.importance === 'medium' ? 2 : 1;
      return pB - pA;
    })[0];
    whatToPrioritize = `Prioritize "${highestPriority.title}" immediately. It is marked as ${highestPriority.importance} importance and requires your active execution to sustain momentum.`;
  }

  let habitsToImprove = "Maintain habit consistency. Daily rituals form the foundation of high-leverage cognitive focus.";
  if (lowStreakHabit) {
    habitsToImprove = `Focus on reinforcing your habit: "${lowStreakHabit.title}". Its current streak is ${lowStreakHabit.streak || 0} days. Try scheduling a reminder or anchoring it immediately after a recurring daily event.`;
  }

  let tasksToScheduleDifferently = "Review your session duration estimates. If tasks are consistently left incomplete, allocate smaller time blocks (15-25 mins) to prevent cognitive overload.";
  if (rescheduledTasks.length > 0) {
    tasksToScheduleDifferently = `You have ${rescheduledTasks.length} rescheduled task(s) (e.g., "${rescheduledTasks[0].title}"). Try scheduling rescheduled items during your peak energy hours rather than pushing them to the end of the day.`;
  }

  const riskAlerts: string[] = [];
  if (overdueTasks.length > 0) {
    riskAlerts.push(`Overdue Action Blocker: You have ${overdueTasks.length} overdue task(s). Action is required to resolve backlog bottleneck.`);
  }
  if (focusSessions.length > 0) {
    const completedFocus = focusSessions.filter(s => s.completed).length;
    const reliability = focusSessions.length > 0 ? (completedFocus / focusSessions.length) : 1;
    if (reliability < 0.6) {
      riskAlerts.push(`Focus Reliability Alert: Only ${Math.round(reliability * 100)}% of your focus sessions are completed. Minimize distraction triggers before starting timers.`);
    }
  }
  if (riskAlerts.length === 0) {
    riskAlerts.push("All clear: No immediate scheduling bottlenecks or cognitive risks detected.");
  }

  return {
    whatToPrioritize,
    habitsToImprove,
    tasksToScheduleDifferently,
    riskAlerts
  };
}

// GET AI Recommendations for Productivity Intelligence
app.get("/api/productivity-intelligence/recommendations", async (req, res) => {
  try {
    const tasksData = await taskRepo.getAll();
    const habitsData = await habitRepo.getAll();
    const reflectionsData = await reflectionRepo.getAll();
    const focusSessionsData = await focusSessionRepo.getAll();

    const prompt = `
Analyze the user's workspace performance metrics and data to generate strategic AI Recommendations.
Data:
1. Tasks: ${JSON.stringify(tasksData.map(t => ({ title: t.title, completed: t.completed, deadline: t.deadline, importance: t.importance, isRescheduled: t.isRescheduled })))}
2. Habits: ${JSON.stringify(habitsData.map(h => ({ title: h.title, frequency: h.frequency, completedDays: h.completedDays, streak: h.streak })))}
3. Reflections: ${JSON.stringify(reflectionsData.map(r => ({ date: r.date, completionRate: r.completionRate, focusScore: r.focusScore })))}
4. Focus Sessions: ${JSON.stringify(focusSessionsData.map(s => ({ startTime: s.startTime, durationMinutes: s.durationMinutes, completed: s.completed })))}

Generate:
1. whatToPrioritize: A specific and action-oriented recommendation on what the user should prioritize now and why.
2. habitsToImprove: Identification of the habit requiring immediate consistency adjustments, with a solid strategy.
3. tasksToScheduleDifferently: Feedback on tasks that are overdue, rescheduled, or mismatching the user's productivity peaks.
4. riskAlerts: An array of 1-3 warning alerts if there are high risks of procrastination, overdue bottlenecks, or low focus reliability.

Return JSON matching the schema.
`;

    const schema = {
      type: Type.OBJECT,
      properties: {
        whatToPrioritize: { type: Type.STRING },
        habitsToImprove: { type: Type.STRING },
        tasksToScheduleDifferently: { type: Type.STRING },
        riskAlerts: {
          type: Type.ARRAY,
          items: { type: Type.STRING }
        }
      },
      required: ["whatToPrioritize", "habitsToImprove", "tasksToScheduleDifferently", "riskAlerts"]
    };

    const fallbackResponse = calculateOfflineIntelligence(tasksData, habitsData, reflectionsData, focusSessionsData);
    const routerResponse = await routeGenerativeRequest(prompt, schema, fallbackResponse);
    const data = routerResponse.data || fallbackResponse;

    res.json({
      whatToPrioritize: data.whatToPrioritize || fallbackResponse.whatToPrioritize,
      habitsToImprove: data.habitsToImprove || fallbackResponse.habitsToImprove,
      tasksToScheduleDifferently: data.tasksToScheduleDifferently || fallbackResponse.tasksToScheduleDifferently,
      riskAlerts: data.riskAlerts || fallbackResponse.riskAlerts
    });
  } catch (error) {
    console.error("Error fetching AI Recommendations:", error);
    res.status(500).json({ error: "Failed to generate AI recommendations" });
  }
});

// Offline Fallback for Journal Analysis
function calculateOfflineJournalAnalysis(journalEntry: string, tasks: any[], habits: any[]) {
  const totalTasks = tasks.length;
  const completedTasks = tasks.filter(t => t.completed).length;
  const completionRate = totalTasks > 0 ? (completedTasks / totalTasks) : 0.75;
  const score = Math.round(completionRate * 100);

  let analysis = "";
  let improvements: string[] = [];

  if (score >= 75) {
    analysis = `Congratulations on an outstanding session! You've achieved a stellar task completion rate of ${score}% today. Based on your journal reflections ("${journalEntry || 'No notes typed'}"), your personal momentum is high, demonstrating efficient execution and cognitive clarity. You are translating focus into direct results.`;
    improvements = [
      "Celebrate your consistency: You are reinforcing positive behavioral loops.",
      "Suggested Next Challenge: Introduce a 15-minute planning session at the end of the day to pre-organize tomorrow's timeline.",
      "Benefit gained: Drastically reduced morning decision fatigue and sharper immediate focus."
    ];
  } else {
    analysis = `Today presented some environmental or cognitive friction, resulting in a task completion rate of ${score}%. Looking at your journal entry: "${journalEntry || 'No notes typed'}", you faced potential distractions or energy slumps that hindered checklist execution. This is a common pattern when transition times are undefined.`;
    improvements = [
      "Root Cause Analysis: Low momentum due to unmanaged context switching or delayed start times.",
      "Productivity Blocker: Lack of clearly isolated, single-task blocks.",
      "Recovery Plan: Dedicate your first 25-minute focus session tomorrow strictly to your highest-importance task without checking email or notifications."
    ];
  }

  return {
    analysis,
    improvements,
    score
  };
}

// POST Journal Analysis Endpoint
app.post("/api/journal-analysis", async (req, res) => {
  try {
    const { journalEntry, journalId } = req.body;
    if (!journalEntry || typeof journalEntry !== 'string' || !journalEntry.trim()) {
      return res.status(400).json({ error: "Journal entry cannot be empty" });
    }

    const today = new Date().toISOString().split('T')[0];
    const resolvedJournalId = journalId || `jrn_${Date.now()}`;
    const sanitizedJournal = sanitizeJournal(journalEntry.substring(0, 3000));

    // Fetch actual data to back up analysis (last 14 days)
    const tasksData = await taskRepo.getRecent(14);
    const habitsData = await habitRepo.getActive();
    const focusSessionsData = await focusSessionRepo.getRecentFocusSessions(14);
    const userProfile = await userProfileSummaryRepo.get();
    
    // Aggregation
    const completedTasks = tasksData.filter(t => t.completed).length;
    const highPriorityTasks = tasksData.filter(t => t.importance === 'high');
    const completedHighPriority = highPriorityTasks.filter(t => t.completed).length;
    
    const focusMinutes = focusSessionsData.reduce((acc, curr) => acc + (curr.completed ? curr.durationMinutes : 0), 0);
    
    const summary = {
      taskCompletionRate: tasksData.length ? Math.round((completedTasks / tasksData.length) * 100) : 0,
      highPriorityCompletion: highPriorityTasks.length ? Math.round((completedHighPriority / highPriorityTasks.length) * 100) : 0,
      totalFocusMinutes: focusMinutes,
      activeHabits: habitsData.length
    };

    const prompt = `
You are the Orbit AI Journal Intelligence Engine.
Your objective is to transform the user's daily journal entry into deeply personalized, actionable productivity coaching.
Compare the qualitative journal text with quantitative productivity logs to determine patterns, achievements, and blockers.

Inputs:
1. Journal Entry: "${sanitizedJournal}"
2. Productivity Summary (Last 14 days): ${JSON.stringify(summary, null, 2)}
3. Habits Adherence: ${JSON.stringify(habitsData.map(h => ({ title: h.title, streak: h.streak })), null, 2)}
4. Long-term User Profile Summary: ${userProfile ? JSON.stringify(userProfile, null, 2) : "Not enough data yet."}

Task:
Determine an overall behavioral score (0-100) representing their execution today.
If performance exceeds expectations (Score >= 75):
- Generate a highly personalized congratulations message.
- Summarize their performance highlighting specific tasks/habits they succeeded with.
- Outline specific cognitive/behavioral benefits gained from this momentum.
- Propose a tailored next-level challenge.

If performance is poor (Score < 75):
- Conduct a constructive, empathetic root-cause analysis.
- Identify core productivity blockers mentioned or implied in the journal (e.g. distraction, anxiety, procrastination).
- Provide a detailed step-by-step recovery plan for tomorrow.

Return a valid JSON object matching the requested schema. Use actual item names from the logs. Do NOT provide generic advice.
`;

    const schema = {
      type: Type.OBJECT,
      properties: {
        analysis: { type: Type.STRING },
        improvements: {
          type: Type.ARRAY,
          items: { type: Type.STRING }
        },
        score: { type: Type.INTEGER }
      },
      required: ["analysis", "improvements", "score"]
    };

    const fallbackResponse = calculateOfflineJournalAnalysis(sanitizedJournal, tasksData, habitsData);

    const routerResponse = await routeGenerativeRequest(prompt, schema, fallbackResponse);
    const data = routerResponse.data || fallbackResponse;

    const insightResult = {
      id: `insight_${Date.now()}`,
      journalId: resolvedJournalId,
      analysis: data.analysis || fallbackResponse.analysis,
      improvements: data.improvements || fallbackResponse.improvements,
      score: typeof data.score === 'number' ? data.score : fallbackResponse.score,
      createdAt: new Date().toISOString()
    };

    await journalInsightsRepo.save(insightResult);
    invalidateAiCoachCache();
    res.json(insightResult);
  } catch (error: any) {
    console.error("Error executing journal analysis:", error);
    res.status(500).json({ error: "Failed to compile journal intelligence analysis" });
  }
});

// GET Journal Analysis history
app.get("/api/journal-analysis", async (req, res) => {
  try {
    const list = await journalInsightsRepo.getAll();
    // sort by latest
    const sorted = list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    res.json(sorted);
  } catch (error: any) {
    console.error("Error retrieving journal insights:", error);
    res.status(500).json({ error: "Failed to fetch journal insights" });
  }
});




app.post("/api/focus_mission", async (req, res) => {
  const { sunTask, tasks, habits } = req.body;
  try {
    const sanitizedTasks = (tasks || []).map(sanitizeTask);
    const sanitizedHabits = (habits || []).map(sanitizeHabit);
    const topTask = sanitizedTasks.find((t: any) => t.id === sunTask) || sanitizedTasks[0];

    const prompt = `You are Orbit AI, an autonomous productivity coach.
Before the user enters a deep focus session, generate "Today's Focus Mission" (a short, impactful 1-3 sentence mission statement) based on:
Highest Priority Task: ${topTask ? topTask.title : "None"}
Upcoming Deadlines: ${sanitizedTasks.filter((t: any) => t.deadline).map((t: any) => t.title + ' due ' + t.deadline).join(', ') || 'None'}
Current Habits: ${sanitizedHabits.map((h: any) => h.title).join(', ') || 'None'}

Return a JSON with a single field "mission" containing the text.`;

    const schema = {
      type: Type.OBJECT,
      properties: { mission: { type: Type.STRING } },
      required: ["mission"]
    };
    
    const fallbackResponse = { mission: "Focus on your highest priority task and eliminate all distractions." };
    const routerResponse = await routeGenerativeRequest(prompt, schema, fallbackResponse);
    const data = routerResponse.data || fallbackResponse;
    res.json(data);
  } catch (error: any) {
    console.log("Focus mission generation error:", error);
    res.json({ mission: "Focus on your highest priority task and eliminate all distractions." });
  }
});

import { testOpenRouterConnection } from "./services/openRouterService";

export const aiProviderHealth: any = {
  gemini: { configured: false, healthy: false, latency: 0 },
  openrouter: { configured: false, healthy: false, latency: 0 },
  mistral: { configured: false, healthy: false, latency: 0 }
};

async function checkProviderHealth() {
  aiProviderHealth.gemini.configured = !!(process.env.GEMINI_API_KEY || process.env.USER_GEMINI_API_KEY);
  aiProviderHealth.openrouter.configured = !!process.env.OPENROUTER_API_KEY;
  aiProviderHealth.mistral.configured = !!process.env.MISTRAL_API_KEY;

  if (aiProviderHealth.gemini.configured) {
    const start = Date.now();
    try {
      const response = await routeGenerativeRequest(
        "Respond with a JSON object containing the status: 'OK'. Example: {\"status\": \"OK\"}",
        {
          type: Type.OBJECT,
          properties: { status: { type: Type.STRING } },
          required: ["status"]
        },
        { status: "OK" }
      );
      if (response.source === "gemini") {
        aiProviderHealth.gemini.healthy = true;
        aiProviderHealth.gemini.latency = Date.now() - start;
      }
    } catch(e) {}
  }
  
  if (aiProviderHealth.openrouter.configured) {
    const res = await testOpenRouterConnection();
    aiProviderHealth.openrouter.healthy = res.healthy;
    aiProviderHealth.openrouter.latency = res.latency;
  }

  if (aiProviderHealth.mistral.configured) {
    const start = Date.now();
    try {
      const mistralRes = await fetch("https://api.mistral.ai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.MISTRAL_API_KEY}`
        },
        body: JSON.stringify({
          model: "mistral-large-latest",
          response_format: { type: "json_object" },
          messages: [{ role: "user", content: "Respond with a JSON object containing the status: 'OK'. Example: {\"status\": \"OK\"}" }]
        })
      });
      if (mistralRes.ok) {
        const data: any = await mistralRes.json();
        if (data.choices && data.choices[0]?.message?.content) {
          aiProviderHealth.mistral.healthy = true;
          aiProviderHealth.mistral.latency = Date.now() - start;
        }
      }
    } catch(e) {}
  }
}

// Initial health check on startup
checkProviderHealth();

app.get("/api/health/ai", async (req, res) => {
  // optionally re-check if user adds key
  if (!aiProviderHealth.gemini.configured && !!(process.env.GEMINI_API_KEY || process.env.USER_GEMINI_API_KEY)) {
      await checkProviderHealth();
  }

  res.json({
    gemini: aiProviderHealth.gemini,
    openrouter: aiProviderHealth.openrouter,
    mistral: aiProviderHealth.mistral,
    routingPriority: [
      "Gemini",
      "OpenRouter",
      "Mistral",
      "Offline"
    ],
    usageMetrics: aiMetrics,
    healthMetrics: {
      status: aiMetrics.failures > 5 ? "degraded" : "healthy",
    }
  });
});

app.post("/api/health/ai/reset", (req, res) => {
  resetAiCooldowns();
  res.json({ success: true, message: "AI router cooldowns reset." });
});

// Central Deployment Monitoring Health Check Endpoint
app.get("/api/health", async (req, res) => {
  let dbStatus = "healthy";
  let aiStatus = "healthy";
  let authStatus = "healthy";

  // Check database health
  try {
    const start = Date.now();
    await userRepo.healthCheck();
    logger.recordDatabase("query", Date.now() - start, true);
  } catch (err: any) {
    dbStatus = "unhealthy";
    logger.recordDatabase("query", 0, false);
    logger.error("DATABASE", "Healthcheck database query failed", err);
  }

  // Check AI Router health
  if (aiMetrics.failures > 5) {
    aiStatus = "degraded";
  }

  res.json({
    status: (dbStatus === "healthy" && aiStatus === "healthy" && authStatus === "healthy") ? "healthy" : "degraded",
    database: dbStatus,
    aiRouter: aiStatus,
    auth: authStatus,
    observabilityMetrics: metricsRegistry
  });
});

// Main Prioritize AI Endpoint
app.post("/api/prioritize", async (req, res) => {
  const { tasks, habits } = req.body;

  if (!tasks || !Array.isArray(tasks)) {
    return res.status(400).json({ error: "Invalid task array payload" });
  }

  // If list is empty, return immediate empty array
  if (tasks.length === 0) {
    return res.json({
      sunTask: null,
      priorityReason: "No tasks found. Create tasks or habits below to construct your Orbit AI timeline.",
      rankedTasks: [],
    });
  }

  const currentDate = new Date().toISOString().split("T")[0];

  try {
    const prompt = `You are Orbit AI, a powerful, state-of-the-art productivity operating system scheduler.
Analyze the following list of tasks and habits and prioritize them intelligently based on deadline proximity (relative to today: ${currentDate}), theoretical workload (estimated effort/duration), importance level (high, medium, low), overdue status, habit impact, user productivity history, and task dependencies.

Current Date: ${currentDate}

List of Tasks:
${JSON.stringify(
  tasks.map((t) => ({
    id: t.id,
    title: t.title,
    deadline: t.deadline,
    importance: t.importance,
    duration: t.duration,
  })),
  null,
  2
)}

Habits:
${JSON.stringify(habits || [], null, 2)}

Determine:
1. "sunTask": The ID of the highest priority task right now. This is the absolute most important thing to focus on.
2. "priorityReason": A single concise sentence describing WHY this task was chosen as the sunTask.
3. "rankedTasks": The full array of task IDs, ordered by execution priority (from 1 to N).
   For each task in rankedTasks, determine:
   - id: The task id
   - priorityScore: An integer from 1 to 100 representing calculated execution urgency/leverage.
   - rank: Order sequence starting from 1.
   - optimalTime: Recommended focus block.
   - reasoning: A single concise sentence describing why this task has this specific scoring.
   - category: Classification tags.
   - isRescheduled: A boolean indicating if the AI decided to virtually "reschedule" this task to focus later.`;

    const schema = {
          type: Type.OBJECT,
          properties: {
            sunTask: { type: Type.STRING },
            priorityReason: { type: Type.STRING },
            rankedTasks: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  id: { type: Type.STRING },
                  priorityScore: { type: Type.INTEGER },
                  rank: { type: Type.INTEGER },
                  optimalTime: { type: Type.STRING },
                  reasoning: { type: Type.STRING },
                  category: { type: Type.STRING },
                  isRescheduled: { type: Type.BOOLEAN }
                },
                required: ["id", "priorityScore", "rank", "optimalTime", "reasoning", "category"],
              },
            },
          },
          required: ["sunTask", "priorityReason", "rankedTasks"],
        };

    const fallbackResponse = {
      sunTask: tasks.length > 0 ? tasks[0].id : null,
      priorityReason: "Fallback Prioritization Mode",
      rankedTasks: []
    };

    const routerResponse = await routeGenerativeRequest(prompt, schema, fallbackResponse);
    const resultObj = routerResponse.data || {};

    return res.json({
      sunTask: resultObj.sunTask || tasks[0].id,
      priorityReason: resultObj.priorityReason || "Focus on high-leverage tasks.",
      rankedTasks: resultObj.rankedTasks || [],
    });
  } catch (error: any) {
    console.log("Gemini API Error, executing baseline heuristic system:", error.message);

    // Baseline fallback prioritisaton engine using classic scheduling heuristics
    const sortedTasks = [...tasks].sort((a, b) => {
      // 1. Sort by importance hierarchy
      const impVal = { high: 3, medium: 2, low: 1 };
      const valA = impVal[a.importance] || 2;
      const valB = impVal[b.importance] || 2;
      const diffImp = valB - valA;
      if (diffImp !== 0) return diffImp;

      // 2. Sort by closer deadline
      const dateA = a.deadline ? new Date(a.deadline).getTime() : Infinity;
      const dateB = b.deadline ? new Date(b.deadline).getTime() : Infinity;
      const validA = isNaN(dateA) ? Infinity : dateA;
      const validB = isNaN(dateB) ? Infinity : dateB;
      if (validA === Infinity && validB === Infinity) return 0;
      return validA - validB;
    });

    const prioritizedTasks = sortedTasks.map((task, index) => {
      const impMultiplier = { high: 90, medium: 60, low: 30 }[task.importance] || 30;
      const durationAdjustment = Math.min((task.duration || 0) / 10, 10);
      const score = Math.max(10, Math.min(100, Math.round(impMultiplier + durationAdjustment - index * 5)));
      
      let optimalTime = "Peak Energy Window";
      if (task.importance === "high") {
        optimalTime = "Early Morning Prime Focus";
      } else if (task.importance === "medium" && task.duration > 45) {
        optimalTime = "Late Morning Focus Block";
      } else if (task.duration <= 20) {
        optimalTime = "Immediate Quick Win";
      } else {
        optimalTime = "Low-Cognitive Afternoon Admin";
      }

      let category = "Deep Focus";
      if (task.duration <= 15) {
        category = "Quick Win";
      } else if (task.importance === "high") {
        category = "Critical Path";
      } else if (task.importance === "low") {
        category = "Routine/Admin";
      }

      return {
        id: task.id,
        priorityScore: score,
        rank: index + 1,
        optimalTime,
        reasoning: `Prioritized via local heuristic criteria using deadline schedule proximity and importance (${task.importance}).`,
        category,
        isRescheduled: false
      };
    });

    const isMissingKey = error.message.includes("GEMINI_API_KEY is not configured");
    const directive = isMissingKey 
      ? "Executing offline heuristic scheduler mode. Configure GEMINI_API_KEY in Secrets for smart AI prioritization."
      : "Gemini AI is temporarily unavailable (high demand). Using offline heuristic scheduler mode.";
    
    return res.json({
      sunTask: sortedTasks.length > 0 ? sortedTasks[0].id : null,
      priorityReason: directive,
      rankedTasks: prioritizedTasks,
      isFallback: true,
      fallbackMessage: error.message,
    });
  }
});

// Breakdown Task Endpoint
app.post("/api/breakdown", async (req, res) => {
  const { title, description } = req.body;
  if (!title || typeof title !== 'string' || title.trim() === '') {
    return res.status(400).json({ error: "Task title required" });
  }

  const safeTitle = title.substring(0, 200);
  const safeDesc = description ? description.substring(0, 1000) : "No description provided";

  try {
    const prompt = `Break down the following task into 3 to 7 actionable, logically ordered subtasks.
Task: ${safeTitle}
Description: ${safeDesc}

Output a JSON array of strings representing the subtask titles.`;

    const schema = {
          type: Type.ARRAY,
          items: { type: Type.STRING }
        };
    const fallbackResponse = [
        "Review requirements for the task",
        "Set up initial structure",
        "Execute core functionality",
        "Test and finalize"
    ];
    const routerResponse = await routeGenerativeRequest(prompt, schema, fallbackResponse);
    const subtasks = routerResponse.data || fallbackResponse;
    return res.json({ subtasks });
  } catch (error: any) {
    console.log("Breakdown API error:", error.message);
    // Graceful fallback
    return res.json({
      subtasks: [
        "Review requirements for the task",
        "Set up initial structure",
        "Execute core functionality",
        "Test and finalize"
      ]
    });
  }
});

// Plan My Day Endpoint
app.post("/api/plan-day", validate(planRequestSchema), async (req, res) => {
  const { tasks, habits } = req.body;
  const currentDate = new Date().toISOString().split("T")[0];

  try {
    const sanitizedTasks = (tasks || []).map(sanitizeTask);
    const sanitizedHabits = (habits || []).map(sanitizeHabit);

    const prompt = `You are Orbit AI, an autonomous productivity assistant.
Create a complete daily schedule for ${currentDate} based on the given tasks and habits.
Include time blocking, break allocation, habit integration, deadline awareness, and priority awareness.
Assign a start and end time (HH:mm format) for each event.
Generate exactly 3 smart productivity insights reflecting on the user's workload, habit adherence, and priorities.
Calculate a Daily Productivity Score (0-100) based on completed tasks, habits, and focus consistency, and a trend (Improving, Stable, Declining).

Tasks: ${JSON.stringify(sanitizedTasks, null, 2)}
Habits: ${JSON.stringify(sanitizedHabits, null, 2)}
`;

    const schema = {
          type: Type.OBJECT,
          properties: {
            events: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  id: { type: Type.STRING },
                  startTime: { type: Type.STRING },
                  endTime: { type: Type.STRING },
                  title: { type: Type.STRING },
                  type: { type: Type.STRING, enum: ["Task", "Habit", "Break"] },
                  referenceId: { type: Type.STRING }
                },
                required: ["id", "startTime", "endTime", "title", "type"]
              }
            },
            insights: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
              description: "Exactly 3 smart productivity insights."
            },
            productivityScore: { type: Type.INTEGER },
            productivityTrend: { type: Type.STRING, enum: ["Improving", "Stable", "Declining"] }
          },
          required: ["events", "insights", "productivityScore", "productivityTrend"]
        };
    
    const fallbackResponse = {
      events: [],
      insights: ["You have a balanced workload today.", "Make sure to take breaks.", "Stay consistent with your habits."],
      productivityScore: 75,
      productivityTrend: "Stable"
    };

    const routerResponse = await routeGenerativeRequest(prompt, schema, fallbackResponse);
    const output = routerResponse.data || fallbackResponse;
    const planResult = {
      date: currentDate,
      events: output.events || [],
      insights: output.insights || ["You have a balanced workload today.", "Make sure to take breaks.", "Stay consistent with your habits."],
      productivityScore: output.productivityScore || 75,
      productivityTrend: output.productivityTrend || "Stable"
    };
    
    try {
      await dailyPlanRepo.save(planResult);
    } catch (e) {
      console.error("Failed to persist daily plan:", e);
    }

    return res.json(planResult);
  } catch (error: any) {
    console.log("Plan Day API error:", error.message);
    // Graceful fallback
    return res.json({
      date: currentDate,
      events: [],
      insights: ["You have a balanced workload today.", "Make sure to take breaks.", "Stay consistent with your habits."],
      productivityScore: 75,
      productivityTrend: "Stable"
    });
  }
});

// GET Daily Plan Endpoint
app.get("/api/daily-plan", async (req, res) => {
  try {
    const latestPlan = await dailyPlanRepo.getLatest();
    res.json({ plan: latestPlan });
  } catch (error: any) {
    console.error("Error fetching daily plan:", error);
    res.status(500).json({ error: "Failed to fetch daily plan" });
  }
});

// AI Coach Endpoint
app.post("/api/coach", validate(coachRequestSchema), async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === 'true';
    const now = Date.now();
    // Cache recommendations for 4 hours (4 * 60 * 60 * 1000)
    if (!forceRefresh && aiCoachCache.data && now - aiCoachCache.timestamp < 14400000) {
      return res.json(aiCoachCache.data);
    }

    const tasksData = await taskRepo.getRecent(14);
    const habitsData = await habitRepo.getActive();
    const userProfile = await userProfileSummaryRepo.get();
    
    // Server-side Aggregation
    const completedTasks = tasksData.filter(t => t.completed).length;
    const taskCompletionRate = tasksData.length ? Math.round((completedTasks / tasksData.length) * 100) : 0;
    
    let activeHabits = habitsData.length;
    let habitStreaks = habitsData.map(h => h.streak);
    let avgHabitStreak = habitStreaks.length ? Math.round(habitStreaks.reduce((a,b)=>a+b,0) / habitStreaks.length) : 0;

    const summary = {
      taskCompletionRate,
      activeTasks: tasksData.length - completedTasks,
      activeHabits,
      avgHabitStreak
    };

    const prompt = `You are Orbit AI, a world-class productivity coach.
Analyze the following workload summary and habits. Provide 1 personalized motivational message, 1 concrete recommendation, and an observation about workload or habits.

Workload Summary (Last 14 days): ${JSON.stringify(summary, null, 2)}
Habits: ${JSON.stringify(habitsData.map(h => ({title: h.title, streak: h.streak})), null, 2)}
Long-term User Profile Summary: ${userProfile ? JSON.stringify(userProfile, null, 2) : "Not enough data yet."}
`;

    const schema = {
          type: Type.OBJECT,
          properties: {
            motivation: { type: Type.STRING },
            recommendation: { type: Type.STRING },
            observation: { type: Type.STRING }
          },
          required: ["motivation", "recommendation", "observation"]
        };
        
    const fallbackResponse = {
      motivation: "Keep going! Even small steps move you forward.",
      recommendation: "Focus on your highest priority task first.",
      observation: "You have a solid plan. Consistency is key."
    };

    const routerResponse = await routeGenerativeRequest(prompt, schema, fallbackResponse);
    const output = routerResponse.data || fallbackResponse;
    aiCoachCache.timestamp = Date.now();
    aiCoachCache.data = output;
    return res.json(output);
  } catch (error: any) {
    console.log("AI Coach API error:", error.message);
    // Graceful fallback
    return res.json({
      motivation: "Keep going! Even small steps move you forward.",
      recommendation: "Focus on your highest priority task first.",
      observation: "You have a solid plan. Consistency is key."
    });
  }
});

// Reflection Engine Endpoint
app.post("/api/reflection", validate(reflectionRequestSchema), async (req, res) => {
  const { tasks, habits, dailyPlan, journalEntry } = req.body;
  
  if (!tasks || !habits) {
    return res.status(400).json({ error: "Missing required productivity data" });
  }

  try {
    const sanitizedTasks = (tasks || []).slice(0, 50).map(sanitizeTask);
    const sanitizedHabits = (habits || []).slice(0, 20).map(sanitizeHabit);
    const safeJournal = journalEntry && typeof journalEntry === 'string' ? journalEntry.substring(0, 2000) : journalEntry;
    const sanitizedJournal = sanitizeJournal(safeJournal);

    const prompt = `You are the Orbit AI Reflection Engine.
Your purpose is to deeply analyze the user's productivity data, compare planned vs completed tasks, analyze habit consistency, read journal entries, and generate highly personalized insights.

Inputs:
- Tasks: ${JSON.stringify(sanitizedTasks)}
- Habits: ${JSON.stringify(sanitizedHabits)}
- Daily Plan: ${JSON.stringify(dailyPlan)}
- Journal Entry: ${JSON.stringify(sanitizedJournal || "No entry")}

Special Rules:
- Calculate Completion Rate carefully (can be > 100% if they did extra work not originally planned or finished tasks very fast).
- If completion rate > 100%: Celebrate achievement, calculate schedule acceleration, and show benefits of extra work.
- If completion rate < 70%: Identify causes, analyze journal for clues, suggest specific improvements, avoid generic advice.
- Use actual task and journal history. NO GENERIC ADVICE. Be extremely specific.
- Output ONLY valid JSON matching this schema:
{
  "completionRate": 85,
  "habitConsistency": 90,
  "focusScore": 80,
  "momentumScore": 88,
  "missedWork": 1,
  "extraWork": 0,
  "dailyReflection": "A detailed reflection of the day based on the journal and tasks...",
  "performanceAnalysis": "Detailed analysis...",
  "improvementSuggestions": ["Specific suggestion 1", "Specific suggestion 2"],
  "personalizedCoaching": "Direct coaching advice...",
  "positiveReinforcement": "A specific positive reinforcement...",
  "futurePlanningSuggestions": ["Suggestion for tomorrow 1"],
  "distractionPatterns": ["identified pattern 1"],
  "energyPatterns": ["identified pattern 1"],
  "weeklyTrends": "Overall weekly observation..."
}

Do not include markdown blocks, just raw JSON.`;

    // No strict schema needed here for reflection as per prompt, but we should define it for router if required, or let it pass null.
    // However, Gemini structure is requested as valid JSON.
    const fallbackResponse = {
      completionRate: 85,
      habitConsistency: 90,
      focusScore: 80,
      momentumScore: 88,
      missedWork: 0,
      extraWork: 0,
      dailyReflection: "A solid day of productivity.",
      performanceAnalysis: "Fallback analysis due to API limits.",
      improvementSuggestions: ["Keep it up"],
      personalizedCoaching: "You are doing great.",
      positiveReinforcement: "Good job!",
      futurePlanningSuggestions: ["Plan tomorrow today"],
      distractionPatterns: [],
      energyPatterns: [],
      weeklyTrends: "Stable"
    };
    
    // We pass null for schema to allow freeform json
    const routerResponse = await routeGenerativeRequest(prompt, null, fallbackResponse);
    const data = routerResponse.data || fallbackResponse;
    
    try {
      // make sure date is attached
      if (!data.date) {
        data.date = new Date().toISOString().split('T')[0];
      }
      await reflectionRepo.save(data);
      invalidateAiCoachCache();
    } catch (e) {
      console.error("Failed to persist reflection:", e);
    }

    res.json({ reflection: data });
  } catch (error: any) {
    console.log("Reflection Generation Error:", error);
    res.status(500).json({ error: "Failed to generate reflection." });
  }
});

// GET historical reflections
app.get("/api/reflection", async (req, res) => {
  try {
    const list = await reflectionRepo.getAll();
    res.json({ reflections: list });
  } catch (error) {
    console.error("Error fetching reflections:", error);
    res.status(500).json({ error: "Failed to fetch reflections" });
  }
});

// Natural Language Commands Endpoint
app.post("/api/command", async (req, res) => {
  const { command, history, context } = req.body;
  if (!command || typeof command !== 'string' || command.trim() === '') {
    return res.json({
      action: "UNKNOWN",
      payload: {},
      responseMessage: "Please provide a command.",
      confidence: 1.0,
      debug: { source: "validation" }
    });
  }

  try {
    // Phase 5.5: Try rule engine first for deterministic intents
    const ruleEngineResult = parseWithRuleEngine(command, context);
    if (ruleEngineResult) {
      console.log("[Command] Using Rule Engine for deterministic intent:", ruleEngineResult.intent);
      return res.json({
        action: ruleEngineResult.intent,
        payload: ruleEngineResult.action || {},
        responseMessage: ruleEngineResult.response,
        confidence: ruleEngineResult.confidence,
        debug: { source: "rule_engine" }
      });
    }

    const safeHistory = Array.isArray(history) ? history.slice(-5) : [];
    const safeCommand = command.substring(0, 500);
    const safeContext = context ? { ...context, currentTasks: (context.currentTasks || []).slice(0, 20) } : {};

    const prompt = `You are Orbit AI. You are not a chatbot. You are an autonomous productivity operating system.
Your responsibility:
- understand user intent
- extract structured data
- return executable JSON
- use provided memory context

Never answer casually. Always prioritize execution. Always identify the intended action. Always return valid JSON. No markdown. No explanations. No natural language outside JSON.

Recent Conversation History: ${JSON.stringify(safeHistory, null, 2)}
User Command: "${safeCommand}"
Context: ${JSON.stringify(safeContext, null, 2)}

Supported Intents:
- ADD_TASK (requires title, optionally deadline, duration, priority)
- ADD_HABIT (requires title)
- COMPLETE_TASK (requires id of the task from Context)
- DELETE_TASK (requires id of the task from Context)
- UPDATE_TASK (requires id of the task from Context, plus fields to update)
- PLAN_DAY
- REPRIORITIZE
- BREAKDOWN_TASK (requires id of the task from Context)
- FOCUS_NOW
- GET_COACHING
- SHOW_PROGRESS
- UNKNOWN

For every intent extract only the fields the user explicitly mentions: title, deadline, duration, priority, habit_name, id when available, AND PUT THEM IN THE 'action' object. You MUST provide 'id' for COMPLETE_TASK, DELETE_TASK, UPDATE_TASK, and BREAKDOWN_TASK by matching the task from Context. DO NOT generate dummy or placeholder values (like 'hiblocks-dummy-title...') for any field. If a field is not explicitly provided by the user, omit it from the 'action' object entirely.

Resolve pronouns (it, that, them) using the provided Conversation History and Context (especially context.memory.lastTask).

Return a JSON strictly following this schema. Do NOT return markdown formatting:
{
  "intent": "...", 
  "confidence": 0.0, 
  "entities": { ... }, 
  "action": { ... }, 
  "response": "..."
}`;

    const schema = {
          type: Type.OBJECT,
          properties: {
            intent: { type: Type.STRING },
            confidence: { type: Type.NUMBER },
            entities: { type: Type.OBJECT },
            action: { 
              type: Type.OBJECT,
              properties: {
                title: { type: Type.STRING },
                deadline: { type: Type.STRING },
                duration: { type: Type.NUMBER },
                priority: { type: Type.STRING },
                habit_name: { type: Type.STRING },
                id: { type: Type.STRING }
              }
            },
            response: { type: Type.STRING }
          },
          required: ["intent", "confidence", "entities", "action", "response"]
        };
    const fallbackResponse = {
      intent: "UNKNOWN",
      confidence: 1.0,
      entities: {},
      action: {},
      response: "AI services are currently offline. Please use standard UI controls."
    };
    
    const routerResponse = await routeGenerativeRequest(prompt, schema, fallbackResponse);
    const output = routerResponse.data || {};
    
    // Ensure output.response is a string
    let responseText = output.response;
    if (typeof responseText === 'object' && responseText !== null) {
      responseText = responseText.message || responseText.response || JSON.stringify(responseText);
    }
    
    let finalIntent = output.intent;
    let finalPayload = (output.action && Object.keys(output.action).length > 0) ? output.action : (output.entities || {});
    let finalResponse = responseText;

    const isBlockedForAddTask = (cmd: string) => {
      const norm = cmd.toLowerCase();
      return norm.includes("complete") || 
             norm.includes("finish") || 
             norm.includes("done") || 
             norm.includes("mark completed") || 
             norm.includes("mark done") ||
             norm.includes("completed");
    };

    if (finalIntent === "ADD_TASK" && isBlockedForAddTask(command)) {
      console.log("[Validation Layer] Blocked ADD_TASK intent because input contains completion keywords. Re-running classifier.");
      const normalizedCmd = command.toLowerCase().trim();
      const completeAllPhrases = [
        "complete all tasks",
        "complete every task",
        "finish all tasks",
        "finish every task",
        "mark all tasks completed",
        "mark all tasks done",
        "mark everything done",
        "complete today's tasks",
        "finish today's tasks",
        "mark every task done"
      ];
      const isAll = completeAllPhrases.some(phrase => normalizedCmd.includes(phrase)) || 
                    /complete\s+(all\s+tasks|every\s+task|everything|today's\s+tasks)/i.test(normalizedCmd) ||
                    /finish\s+(all\s+tasks|every\s+task|everything|today's\s+tasks)/i.test(normalizedCmd) ||
                    /mark\s+(all\s+tasks|every\s+task|everything)\s+(completed|done)/i.test(normalizedCmd);

      if (isAll) {
        finalIntent = "COMPLETE_ALL_TASKS";
        finalPayload = {};
        finalResponse = "I have marked all of today's tasks as completed.";
      } else {
        let titleFragment = normalizedCmd
          .replace(/^(mark|complete|finish|i finished|i completed|i've finished|the|i've|i|mark task|complete task|finish task)\b/gi, "")
          .replace(/\b(is|done|as|complete|finished|completed|task)\b/gi, "")
          .trim();
        
        let matchedId = undefined;
        const currentTasks = context?.currentTasks || context?.tasks;
        if (currentTasks) {
          const cleanFrag = titleFragment.replace(/^(the|a|an)\s+/i, '').replace(/\b(task|is|done|finished)\b/gi, '').trim();
          if (cleanFrag) {
            const exactMatch = currentTasks.find((t: any) => t.title.toLowerCase() === cleanFrag);
            if (exactMatch) matchedId = exactMatch.id;
            else {
              const partialMatch = currentTasks.find((t: any) => t.title.toLowerCase().includes(cleanFrag) || cleanFrag.includes(t.title.toLowerCase()));
              if (partialMatch) matchedId = partialMatch.id;
            }
          }
        }

        finalIntent = "COMPLETE_TASK";
        finalPayload = { id: matchedId, title: titleFragment || normalizedCmd };
        finalResponse = matchedId ? `Marked task as complete.` : `Which task would you like to mark as complete?`;
      }
    }

    // Low confidence threshold handling (only apply if not overridden by validation layer)
    if (output.confidence < 0.70 && finalIntent === output.intent) {
      return res.json({
        action: "UNKNOWN",
        payload: {},
        responseMessage: responseText || "I'm not completely sure what you mean. Could you clarify?",
        debug: output
      });
    }

    return res.json({
      action: finalIntent,
      payload: finalPayload,
      responseMessage: finalResponse,
      confidence: output.confidence,
      debug: output
    });
  } catch (error: any) {
    console.log("AI Command API error:", error);
    // Graceful fallback
    return res.json({
      action: "UNKNOWN",
      payload: {},
      responseMessage: "I couldn't understand that request. Could you rephrase it?",
      fullError: error.message || String(error)
    });
  }
});

import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import { Modality, LiveServerMessage } from "@google/genai";
import { getAiClient } from "./services/geminiService";

async function startServer() {
  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    console.log("WebSocket upgrade request:", request.url);
    if (request.url === '/live') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    }
  });

  wss.on("connection", async (clientWs: WebSocket) => {
    try {
      const ai = getAiClient();
      const session = await ai.live.connect({
        model: "gemini-2.0-flash-exp",
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } },
          },
          systemInstruction: {
            parts: [{ text: "You are Orbit AI, an autonomous productivity OS assistant. You control the user's dashboard. Use the provided tools to add tasks, complete tasks, or take other actions when requested by the user." }]
          },
          tools: [{
            functionDeclarations: [
              {
                name: "execute_action",
                description: "Execute an action on the user's productivity dashboard.",
                parameters: {
                  type: Type.OBJECT,
                  properties: {
                    action: {
                      type: Type.STRING,
                      description: "The action to perform. Valid options: ADD_TASK, COMPLETE_TASK, DELETE_TASK, PLAN_DAY, REPRIORITIZE."
                    },
                    payload: {
                      type: Type.OBJECT,
                      description: "The payload for the action. For ADD_TASK, must include 'title' (string), and optionally 'deadline', 'priority', 'duration'. For COMPLETE_TASK and DELETE_TASK, must include 'title' matching a known task."
                    }
                  },
                  required: ["action", "payload"]
                }
              }
            ]
          }]
        },
        callbacks: {
          onmessage: (message: LiveServerMessage) => {
            const audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (audio) {
              clientWs.send(JSON.stringify({ audio }));
            }
            if (message.serverContent?.interrupted) {
              clientWs.send(JSON.stringify({ interrupted: true }));
            }
            if (message.toolCall) {
              const calls = message.toolCall.functionCalls;
              if (calls && calls.length > 0) {
                const functionResponses: any[] = [];
                for (const call of calls) {
                  if (call.name === "execute_action") {
                    const args = call.args;
                    clientWs.send(JSON.stringify({ toolCall: args }));
                    functionResponses.push({
                      id: call.id,
                      name: call.name,
                      response: { result: "Success" }
                    });
                  }
                }
                session.sendToolResponse({ functionResponses });
              }
            }
          },
        },
      });

      clientWs.on("message", (data) => {
        try {
          const { audio } = JSON.parse(data.toString());
          if (audio) {
            session.sendRealtimeInput({
              media: {
                mimeType: "audio/pcm;rate=16000",
                data: audio
              }
            });
          }
        } catch (e) {
          console.log("Error parsing WS message:", e);
        }
      });

      clientWs.on("close", () => {
        // @ts-ignore
        if (session && session.close) session.close();
      });

    } catch (e) {
      console.log("Live API connection failed", e);
      clientWs.close();
    }
  });

  // --- SMART REMINDER ENDPOINTS ---

  app.post("/api/reminders/briefing", validate(briefingRequestSchema), async (req, res) => {
    try {
      const { tasks, dailyPlan } = req.body;
      const sanitizedTasks = tasks.map(sanitizeTask);
      
      const todayTasks = sanitizedTasks.filter((t: any) => !t.completed && new Date(t.deadline).toDateString() === new Date().toDateString());
      const topTask = todayTasks.length > 0 ? todayTasks.reduce((prev: any, current: any) => 
        ((current.aiPriorityScore || 0) > (prev.aiPriorityScore || 0)) ? current : prev
      ) : null;
      
      const prompt = `
You are Orbit AI Coach.
Generate a morning briefing for the user.

Tasks today: ${todayTasks.length}
Most important task: ${topTask ? topTask.title : 'None scheduled'}

Generate a short motivational reminder under 50 words.
Include:
- today's top priority
- estimated workload
- risk areas

Return plain text only.`;

      const routerResponse = await routeGenerativeRequest(prompt, null, "Good morning. Let's focus on your priorities today.");
      const message = routerResponse.data?.response || (typeof routerResponse.data === 'string' ? routerResponse.data : null) || "Good morning. You have items to review in Orbit.";
      
      try {
        await reminderRepo.save({ type: 'morning_briefing', sentAt: new Date().toISOString() });
      } catch (e) {
        console.error("Failed to persist reminder:", e);
      }

      res.json({ message });
    } catch (error) {
      res.status(500).json({ error: "Failed to generate briefing" });
    }
  });

  app.post("/api/reminders/review", validate(reviewRequestSchema), async (req, res) => {
    try {
      const { tasks, habits } = req.body;
      const sanitizedTasks = tasks.map(sanitizeTask);
      
      const todayString = new Date().toISOString().split('T')[0];
      const completedTasks = sanitizedTasks.filter((t: any) => t.completed && t.completedAt?.startsWith(todayString)).length;
      const pendingTasks = sanitizedTasks.filter((t: any) => !t.completed).length;
      
      const prompt = `
You are Orbit AI Coach.
Generate an evening review for the user.

Tasks completed today: ${completedTasks}
Remaining tasks: ${pendingTasks}

Generate a short motivational reminder under 50 words.
Include:
- Achievements
- Misses
- Recommendations

Return plain text only.`;

      const routerResponse = await routeGenerativeRequest(prompt, null, "Evening review: Good work today, let's prepare for tomorrow.");
      const message = routerResponse.data?.response || (typeof routerResponse.data === 'string' ? routerResponse.data : null) || "Good evening. Don't forget to reflect on today's progress.";
      
      try {
        await reminderRepo.save({ type: 'evening_review', sentAt: new Date().toISOString() });
      } catch (e) {
        console.error("Failed to persist reminder:", e);
      }

      res.json({ message });
    } catch (error) {
      res.status(500).json({ error: "Failed to generate review" });
    }
  });

  app.post("/api/reminders/task", validate(taskReminderRequestSchema), async (req, res) => {
    try {
      const { task, isOverdue } = req.body;
      const sanitizedTask = sanitizeTask(task);
      
      const prompt = `
You are Orbit AI Coach.

Task: ${sanitizedTask.title}
Deadline: ${sanitizedTask.deadline}
Status: ${isOverdue ? 'OVERDUE' : 'UPCOMING'}

Generate a short motivational reminder under 50 words.
Include:
- urgency
- benefit of completion
- recovery suggestion if missed (if overdue)

Return plain text only.`;

      const routerResponse = await routeGenerativeRequest(prompt, null, isOverdue ? `Task ${sanitizedTask.title} is overdue.` : `Task ${sanitizedTask.title} is coming up.`);
      const message = routerResponse.data?.response || (typeof routerResponse.data === 'string' ? routerResponse.data : null) || (isOverdue ? `Your task ${sanitizedTask.title} is overdue.` : `Reminder: ${sanitizedTask.title} is due soon.`);
      
      try {
        await reminderRepo.save({ taskId: sanitizedTask.id, type: isOverdue ? 'task_overdue' : 'task_upcoming', sentAt: new Date().toISOString() });
      } catch (e) {
        console.error("Failed to persist reminder:", e);
      }

      res.json({ message });
    } catch (error) {
      res.status(500).json({ error: "Failed to generate task reminder" });
    }
  });

  // General API error handling middleware to ensure we always return JSON error structures
  app.use("/api", (err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error("Unhandled API error:", err);
    res.status(500).json({
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: err.message || "An unexpected error occurred in Orbit backend API"
      }
    });
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`[Orbit AI] Server running smoothly at http://localhost:${PORT}`);
    const activeDbMode = process.env.DATABASE_MODE === 'json' ? 'JSON (Development Fallback)' : 'PostgreSQL (Drizzle ORM)';
    console.log(`[DATABASE] Active Persistence Provider: ${activeDbMode}`);
    console.log(`[DATABASE] Drizzle ORM Initialized Successfully.`);
    if (process.env.DATABASE_MODE !== 'json') {
      console.log(`[DATABASE] PostgreSQL Connection Target: ${process.env.SQL_HOST || 'Not Configured'}`);
    }
  });
}

startServer();
