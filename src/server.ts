import { Agent, routeAgentEmail } from "agents";
import { createCatchAllEmailResolver, type AgentEmail } from "agents/email";
import PostalMime, { Attachment } from "postal-mime";
import type { ForwardableEmailMessage, Ai } from "@cloudflare/workers-types";

export interface Env {
  TempMailAgent: DurableObjectNamespace<TempMailAgent>;
  TELEGRAM_BOT_TOKEN: string;
  DOMAIN: string;
  AI: Ai;
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: {
      id: number;
      type: string;
    };
    text?: string;
  };
  callback_query?: {
    id: string;
    data: string;
    message?: {
      message_id: number;
      chat: {
        id: number;
      };
    };
  };
}

export class TempMailAgent extends Agent<Env> {
  async onEmail(email: AgentEmail): Promise<void> {
    const raw = await email.getRaw();
    const parsed = await PostalMime.parse(raw);

    const toAddress = email.to.toLowerCase();
    
    // Extract the Telegram chat ID from the sub-address format: tempmail+<chat_id>@domain.com
    const match = toAddress.match(/\+(.+)@/);
    if (!match) {
      console.warn("Dropped email: No chat ID found in recipient address", toAddress);
      return;
    }

    const chatId = match[1];
    const telegramToken = this.env.TELEGRAM_BOT_TOKEN;
    
    if (!telegramToken) {
      throw new Error("TELEGRAM_BOT_TOKEN is not configured in the environment.");
    }

    const textBody = parsed.text || parsed.html?.replace(/<[^>]*>?/gm, '') || "";
    const cleanTextBody = textBody.trim();
    
    // Generate AI Summary using the bound CF model
    let aiSummary = "No content available to summarize.";
    if (cleanTextBody.length > 20) {
      aiSummary = await this.generateEmailSummary(cleanTextBody);
    }

    const snippetLength = 500;
    const snippet = cleanTextBody.substring(0, snippetLength) + (cleanTextBody.length > snippetLength ? "...\n[Message Truncated]" : "");
    const attachmentCount = parsed.attachments?.length || 0;

    const messagePayload = 
      `📥 <b>New Email Received!</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 <b>From:</b> <code>${this.escapeHtml(email.from)}</code>\n` +
      `🎯 <b>To:</b> <code>${this.escapeHtml(toAddress)}</code>\n` +
      `📑 <b>Subject:</b> <i>${this.escapeHtml(parsed.subject || "No Subject")}</i>\n` +
      `📎 <b>Attachments:</b> ${attachmentCount}\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🤖 <b>AI Summary:</b>\n<i>${this.escapeHtml(aiSummary)}</i>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `📝 <b>Message:</b>\n` +
      `<pre>${this.escapeHtml(snippet || "No readable text content.")}</pre>`;

    // Dispatch the primary text message
    await this.sendTelegramMessage(chatId, messagePayload, telegramToken);

    // Process and dispatch each attachment utilizing native Web API FormData
    if (parsed.attachments && attachmentCount > 0) {
      for (const attachment of parsed.attachments) {
        await this.sendTelegramDocument(chatId, attachment, telegramToken);
      }
    }
  }

  private async generateEmailSummary(text: string): Promise<string> {
    try {
      // Limit the text to roughly 2000 characters to prevent overwhelming the context window
      const boundedText = text.substring(0, 2000);
      
      const response = await this.env.AI.run("@cf/zai-org/glm-4.7-flash", {
        messages: [
          { role: "system", content: "You are a highly efficient assistant. Summarize the following email text into exactly one concise, informative sentence." },
          { role: "user", content: boundedText }
        ]
      }) as { response?: string };

      if (response && response.response) {
        return response.response.trim();
      }
      return "Summary generation yielded no result.";
    } catch (error) {
      console.error("AI Summarization failed:", error);
      return "Automated summary temporarily unavailable.";
    }
  }

  private escapeHtml(unsafe: string): string {
    return unsafe
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  private async sendTelegramMessage(chatId: string, text: string, token: string): Promise<void> {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🗑️ Dismiss Email", callback_data: "dismiss" }]
          ]
        }
      })
    });

    if (!response.ok) {
      console.error(`Telegram API Error (sendMessage): ${response.status}`, await response.text());
    }
  }

  private async sendTelegramDocument(chatId: string, attachment: Attachment, token: string): Promise<void> {
    const url = `https://api.telegram.org/bot${token}/sendDocument`;
    
    const formData = new FormData();
    formData.append("chat_id", chatId);
    
    const fileName = attachment.filename || "unnamed_attachment.bin";
    const mimeType = attachment.mimeType || "application/octet-stream";
    
    const file = new File([attachment.content], fileName, { type: mimeType });
    formData.append("document", file);

    const caption = `📎 <b>Attachment:</b> <i>${this.escapeHtml(fileName)}</i>\n📦 <b>Size:</b> ${(attachment.content.byteLength / 1024).toFixed(2)} KB`;
    formData.append("caption", caption);
    formData.append("parse_mode", "HTML");

    const response = await fetch(url, {
      method: "POST",
      body: formData
    });

    if (!response.ok) {
      console.error(`Telegram API Error (sendDocument): ${response.status}`, await response.text());
      if (response.status === 413) {
        await this.sendTelegramMessage(
          chatId, 
          `⚠️ <b>Failed to send attachment.</b>\nFile <i>${this.escapeHtml(fileName)}</i> exceeds Telegram's 50MB Bot API limit.`, 
          token
        );
      }
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/webhook/telegram") {
      try {
        const update = await request.json<TelegramUpdate>();

        if (update.callback_query && update.callback_query.message) {
          const chatId = update.callback_query.message.chat.id;
          const messageId = update.callback_query.message.message_id;

          if (update.callback_query.data === "dismiss") {
            await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/deleteMessage`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                chat_id: chatId,
                message_id: messageId
              })
            });
          }
          return new Response("OK", { status: 200 }); 
        }

        if (update.message?.text && update.message.chat) {
          const chatId = update.message.chat.id;
          const text = update.message.text.trim();

          if (text.startsWith("/start")) {
            const domain = env.DOMAIN;
            const userEmail = `tempmail+${chatId}@${domain}`;

            const welcomeMsg = 
              `✨ <b>Premium AI TempMail Bot</b> ✨\n\n` +
              `Your secure, disposable email address is active:\n\n` +
              `📧 <code>${userEmail}</code>\n\n` +
              `<i>Tap the address to copy. Messages and attachments will be instantly delivered here with an AI-generated summary.</i>\n\n` +
              `🛡️ <b>Powered by Cloudflare Agents</b>\n` +
              `📣 <b>Updates:</b> @drkingbd`;

            await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                chat_id: chatId,
                text: welcomeMsg,
                parse_mode: "HTML"
              })
            });
          }
        }
        return new Response("OK", { status: 200 });
      } catch (error) {
        console.error("Failed to process webhook:", error);
        return new Response("Internal Server Error", { status: 500 });
      }
    }

    return new Response("Not Found", { status: 404 });
  },

  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    const catchAllResolver = createCatchAllEmailResolver("TempMailAgent", "dispatcher");
    
    await routeAgentEmail(message, env, {
      resolver: catchAllResolver,
      onNoRoute: (email) => {
        console.warn(`No route matched for ${email.from}, rejecting.`);
        email.setReject("Unknown recipient mapping.");
      }
    });
  }
} satisfies ExportedHandler<Env>;
