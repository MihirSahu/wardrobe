import { spawn } from "node:child_process";
for (const args of [["test"], ["build"]]) {
  const child = spawn("sfw", ["pnpm", ...args], { stdio: "inherit" });
  const status = await new Promise((resolve) => child.on("exit", resolve));
  if (status !== 0) process.exit(status || 1);
}
