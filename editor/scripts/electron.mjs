// Runs Electron with the given arguments. ELECTRON_RUN_AS_NODE is removed first: shells opened from another
// Electron app (code editors and the like) often inherit it, and with it set Electron starts as plain Node.
import { spawn } from "node:child_process";
import electron from "electron"; // outside Electron, the package exports the path to the binary

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, process.argv.slice(2), { stdio: "inherit", env });
child.on("exit", (code) => process.exit(code ?? 1));
