// Sets the console account. Interactive on a terminal; otherwise reads the
// username from WEB_TERMINAL_USERNAME and the password from the first line of stdin.
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
let password: string;
if (process.stdin.isTTY) {
  username ||= await prompt("Username: ");
  password = await prompt("Password: ", true);
  if ((await prompt("Repeat password: ", true)) !== password) throw new Error("Passwords do not match");
} else {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  password = Buffer.concat(chunks).toString().split(/\r?\n/)[0] ?? "";
}
if (!username || !password) throw new Error("Username and password are required");
await new Auth(config.paths.secrets).setAccount(username, password);
console.log(`Account "${username}" saved. Existing sessions are signed out.`);
