#!/usr/bin/env node

// ============================================================================
// Follow Builders — Telegram Digest Sender
// ============================================================================
// Reads feed JSON files, generates a Chinese summary via LLM, and sends
// to Telegram. Designed to run in GitHub Actions after feed generation.
//
// Env vars needed:
//   LLM_API_KEY       — API key for the LLM (DeepSeek or OpenAI-compatible)
//   LLM_BASE_URL      — LLM API base URL (default: https://api.deepseek.com)
//   LLM_MODEL         — LLM model name (default: deepseek-chat)
//   TELEGRAM_BOT_TOKEN — Telegram bot token
//   TELEGRAM_CHAT_ID   — Telegram chat ID to send to
// ============================================================================

import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";

// -- Constants ---------------------------------------------------------------

const SCRIPT_DIR = decodeURIComponent(new URL(".", import.meta.url).pathname);
const ROOT_DIR = join(SCRIPT_DIR, "..");
const FEED_X_PATH = join(ROOT_DIR, "feed-x.json");
const FEED_PODCASTS_PATH = join(ROOT_DIR, "feed-podcasts.json");
const FEED_BLOGS_PATH = join(ROOT_DIR, "feed-blogs.json");
const PROMPTS_DIR = join(ROOT_DIR, "prompts");

// -- Helpers -----------------------------------------------------------------

async function readJSON(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, "utf-8"));
  } catch {
    return null;
  }
}

async function readText(path) {
  if (!existsSync(path)) return null;
  return readFile(path, "utf-8");
}

function formatDate() {
  const now = new Date();
  // Beijing time (UTC+8)
  const bj = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const y = bj.getUTCFullYear();
  const m = String(bj.getUTCMonth() + 1).padStart(2, "0");
  const d = String(bj.getUTCDate()).padStart(2, "0");
  const weekdays = ["日", "一", "二", "三", "四", "五", "六"];
  const w = weekdays[bj.getUTCDay()];
  return `${y}-${m}-${d} 周${w}`;
}

// -- LLM Call ----------------------------------------------------------------

async function callLLM(prompt, apiKey, baseUrl, model) {
  const url = `${baseUrl}/v1/chat/completions`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model,
      messages: [
        {
          role: "system",
          content:
            "你是一位 AI 行业分析师，负责为中文读者总结 AI 建造者的最新动态。你的摘要简洁、有洞察、适合在 Telegram 上阅读。输出纯文本，不要使用 Markdown 格式（Telegram 不支持复杂排版）。使用 emoji 让内容更生动。",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0.3,
      max_tokens: 4000,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LLM API error ${res.status}: ${text}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

// -- Telegram ----------------------------------------------------------------

async function sendTelegram(text, botToken, chatId) {
  const MAX_LEN = 4000;
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_LEN) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf("\n", MAX_LEN);
    if (splitAt < MAX_LEN * 0.5) splitAt = MAX_LEN;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  for (const chunk of chunks) {
    const res = await fetch(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: chunk,
          disable_web_page_preview: true,
        }),
      },
    );
    if (!res.ok) {
      const err = await res.json();
      throw new Error(`Telegram error: ${err.description}`);
    }
    if (chunks.length > 1) await new Promise((r) => setTimeout(r, 500));
  }
}

// -- Build Prompt ------------------------------------------------------------

function buildPrompt(feedX, feedPodcasts, feedBlogs, prompts) {
  const parts = [];

  parts.push(`# AI 建造者日报 — ${formatDate()}\n`);
  parts.push("请根据以下原始数据，生成一份简洁的中文摘要。格式要求：");
  parts.push("- 每个板块用 emoji 分隔（🐦 X动态 / 📝 博客 / 🎙️ 播客）");
  parts.push("- 每位建造者用 2-3 句话总结核心观点");
  parts.push("- 保留关键链接（原始推文/文章/视频URL）");
  parts.push("- 适合手机屏幕阅读，段落简短");
  parts.push("- 如果某人没有实质性内容，直接跳过");
  parts.push("- 不要使用 @ 符号提及用户名（在 Telegram 会变成链接）");
  parts.push("- 总字数控制在 2000 字以内\n");

  // Add tweet data
  if (feedX?.x?.length > 0) {
    parts.push("## X/Twitter 动态\n");
    for (const builder of feedX.x) {
      parts.push(`### ${builder.name} (${builder.handle})`);
      if (builder.bio) parts.push(`简介: ${builder.bio.split("\n")[0]}`);
      for (const tweet of builder.tweets || []) {
        parts.push(`- [${tweet.likes}赞] ${tweet.text.slice(0, 300)}`);
        parts.push(`  链接: ${tweet.url}`);
      }
      parts.push("");
    }
  }

  // Add blog data
  if (feedBlogs?.blogs?.length > 0) {
    parts.push("## 博客文章\n");
    for (const blog of feedBlogs.blogs) {
      parts.push(`### ${blog.name}: ${blog.title}`);
      if (blog.author) parts.push(`作者: ${blog.author}`);
      parts.push(`链接: ${blog.url}`);
      if (blog.content) parts.push(`内容摘要: ${blog.content.slice(0, 500)}...`);
      parts.push("");
    }
  }

  // Add podcast data
  if (feedPodcasts?.podcasts?.length > 0) {
    parts.push("## 播客\n");
    for (const pod of feedPodcasts.podcasts) {
      parts.push(`### ${pod.name}: ${pod.title}`);
      parts.push(`链接: ${pod.url}`);
      if (pod.transcript) {
        parts.push(`转录摘要: ${pod.transcript.slice(0, 500)}...`);
      }
      parts.push("");
    }
  }

  // Add specific prompt instructions if available
  if (prompts?.summarize_tweets) {
    parts.push("\n## 推特总结指引\n" + prompts.summarize_tweets);
  }
  if (prompts?.summarize_blogs) {
    parts.push("\n## 博客总结指引\n" + prompts.summarize_blogs);
  }
  if (prompts?.summarize_podcast) {
    parts.push("\n## 播客总结指引\n" + prompts.summarize_podcast);
  }

  return parts.join("\n");
}

// -- Main --------------------------------------------------------------------

async function main() {
  const apiKey = process.env.LLM_API_KEY;
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const baseUrl = process.env.LLM_BASE_URL || "https://api.deepseek.com";
  const model = process.env.LLM_MODEL || "deepseek-chat";

  if (!apiKey) {
    console.error("LLM_API_KEY not set — skipping digest generation");
    process.exit(0);
  }
  if (!botToken || !chatId) {
    console.error(
      "TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set — skipping",
    );
    process.exit(0);
  }

  // Load feeds
  const [feedX, feedPodcasts, feedBlogs] = await Promise.all([
    readJSON(FEED_X_PATH),
    readJSON(FEED_PODCASTS_PATH),
    readJSON(FEED_BLOGS_PATH),
  ]);

  // Check if we have any content
  const hasTweets = feedX?.x?.length > 0;
  const hasPodcasts = feedPodcasts?.podcasts?.length > 0;
  const hasBlogs = feedBlogs?.blogs?.length > 0;

  if (!hasTweets && !hasPodcasts && !hasBlogs) {
    console.log("No new content — skipping digest");
    process.exit(0);
  }

  // Load prompts
  const prompts = {};
  for (const name of [
    "summarize-tweets",
    "summarize-blogs",
    "summarize-podcast",
  ]) {
    const key = name.replace(/-/g, "_");
    prompts[key] = await readText(join(PROMPTS_DIR, `${name}.md`));
  }

  // Build prompt and call LLM
  console.log("Generating digest via LLM...");
  const prompt = buildPrompt(feedX, feedPodcasts, feedBlogs, prompts);

  let summary;
  try {
    summary = await callLLM(prompt, apiKey, baseUrl, model);
  } catch (err) {
    console.error(`LLM call failed: ${err.message}`);
    // Fallback: send a simple summary without LLM
    summary = `⚠️ AI 摘要生成失败，以下是原始统计：\n`;
    if (hasTweets)
      summary += `🐦 ${feedX.x.length} 位建造者，${feedX.stats?.totalTweets || 0} 条推文\n`;
    if (hasBlogs)
      summary += `📝 ${feedBlogs.blogs.length} 篇博客文章\n`;
    if (hasPodcasts)
      summary += `🎙️ ${feedPodcasts.podcasts.length} 期播客\n`;
  }

  if (!summary || summary.trim().length === 0) {
    console.log("LLM returned empty summary — skipping");
    process.exit(0);
  }

  // Add header
  const header = `🏗️ AI 建造者日报 — ${formatDate()}\n\n`;
  const fullMessage = header + summary;

  // Send to Telegram
  console.log(`Sending to Telegram (chat_id: ${chatId})...`);
  await sendTelegram(fullMessage, botToken, chatId);
  console.log("✅ Digest sent successfully!");
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
