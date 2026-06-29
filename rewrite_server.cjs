const fs = require('fs');

let content = fs.readFileSync('server.ts', 'utf8');

// 1. Import router
content = content.replace(
  'import { retryGenerateContent } from "./services/geminiService";',
  'import { retryGenerateContent } from "./services/geminiService";\nimport { routeGenerativeRequest, parseWithRuleEngine, aiMetrics } from "./services/aiRouter";'
);

// 2. Add AI Health endpoint
const healthEndpoint = `
app.get("/api/health/ai", (req, res) => {
  res.json({
    metrics: aiMetrics,
    status: aiMetrics.failures > 5 ? "degraded" : "healthy",
    primaryModel: "gemini-1.5-flash",
    secondaryModel: "mistral-large-latest"
  });
});

`;
content = content.replace('// Main Prioritize AI Endpoint', healthEndpoint + '// Main Prioritize AI Endpoint');

// 3. Command API routing logic
const commandStart = `// Natural Language Commands Endpoint
app.post("/api/command", async (req, res) => {
  const { command, history, context } = req.body;
  try {
    // Phase 5.5: Try rule engine first for deterministic intents
    const ruleEngineResult = parseWithRuleEngine(command);
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

    const prompt = \`You are Orbit AI. You are not a chatbot. You are an autonomous productivity operating system.`;

content = content.replace(
  '// Natural Language Commands Endpoint\napp.post("/api/command", async (req, res) => {\n  const { command, history, context } = req.body;\n  try {\n    const prompt = `You are Orbit AI. You are not a chatbot. You are an autonomous productivity operating system.',
  commandStart
);

// Replace /api/command retryGenerateContent with routeGenerativeRequest
content = content.replace(
  `const response = await retryGenerateContent({
      model: "gemini-1.5-flash",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
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
        }
      }
    });

    const output = JSON.parse(response.text?.trim() || "{}");`,
  `const schema = {
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
    const output = routerResponse.data || {};`
);

// Update Prioritize endpoint
content = content.replace(
  `const response = await retryGenerateContent({
      model: "gemini-1.5-flash",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
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
        },
      },
    });

    const textOutput = response.text?.trim() || "{}";
    const resultObj = JSON.parse(textOutput);`,
  `const schema = {
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
    const resultObj = routerResponse.data || {};`
);

// Breakdown Endpoint
content = content.replace(
  `const response = await retryGenerateContent({
      model: "gemini-1.5-flash",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: { type: Type.STRING }
        }
      }
    });

    const subtasks = JSON.parse(response.text?.trim() || "[]");`,
  `const schema = {
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
    const subtasks = routerResponse.data || fallbackResponse;`
);

// Plan Day Endpoint
content = content.replace(
  `const response = await retryGenerateContent({
      model: "gemini-1.5-flash",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
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
        }
      }
    });

    const output = JSON.parse(response.text?.trim() || "{}");`,
  `const schema = {
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
    const output = routerResponse.data || fallbackResponse;`
);

// Coach Endpoint
content = content.replace(
  `const response = await retryGenerateContent({
      model: "gemini-1.5-flash",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            motivation: { type: Type.STRING },
            recommendation: { type: Type.STRING },
            observation: { type: Type.STRING }
          },
          required: ["motivation", "recommendation", "observation"]
        }
      }
    });

    const output = JSON.parse(response.text?.trim() || "{}");`,
  `const schema = {
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
    const output = routerResponse.data || fallbackResponse;`
);

// Reflection Endpoint
content = content.replace(
  `const response = await retryGenerateContent({
      model: "gemini-1.5-flash",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
      }
    });

    const data = JSON.parse(response);`,
  `// No strict schema needed here for reflection as per prompt, but we should define it for router if required, or let it pass null.
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
    const data = routerResponse.data || fallbackResponse;`
);

fs.writeFileSync('server.ts', content);
console.log('Server re-written successfully');
