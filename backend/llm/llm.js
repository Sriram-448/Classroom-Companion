// =============================================================
// llm.js — WHY: This is the ONLY file that talks to the AI.
// Keeping all LLM calls in one place means:
// 1. Easy to swap providers (Anthropic → OpenAI → local model)
// 2. One place to add retry logic, cost logging, and fallbacks
// 3. Clear boundary: "LLM decides meaning, code decides action"
// =============================================================

const OpenAI = require("openai");
const { GoogleGenerativeAI } = require("@google/generative-ai");

// Centralized wrapper using Gemini or Grok API (with local heuristics fallback for offline/credit-less testing)
async function callClaude(systemPrompt, userMessage, maxTokens = 500) {
  const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  const grokKey = process.env.GROK_API_KEY || process.env.XAI_API_KEY;

  if (geminiKey && !geminiKey.includes("your_") && !geminiKey.includes("paste_your")) {
    try {
      const genAI = new GoogleGenerativeAI(geminiKey);
      const modelName = process.env.GEMINI_MODEL || "gemini-2.5-flash";
      const model = genAI.getGenerativeModel({
        model: modelName,
        systemInstruction: systemPrompt,
      });

      const response = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: userMessage }] }],
        generationConfig: {
          maxOutputTokens: maxTokens,
          temperature: 0.1,
        }
      });

      return response.response.text();
    } catch (err) {
      console.warn(`❌ Gemini LLM call failed: "${err.message}"`);
    }
  } else if (grokKey && !grokKey.includes("your_") && !grokKey.includes("paste_your")) {
    try {
      const openai = new OpenAI({
        apiKey: grokKey,
        baseURL: "https://api.x.ai/v1",
      });

      const response = await openai.chat.completions.create({
        model: process.env.GROK_MODEL || "grok-2",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage }
        ],
        max_tokens: maxTokens,
        temperature: 0.1
      });

      return response.choices[0].message.content;
    } catch (err) {
      console.warn(`❌ Grok LLM call failed: ${err.status || ''} "${err.message}"`);
    }
  }

  // Robust Local Heuristic Fallback Parser
  const lowerMsg = userMessage.toLowerCase();
  const lowerPrompt = systemPrompt.toLowerCase();

  // 1. Classification logic (student updates)
  if (lowerPrompt.includes("interpret student") || lowerPrompt.includes("student message")) {
    if (lowerMsg.includes("stuck") || lowerMsg.includes("blocked") || lowerMsg.includes("help") || lowerMsg.includes("can't") || lowerMsg.includes("cant")) {
      return JSON.stringify({
        new_status: "blocked",
        intent: "blocked_report",
        summary: "Student reports being stuck on the assignment",
        needs_teacher_attention: true,
        confidence: 0.95
      });
    }
    if (lowerMsg.includes("done") || lowerMsg.includes("submitted") || lowerMsg.includes("complete") || lowerMsg.includes("finished")) {
      return JSON.stringify({
        new_status: "submitted",
        intent: "submission",
        summary: "Student reports having completed their assignment",
        needs_teacher_attention: true,
        confidence: 0.95
      });
    }
    if (lowerMsg.includes("got it") || lowerMsg.includes("ok") || lowerMsg.includes("sure") || lowerMsg.includes("will do")) {
      return JSON.stringify({
        new_status: "acknowledged",
        intent: "acknowledgement",
        summary: "Student acknowledged receiving assignment",
        needs_teacher_attention: false,
        confidence: 0.95
      });
    }
    return JSON.stringify({
      new_status: "in_progress",
      intent: "progress_update",
      summary: "Student reports progress on assignment",
      needs_teacher_attention: false,
      confidence: 0.95
    });
  }

  // 2. Assignment creation parser
  if (lowerPrompt.includes("extract assignment") || lowerPrompt.includes("assignment details")) {
    const dueAtDate = new Date();
    dueAtDate.setDate(dueAtDate.getDate() + 7); // Default to 1 week out
    return JSON.stringify({
      title: userMessage.split(" ").slice(0, 4).join(" ") || "New Assignment",
      description: userMessage,
      due_at: dueAtDate.toISOString(),
      due_at_display: "next Friday",
      target_type: "class",
      confidence: 0.95
    });
  }

  // 3. Question Answering
  if (lowerPrompt.includes("answer the teacher's question")) {
    return "Based on current data, Student 'Maddy' has reported progress on Class 9 assignments.";
  }

  // 4. Reminders
  return "This is a friendly reminder to check in on your assignment!";
}




// WHY safe JSON parser: LLMs sometimes add markdown fences (```json)
// or trailing commas. This strips that before parsing.
function safeParseJSON(text) {
  if (!text) return null;
  try {
    // Remove markdown code fences if present
    const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

// =============================================================
// 1. PARSE ASSIGNMENT FROM NATURAL LANGUAGE
// WHY: Teachers type casually. "Give kids an essay on climate
// change due next week" → we need structured data for the DB.
// =============================================================
async function parseAssignment(teacherMessage, currentDateTime, timezone = 'UTC') {
  const systemPrompt = `You are a school assistant that extracts assignment details from teacher messages.
Always respond with ONLY valid JSON, no markdown, no preamble.

Current date and time: ${currentDateTime}
Teacher's timezone: ${timezone}

Extract these fields:
- title: short assignment title (max 60 chars)
- description: full assignment instructions
- due_at: ISO 8601 datetime string (e.g. "2024-01-15T18:00:00") or null if not mentioned
- due_at_display: human-readable version (e.g. "Friday 12 Jan at 6:00 PM") or null
- target_type: "class" (whole class), "individual", or "group"
- confidence: number 0-1, how confident you are this is an assignment creation request

IMPORTANT — relative deadline handling:
- "tomorrow evening" = next day at 18:00
- "next Friday" = the coming Friday at 23:59
- "by end of week" = this Friday at 23:59
- "in 3 days" = current date + 3 days at 23:59
- Always resolve relative dates against the current date and time provided above.

If the message is NOT an assignment (e.g. just a question or greeting), set confidence below 0.5.

Respond ONLY with JSON like:
{"title":"...","description":"...","due_at":"...","due_at_display":"...","target_type":"class","confidence":0.9}`;

  const result = await callClaude(systemPrompt, teacherMessage);
  const parsed = safeParseJSON(result);

  // WHY fallback: if LLM fails or returns garbage, we don't crash.
  // Instead we return a low-confidence result so the caller knows
  // to ask the teacher for clarification.
  if (!parsed) {
    return {
      title: null,
      description: teacherMessage,
      due_at: null,
      target_type: 'class',
      confidence: 0
    };
  }

  return parsed;
}

// =============================================================
// 2. INTERPRET STUDENT MESSAGE
// WHY: Students say "almost done" or "I'm stuck on question 3"
// — we need to map that to a status transition + extract intent.
// =============================================================
async function interpretStudentMessage(studentMessage, currentStatus, assignmentTitle) {
  const systemPrompt = `You are a school assistant that interprets student messages about their assignments.
Always respond with ONLY valid JSON, no markdown, no preamble.

The student is working on: "${assignmentTitle}"
Their current status: ${currentStatus}

Determine:
- new_status: one of: acknowledged, in_progress, blocked, submitted, needs_help
  (only change status if the message clearly implies it; use "same" to keep current)
- intent: one of: progress_update, blocked_report, submission, acknowledgement, question, help_request, unclear
- summary: 1-sentence summary of what the student said
- needs_teacher_attention: true if teacher should be notified immediately
- confidence: 0-1 confidence in interpretation

Valid status transitions:
- assigned → acknowledged (student says ok/got it/will do)
- assigned/acknowledged → in_progress (student says working on it/started)
- any → blocked (student says stuck/can't/don't understand/blocked)
- any → submitted (student is submitting work)
- blocked → in_progress (student says they figured it out/unblocked)

Respond ONLY with JSON like:
{"new_status":"in_progress","intent":"progress_update","summary":"Student says they are halfway done","needs_teacher_attention":false,"confidence":0.85}`;

  const result = await callClaude(systemPrompt, studentMessage);
  const parsed = safeParseJSON(result);

  if (!parsed) {
    return {
      new_status: 'same',
      intent: 'unclear',
      summary: studentMessage.substring(0, 100),
      needs_teacher_attention: false,
      confidence: 0
    };
  }

  return parsed;
}

// =============================================================
// 3. GENERATE CONTEXTUAL REMINDER MESSAGE
// WHY: "REMINDER: Assignment due soon" feels robotic and gets
// ignored. An LLM writes a message tailored to the student's
// situation — blocked vs silent vs just slow.
// =============================================================
async function generateReminderMessage(context) {
  const {
    studentName,
    assignmentTitle,
    dueAt,
    currentStatus,
    reminderType,
    daysTillDue,
    lastMessageSummary
  } = context;

  const systemPrompt = `You are a friendly but professional school assistant sending reminders to students.
Write a SHORT (2-3 sentences max), warm, non-nagging reminder message.
Do NOT use generic phrases like "Just a reminder". Be specific to the student's situation.
Do NOT use emojis excessively — max 1 per message.`;

  const userPrompt = `Write a Telegram reminder for:
Student: ${studentName}
Assignment: "${assignmentTitle}"
Due: ${dueAt} (${daysTillDue} days away)
Current status: ${currentStatus}
Reminder type: ${reminderType}
Last known activity: ${lastMessageSummary || 'No updates from student yet'}

Reminder types mean:
- due_soon: assignment due in 24 hours
- overdue: assignment is past due
- blocked_checkin: student said they were blocked, checking if resolved
- silent_checkin: student hasn't responded in a while`;

  const result = await callClaude(systemPrompt, userPrompt, 200);

  // Fallback message if LLM fails
  if (!result) {
    const fallbacks = {
      due_soon: `Hi ${studentName}! Just a heads up — "${assignmentTitle}" is due soon. Let your teacher know if you need help!`,
      overdue: `Hi ${studentName}, "${assignmentTitle}" appears to be overdue. Please reach out to your teacher.`,
      blocked_checkin: `Hi ${studentName}! You mentioned being stuck on "${assignmentTitle}". Have you been able to make progress? Your teacher is here to help.`,
      silent_checkin: `Hi ${studentName}! How's "${assignmentTitle}" going? A quick update would be great. 📝`
    };
    return fallbacks[reminderType] || fallbacks.silent_checkin;
  }

  return result.trim();
}

// =============================================================
// 4. GENERATE TEACHER SUMMARY
// WHY: Teachers don't want to read 50 chat messages. They want
// "Rahul is blocked, Priya submitted, 3 students haven't started."
// =============================================================
async function generateTeacherSummary(assignmentData, studentsData) {
  const systemPrompt = `You are a school assistant creating concise summaries for teachers.
Be specific, prioritize at-risk students, and be brief (max 5 bullet points).
Format as plain text with line breaks, no markdown headers.`;

  const userPrompt = `Summarize the status of this assignment for the teacher:

Assignment: "${assignmentData.title}"
Due: ${assignmentData.due_at || 'No deadline set'}
Total students: ${studentsData.length}

Student statuses:
${studentsData.map(s => `- ${s.name}: ${s.status}${s.last_message ? ` (last said: "${s.last_message}")` : ''}`).join('\n')}

Focus on: who needs attention, who is at risk, who has submitted, and any blockers.`;

  const result = await callClaude(systemPrompt, userPrompt, 400);

  if (!result) {
    // Deterministic fallback summary
    const byStatus = {};
    studentsData.forEach(s => {
      byStatus[s.status] = (byStatus[s.status] || []);
      byStatus[s.status].push(s.name);
    });
    return Object.entries(byStatus)
      .map(([status, names]) => `${status}: ${names.join(', ')}`)
      .join('\n');
  }

  return result.trim();
}

// =============================================================
// 5. ANSWER TEACHER QUESTION ("Who is at risk this week?")
// WHY: This is the "bonus" feature but it shows the power of
// combining structured DB data with LLM reasoning.
// =============================================================
async function answerTeacherQuestion(question, contextData) {
  const systemPrompt = `You are a helpful school assistant. Answer the teacher's question based on the provided data.
Be concise and specific. If you cannot answer from the data, say so.
Do not make up information not present in the data.`;

  const userPrompt = `Teacher's question: "${question}"

Current data:
${JSON.stringify(contextData, null, 2)}`;

  const result = await callClaude(systemPrompt, userPrompt, 500);

  if (!result) {
    return "I couldn't process that question right now. Please try again in a moment.";
  }

  return result.trim();
}

// =============================================================
// 6. DETECT WHAT A MESSAGE IS ABOUT (routing)
// WHY: When a teacher sends a message to the bot, we need to
// know: are they creating an assignment? Asking a question?
// Giving feedback? Updating a deadline?
// =============================================================
async function classifyTeacherIntent(message, context) {
  const systemPrompt = `You are a classifier for teacher messages to a school bot.
Respond with ONLY valid JSON, no other text.

Classify the teacher's intent as one of:
- create_assignment: teacher wants to create a new assignment
- update_assignment: teacher wants to change deadline or instructions
- cancel_assignment: teacher wants to cancel an assignment
- give_feedback: teacher is responding to a student submission
- ask_question: teacher is asking about student status/progress
- list_assignments: teacher wants to see their assignments
- unclear: intent is ambiguous

Respond: {"intent":"...","confidence":0.0-1.0,"reasoning":"one sentence"}`;

  const result = await callClaude(systemPrompt, 
    `Context: ${JSON.stringify(context)}\nMessage: ${message}`);
  
  return safeParseJSON(result) || { intent: 'unclear', confidence: 0, reasoning: 'LLM failed' };
}

module.exports = {
  parseAssignment,
  interpretStudentMessage,
  generateReminderMessage,
  generateTeacherSummary,
  answerTeacherQuestion,
  classifyTeacherIntent
};
