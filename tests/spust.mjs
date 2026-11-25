// Spouštěč testů: najde všechny soubory *.test.mjs v repu a spustí je jedním příkazem node --test.
//   npm test                 všechny testy včetně E2E instalace (potřebuje claude CLI)
//   npm run test:rychle      bez E2E instalace (tests/instalace.test.mjs), bez claude CLI
// Soubory se hledají sami, takže nový test nelze zapomenout zapsat do seznamu; seznam se předává výslovně
// (glob v node --test se mezi verzemi Node liší a v cmd.exe by se nerozbalil). Další argumenty se předají node --test.
import { readdirSync, realpathSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, relative, sep } from 'node:path';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const NEPOMALE = new Set(['.git', 'node_modules']);
export const POMALE = ['tests/instalace.test.mjs'];

export function najdiTesty(dir = ROOT, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (NEPOMALE.has(e.name)) continue;
    const plna = join(dir, e.name);
    if (e.isDirectory()) najdiTesty(plna, out);
    else if (e.isFile() && e.name.endsWith('.test.mjs')) out.push(relative(ROOT, plna).split(sep).join('/'));
  }
  return out.sort();
}

// V CI se nesmí nic tiše přeskakovat (test, který se nespustí, nic nehlídá). Výjimky jsou jen tyto, každá s důvodem a platformou:
// na Windows bez práv na symlinky nejde vytvořit symlink na soubor (složkový odkaz je pokrytý jiným testem).
export const POVOLENA_PRESKOCENI = [
  { vzor: /symlink na soubor/i, platformy: ['win32'], duvod: 'Windows bez práva vytvářet symlinky na soubory (EPERM)' },
];

// Názvy přeskočených testů z výstupu node --test: spec reporter (řádek "﹣ název (12ms) # důvod") i TAP ("ok 3 - název # SKIP důvod").
export function najdiPreskocene(vystup) {
  const nazvy = [];
  for (const radek of String(vystup).split(/\r?\n/)) {
    const spec = /^\s*﹣\s+(.+?)\s+\(\d+(?:\.\d+)?m?s\)(?:\s+#.*)?$/.exec(radek);
    const tap = /^\s*(?:ok|not ok)\s+\d+\s+-\s+(.+?)\s+#\s+SKIP\b/i.exec(radek);
    const m = spec ?? tap;
    if (m) nazvy.push(m[1]);
  }
  return nazvy;
}

export const nepovolenaPreskoceni = (nazvy, platforma = process.platform) => nazvy.filter(
  (n) => !POVOLENA_PRESKOCENI.some((p) => p.vzor.test(n) && p.platformy.includes(platforma)),
);

export const vyber = (vsechny, rychle) => (rychle ? vsechny.filter((f) => !POMALE.includes(f)) : vsechny);

// spuštění přímo (ne import): porovnání reálných cest, aby to fungovalo i přes symlink a junction
function jeHlavni() {
  try { return realpathSync.native(process.argv[1]) === realpathSync.native(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (jeHlavni()) {
  const argumenty = process.argv.slice(2);
  const rychle = argumenty.includes('--rychle');
  const dalsi = argumenty.filter((a) => a !== '--rychle');
  const vsechny = najdiTesty();
  const soubory = vyber(vsechny, rychle);
  if (soubory.length === 0) {
    console.error('Nenašel jsem žádný soubor *.test.mjs. Spouští se z kořene repa (npm test)? Beze testů nesmí běh projít.');
    process.exit(1);
  }
  console.log(`Spouštím ${soubory.length} souborů s testy${rychle ? ' (bez E2E instalace)' : ''}:\n  ${soubory.join('\n  ')}\n`);
  const jeCI = String(process.env.CI ?? '').toLowerCase() === 'true';
  const args = ['--test', ...dalsi, ...soubory];
  if (!jeCI) {
    const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
    if (r.error) { console.error(`Nepodařilo se spustit node --test: ${r.error.message}`); process.exit(1); }
    process.exit(r.status ?? 1);
  }
  // CI: výstup se průběžně vypisuje a zároveň sbírá, aby šlo po doběhnutí zkontrolovat přeskočené testy.
  const p = spawn(process.execPath, args, { cwd: ROOT, stdio: ['inherit', 'pipe', 'inherit'] });
  const casti = [];
  p.stdout.on('data', (d) => { process.stdout.write(d); casti.push(d); });
  p.on('error', (e) => { console.error(`Nepodařilo se spustit node --test: ${e.message}`); process.exit(1); });
  p.on('close', (status) => {
    const preskocene = najdiPreskocene(Buffer.concat(casti).toString('utf8'));
    const zakazane = nepovolenaPreskoceni(preskocene);
    if (zakazane.length > 0) {
      const radky = ['', `V CI se nesmí nic přeskakovat (CI=true), ale přeskočilo se ${zakazane.length} testů:`, ...zakazane.map((n) => `  ${n}`), 'Povolené výjimky jsou v POVOLENA_PRESKOCENI (tests/spust.mjs).'];
      console.error(radky.join('\n'));
      process.exit(1);
    }
    process.exit(status ?? 1);
  });
}
