// Headless end-to-end check: one natural-language request through the agent into CodeWalker.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EditorSession } from "./agent.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const prompt = process.argv[2] ?? "Kameranın 5 metre önüne, kameraya dönük bir bank koy.";

const session = new EditorSession(
  (message) => {
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text") console.log(`[assistant] ${block.text}`);
        if (block.type === "tool_use") console.log(`[tool_use] ${block.name} ${JSON.stringify(block.input)}`);
      }
    } else if (message.type === "user" && Array.isArray(message.message.content)) {
      for (const block of message.message.content) {
        if (typeof block === "object" && block.type === "tool_result") {
          const content = Array.isArray(block.content) ? block.content.map((c) => ("text" in c ? c.text : "")).join("") : String(block.content);
          console.log(`[tool_result${block.is_error ? " ERROR" : ""}] ${content.slice(0, 300)}`);
        }
      }
    } else if (message.type === "system" && message.subtype === "init") {
      console.log(`[init] model=${message.model} tools=${message.tools.join(",")}`);
    } else if (message.type === "result") {
      console.log(`[result] ${message.subtype} turns=${message.num_turns} cost=$${message.total_cost_usd.toFixed(4)}`);
      session.close();
    }
  },
  { mapsDir: path.join(root, "maps"), workDir: path.join(root, "editor") },
);

session.send(prompt);
await session.start();
