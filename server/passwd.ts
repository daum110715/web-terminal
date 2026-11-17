// Adds or updates an account. Interactive on a terminal; otherwise reads the
// username from WEB_TERMINAL_USERNAME, optional system user from WEB_TERMINAL_SYSTEM_USER,
// and the password from the first line of stdin.
import readline from "node:readline/promises";
import { config } from "./config.ts";
import { Auth } from "./auth.ts";

async function prompt(question: string, hidden = false): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) {
    const write = (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput.bind(rl);
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s) =>
      write(s.startsWith(question) ? s : "");
  }
  const answer = await rl.question(question);
  rl.close();
  if (hidden) process.stdout.write("\n");
  return answer;
}

let username = process.env.WEB_TERMINAL_USERNAME ?? "";
let systemUser = process.env.WEB_TERMINAL_SYSTEM_USER;
let password: string;
if (process.stdin.isTTY) {
  username ||= await prompt("Username: ");
  if (systemUser === undefined) {
    const entered = (await prompt("System user (optional, Enter for service user): ")).trim();
    if (entered) systemUser = entered;
  }
  password = await prompt("Password: ", true);
  if ((await prompt("Repeat password: ", true)) !== password) throw new Error("Passwords do not match");
} else {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  password = Buffer.concat(chunks).toString().split(/\r?\n/)[0] ?? "";
}
if (!username || !password) throw new Error("Username and password are required");
await new Auth(config.paths.secrets).setAccount(username, password, systemUser);
console.log(`Account "${username}" saved${systemUser ? ` (system user: ${systemUser})` : ""}. Existing sessions for "${username}" are signed out.`);
