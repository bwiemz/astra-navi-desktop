import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { defineChatSessionFunction, type ChatSessionModelFunctions } from "node-llama-cpp";
import { guarded, type ToolHost } from "./agentTools.ts";
import { replaceInternalCaptain } from "./characterLayer.ts";
import { resolveToolPath, TOOLS } from "./permissions.ts";
import {
  isWebLink,
  listPhones,
  MAX_PHONE_TEXT_CHARS,
  MAX_PING_CHARS,
  pickPhone,
  pingPhone,
  ringPhone,
  sendTextToPhone,
  sendToPhone,
  type Phone,
  type PhoneRunner,
} from "./phone.ts";

const PHONE_ACTIONS = ["list", "ring", "send_text", "send_link", "send_file", "ping"] as const;
type PhoneAction = (typeof PHONE_ACTIONS)[number];

interface PhoneInput {
  action: PhoneAction;
  phone?: string;
  text?: string;
  link?: string;
  path?: string;
}

function describePhone(phone: Phone): string {
  if (!phone.reachable) return `- ${phone.name}: paired, not in reach`;
  const battery =
    phone.battery === null
      ? ""
      : `, battery ${phone.battery}%${phone.charging ? " (charging)" : ""}`;
  return `- ${phone.name}: in reach${battery}`;
}

const ACTIVITY: Record<PhoneAction, string> = {
  list: "Checking for your phone",
  ring: "Ringing your phone",
  send_text: "Sending that to your phone",
  send_link: "Sending the link to your phone",
  send_file: "Sending the file to your phone",
  ping: "Sending a note to your phone",
};

/** Her reach beyond the PC: the phone paired with it through KDE Connect. */
export function createPhoneTools(
  host: ToolHost,
  options: { run?: PhoneRunner } = {},
): ChatSessionModelFunctions {
  const { run } = options;
  return {
    [TOOLS.phone]: defineChatSessionFunction({
      description:
        "Captain's phone, paired through KDE Connect. list shows the paired phones, whether each is in reach, and its battery. ring makes it ring so it can be found. send_text puts text on it, send_link opens a web address on it, send_file sends a file to it, ping shows a short note on its screen.",
      params: {
        type: "object",
        properties: {
          action: { enum: PHONE_ACTIONS },
          phone: {
            type: "string",
            description: "Words from the phone's name. Only needed when several are paired.",
          },
          text: { type: "string", description: "For send_text and ping: the text." },
          link: { type: "string", description: "For send_link: the web address." },
          path: { type: "string", description: "For send_file: the file to send." },
        },
        required: ["action"],
      },
      handler: guarded<PhoneInput>(
        host,
        TOOLS.phone,
        (input) => ACTIVITY[input.action],
        async (input) => {
          const phones = await listPhones(run);
          if (input.action === "list") {
            // Their own devices, named by them: nothing here was written by a stranger.
            if (phones.length === 0) {
              return replaceInternalCaptain(
                "There is no phone paired with this computer yet. Captain pairs one in KDE Connect (System Settings, KDE Connect) with the KDE Connect app on the phone.",
                host.userAddress?.(),
              );
            }
            return `Paired devices:\n${phones.map(describePhone).join("\n")}`;
          }

          // What is to be sent is checked before the phone is looked for, so a missing
          // text is reported as that and not as a missing phone.
          const text = (input.text ?? "").trim();
          const link = (input.link ?? "").trim();
          let file = "";
          switch (input.action) {
            case "send_text":
              if (!text) return "Nothing was sent: there was no text.";
              if (text.length > MAX_PHONE_TEXT_CHARS) {
                return `Nothing was sent: that is ${text.length} characters, and ${MAX_PHONE_TEXT_CHARS} is the most. Save it to a file and use send_file.`;
              }
              break;
            case "ping":
              if (!text) return "Nothing was sent: there was no text.";
              if (text.length > MAX_PING_CHARS) {
                return `Nothing was sent: a note on the phone's screen holds ${MAX_PING_CHARS} characters at most. Use send_text for longer text.`;
              }
              break;
            case "send_link":
              if (!isWebLink(link)) {
                return "Nothing was sent: send_link needs a full web address starting with http:// or https://.";
              }
              break;
            case "send_file": {
              const raw = (input.path ?? "").trim();
              if (!raw) return "Nothing was sent: send_file needs the file's path.";
              file = await resolveToolPath(raw, host.policy());
              const isFile = await stat(file).then(
                (found) => found.isFile(),
                () => false,
              );
              if (!isFile) return `Nothing was sent: there is no file at ${file}.`;
              break;
            }
            case "ring":
              break;
          }

          const picked = pickPhone(phones, input.phone);
          if ("problem" in picked) return picked.problem;
          const { phone } = picked;
          switch (input.action) {
            case "ring":
              await ringPhone(phone.id, run);
              return `${phone.name} is ringing now.`;
            case "send_text":
              await sendTextToPhone(phone.id, text, run);
              return `Sent ${text.length} characters to ${phone.name}.`;
            case "ping":
              await pingPhone(phone.id, text, run);
              return `Shown on ${phone.name}: "${text.replace(/\s+/g, " ")}"`;
            case "send_link":
              await sendToPhone(phone.id, link, run);
              return `Sent the link to ${phone.name}: ${link}`;
            case "send_file":
              await sendToPhone(phone.id, file, run);
              return `Sent ${basename(file)} to ${phone.name}. The phone saves it in its downloads.`;
          }
        },
      ),
    }),
  };
}
