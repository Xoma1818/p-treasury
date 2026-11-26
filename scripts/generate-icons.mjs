// Regenerate the desktop assets from the same SVG used in the application.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const icons = join(root, "src-tauri", "icons");
const build = join(root, "target", "desktop-icons");
const frames = join(build, "windows");
const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const cli = join(root, "node_modules", "@tauri-apps", "cli", "tauri.js");
const source = join(icons, "icon.svg");

mkdirSync(frames, { recursive: true });
execFileSync(process.execPath, [cli, "icon", source, "-o", build], { stdio: "inherit" });
execFileSync(process.execPath, [cli, "icon", source, "-o", frames, ...sizes.flatMap((v) => ["-p", String(v)])], { stdio: "inherit" });
for (const name of ["32x32.png", "128x128.png", "128x128@2x.png", "icon.png"]) {
  copyFileSync(join(build, name), join(icons, name));
}

// Tauri emits the same ICNS entries in a different order between invocations.
const icns = readFileSync(join(build, "icon.icns"));
const entries = [];
for (let start = 8; start < icns.length;) {
  const length = icns.readUInt32BE(start + 4);
  if (length < 8 || start + length > icns.length) throw new Error("Invalid ICNS entry");
  entries.push(icns.subarray(start, start + length));
  start += length;
}
entries.sort((a, b) => a.subarray(0, 4).compare(b.subarray(0, 4)));
writeFileSync(join(icons, "icon.icns"), Buffer.concat([icns.subarray(0, 8), ...entries]));

// The Tauri default ICO omits the 125% taskbar size and the 128 px Explorer size.
const directory = Buffer.alloc(6 + sizes.length * 16);
directory.writeUInt16LE(1, 2);
directory.writeUInt16LE(sizes.length, 4);
let offset = directory.length;
const images = sizes.map((size, index) => {
  const image = readFileSync(join(frames, `${size}x${size}.png`));
  const entry = 6 + index * 16;
  directory[entry] = directory[entry + 1] = size === 256 ? 0 : size;
  directory.writeUInt16LE(32, entry + 6);
  directory.writeUInt32LE(image.length, entry + 8);
  directory.writeUInt32LE(offset, entry + 12);
  offset += image.length;
  return image;
});
writeFileSync(join(icons, "icon.ico"), Buffer.concat([directory, ...images]));

if (process.platform === "win32") {
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "RemoteSigned", "-File", join(root, "scripts", "generate-installer-art.ps1")], { stdio: "inherit" });
}
