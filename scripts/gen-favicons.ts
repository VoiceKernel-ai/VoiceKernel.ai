/**
 * Renders the raster favicons from web/favicon.svg.
 *
 * Browsers still ask for /favicon.ico unprompted, and several crawlers and chat
 * unfurlers ignore SVG entirely, so the PNG and ICO variants are not optional
 * even though the SVG is what modern browsers prefer.
 *
 * Uses headless Chrome rather than an image library: adding a native raster
 * dependency to the API's package.json to generate five files at build time is
 * a poor trade, and Chrome renders the SVG exactly as a browser would.
 *
 *   npm run gen:favicons
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import os from 'node:os';

const WEB_DIR = path.resolve(__dirname, '../web');
const SVG = path.join(WEB_DIR, 'favicon.svg');

/** Sizes the ICO carries, plus the standalone PNGs browsers reference. */
const ICO_SIZES = [16, 32, 48];
const PNG_OUTPUTS: Array<{ size: number; file: string }> = [
  { size: 32, file: 'favicon-32x32.png' },
  { size: 16, file: 'favicon-16x16.png' },
  { size: 180, file: 'apple-touch-icon.png' },
  { size: 192, file: 'icon-192.png' },
  { size: 512, file: 'icon-512.png' },
];

function chromeBinary(): string {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    'No Chrome/Chromium found. Set CHROME_PATH, or commit the generated PNGs - they are checked in, so this script only needs to run when the mark changes.',
  );
}

/**
 * Renders the SVG at an exact pixel size.
 *
 * The SVG is inlined into a page sized to the target and given a transparent
 * background, so the screenshot is the glyph alone with no page chrome or
 * white matte around the rounded corners.
 */
function render(binary: string, svg: string, size: number, outFile: string): void {
  const html = `<!doctype html><meta charset="utf-8">
<style>
  html,body{margin:0;padding:0;background:transparent}
  svg{display:block;width:${size}px;height:${size}px}
</style>
${svg}`;

  const tmp = path.join(os.tmpdir(), `vk-favicon-${size}-${process.pid}.html`);
  fs.writeFileSync(tmp, html);

  try {
    execFileSync(
      binary,
      [
        '--headless',
        '--disable-gpu',
        '--no-sandbox',
        '--hide-scrollbars',
        '--default-background-color=00000000', // keep the corners transparent
        `--window-size=${size},${size}`,
        `--screenshot=${outFile}`,
        `file://${tmp}`,
      ],
      { stdio: 'ignore' },
    );
  } finally {
    fs.unlinkSync(tmp);
  }
}

/**
 * Packs PNGs into an ICO container.
 *
 * ICO has carried PNG payloads since Vista, so no BMP conversion is needed - * the directory just points at the PNG bytes. Width/height of 256 are encoded
 * as 0 by the format; we stay under that, but the clamp is kept so a larger
 * size added later does not silently corrupt the header.
 */
function buildIco(images: Array<{ size: number; data: Buffer }>): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;

  images.forEach((image, index) => {
    const entry = index * 16;
    directory.writeUInt8(image.size >= 256 ? 0 : image.size, entry + 0);
    directory.writeUInt8(image.size >= 256 ? 0 : image.size, entry + 1);
    directory.writeUInt8(0, entry + 2); // palette size, 0 for truecolour
    directory.writeUInt8(0, entry + 3); // reserved
    directory.writeUInt16LE(1, entry + 4); // colour planes
    directory.writeUInt16LE(32, entry + 6); // bits per pixel
    directory.writeUInt32LE(image.data.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += image.data.length;
  });

  return Buffer.concat([header, directory, ...images.map((i) => i.data)]);
}

function main(): void {
  if (!fs.existsSync(SVG)) throw new Error(`Missing ${SVG}`);
  const svg = fs.readFileSync(SVG, 'utf8');
  const binary = chromeBinary();

  const icoParts: Array<{ size: number; data: Buffer }> = [];
  const sizes = [...new Set([...ICO_SIZES, ...PNG_OUTPUTS.map((p) => p.size)])].sort((a, b) => a - b);
  const rendered = new Map<number, Buffer>();

  for (const size of sizes) {
    const tmpPng = path.join(os.tmpdir(), `vk-favicon-${size}.png`);
    render(binary, svg, size, tmpPng);
    rendered.set(size, fs.readFileSync(tmpPng));
    fs.unlinkSync(tmpPng);
    process.stdout.write(`  rendered ${size}x${size}\n`);
  }

  for (const { size, file } of PNG_OUTPUTS) {
    fs.writeFileSync(path.join(WEB_DIR, file), rendered.get(size)!);
    console.log(`  wrote web/${file}`);
  }

  for (const size of ICO_SIZES) icoParts.push({ size, data: rendered.get(size)! });
  fs.writeFileSync(path.join(WEB_DIR, 'favicon.ico'), buildIco(icoParts));
  console.log(`  wrote web/favicon.ico (${ICO_SIZES.join(', ')}px)`);

  // A manifest makes the console installable and gives Android a real icon.
  fs.writeFileSync(
    path.join(WEB_DIR, 'site.webmanifest'),
    `${JSON.stringify(
      {
        name: 'VoiceKernel',
        short_name: 'VoiceKernel',
        description: 'The voice infrastructure layer for regulated enterprise.',
        start_url: '/app/',
        display: 'standalone',
        background_color: '#0A1220',
        theme_color: '#0E1C2E',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml' },
        ],
      },
      null,
      2,
    )}\n`,
  );
  console.log('  wrote web/site.webmanifest');
}

main();
