// Kontrola, že změna pluginu zvýšila version v plugin.json. Čisté funkce nad git repozitářem (git jen čte).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Proměnné, kterými git hook (pre-commit) nasměruje příkazy na skutečné repo; dočasné repozitáře v testech by je zdědily.
const GIT_MISTO = /^GIT_(DIR|WORK_TREE|INDEX_FILE|PREFIX|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE)$/i;

export function gitEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !GIT_MISTO.test(k)));
}

export function git(cwd, args, env = gitEnv()) {
  const r = spawnSync('git', ['-c', 'core.quotepath=off', ...args], { cwd, encoding: 'utf8', env });
  return { ok: r.status === 0 && !r.error, out: (r.stdout ?? '').trim(), raw: r.stdout ?? '', chyba: (r.stderr ?? '').trim() };
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+.*)?$/;

// -1, 0, 1 podle pravidel semver (předvydání je menší než vydání); null, když některá verze není semver
export function porovnejVerze(a, b) {
  const x = SEMVER.exec(a ?? '');
  const y = SEMVER.exec(b ?? '');
  if (!x || !y) return null;
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i]);
    if (d) return d < 0 ? -1 : 1;
  }
  if (x[4] === undefined && y[4] === undefined) return 0;
  if (x[4] === undefined) return 1;
  if (y[4] === undefined) return -1;
  const p = x[4].split('.');
  const q = y[4].split('.');
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    if (p[i] === undefined) return -1;
    if (q[i] === undefined) return 1;
    const cp = /^\d+$/.test(p[i]);
    const cq = /^\d+$/.test(q[i]);
    if (cp && cq) { const d = Number(p[i]) - Number(q[i]); if (d) return d < 0 ? -1 : 1; } else if (cp) return -1;
    else if (cq) return 1;
    else if (p[i] !== q[i]) return p[i] < q[i] ? -1 : 1;
  }
  return 0;
}

// Soubory, jejichž změna sama o sobě nemění chování pluginu u uživatele: testy vedle zdrojů.
export const BEZ_DOPADU = /\.test\.mjs$/;

// Základy, vůči kterým se změny porovnávají: sloučená základna s origin/main (nebo origin/master) a poslední tag
// pluginu <name>--v<verze> (formát tagu vytváří `claude plugin tag`). Prázdný seznam = není s čím porovnat.
export function zaklady(cwd, plugin) {
  const vysledek = [];
  if (!git(cwd, ['rev-parse', '--git-dir']).ok) return vysledek;
  for (const vetev of ['origin/main', 'origin/master']) {
    if (!git(cwd, ['rev-parse', '--verify', '--quiet', `${vetev}^{commit}`]).ok) continue;
    const mb = git(cwd, ['merge-base', 'HEAD', vetev]);
    if (mb.ok && mb.out) { vysledek.push({ ref: mb.out, popis: `větev ${vetev} (sloučená základna ${mb.out.slice(0, 7)})` }); break; }
  }
  if (git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']).ok) {
    const tagy = git(cwd, ['tag', '--list', `${plugin}--v*`, '--merged', 'HEAD', '--sort=-v:refname']);
    const prvni = tagy.ok ? tagy.out.split('\n').filter(Boolean)[0] : null;
    if (prvni) vysledek.push({ ref: prvni, popis: `tag ${prvni}` });
  }
  return vysledek;
}

function verzeV(cwd, ref, slozka) {
  const r = git(cwd, ['show', `${ref}:${slozka}/.claude-plugin/plugin.json`]);
  if (!r.ok) return null;
  try { return JSON.parse(r.raw).version ?? null; } catch { return null; }
}

function verzeTed(cwd, slozka) {
  const f = join(cwd, slozka, '.claude-plugin', 'plugin.json');
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, 'utf8')).version ?? null; } catch { return null; }
}

// Změněné soubory pluginu od základu: rozdíl proti základu (včetně neuložených změn) a nové nesledované soubory.
export function zmeneneSoubory(cwd, ref, slozka) {
  const rozdil = git(cwd, ['diff', '--name-only', '-z', ref, '--', slozka]);
  const nove = git(cwd, ['ls-files', '-z', '--others', '--exclude-standard', '--', slozka]);
  const vsechny = [...rozdil.raw.split('\0'), ...nove.raw.split('\0')].filter(Boolean);
  return [...new Set(vsechny)].filter((f) => !BEZ_DOPADU.test(f)).sort();
}

// Vrátí seznam problémů (česky). pluginy: [{ name, slozka }]
export function zkontrolujVerze(cwd, zaklad, pluginy) {
  const problemy = [];
  for (const p of pluginy) {
    const zmeny = zmeneneSoubory(cwd, zaklad.ref, p.slozka);
    if (!zmeny.length) continue;
    const puvodni = verzeV(cwd, zaklad.ref, p.slozka);
    if (puvodni === null) continue; // plugin v základu nebyl: nový plugin
    const ted = verzeTed(cwd, p.slozka);
    const kde = `${p.slozka}/.claude-plugin/plugin.json`;
    const soubory = `${zmeny.slice(0, 5).join(', ')}${zmeny.length > 5 ? ` a dalších ${zmeny.length - 5}` : ''}`;
    const cmp = porovnejVerze(ted, puvodni);
    if (cmp === null) problemy.push(`${p.name}: verze v ${kde} ("${ted}") nebo ve ${zaklad.popis} ("${puvodni}") není semver.`);
    else if (cmp === 0) problemy.push(`${p.name}: změnily se soubory pluginu (${soubory}), ale version v ${kde} zůstala ${ted} jako ve ${zaklad.popis}. Zvyš ji, jinak se změna k uživatelům nedostane.`);
    else if (cmp < 0) problemy.push(`${p.name}: version v ${kde} je ${ted}, ve ${zaklad.popis} byla ${puvodni}; verze se nesmí snižovat.`);
  }
  return problemy;
}
