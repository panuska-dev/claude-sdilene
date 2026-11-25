// Pravidlo vydání: změní-li se soubory pluginu proti základu (sloučená základna s origin/main, poslední tag pluginu),
// musí být zvýšená version v plugin.json. Claude Code jinak nové verze pluginu k uživatelům nedoručí.
// Spuštění: node --test tests/verze.test.mjs. Git jen čte; samotest staví dočasný repozitář v tmp a nikdy nepoužívá
// uživatelskou konfiguraci gitu (identita jde přes proměnné prostředí, nic se nenastavuje).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ROOT, cistyEnv, nic, pluginy } from './lib/pomocne.mjs';
import { git, porovnejVerze, zaklady, zkontrolujVerze } from './lib/verze.mjs';

// ------------------------------------------------------------------ samotest na dočasném repozitáři

// adresa se skládá za běhu, aby v repu nebyl žádný e-mailový tvar (viz tests/zakazane.txt)
const ADRESA = ['test', 'example.invalid'].join('@');
const SLOZKA = 'plugins/ukazka';
const PLUGINY = [{ name: 'ukazka', slozka: SLOZKA }];

function nastav(tmp) {
  const env = cistyEnv({
    GIT_CONFIG_GLOBAL: join(tmp, 'prazdna-konfigurace'), GIT_CONFIG_SYSTEM: join(tmp, 'prazdna-konfigurace'), GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: ADRESA, GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: ADRESA,
  });
  const g = (...args) => {
    const r = git(tmp, args, env);
    assert.ok(r.ok, `git ${args.join(' ')} v dočasném repu selhal: ${r.chyba}`);
    return r.out;
  };
  const zapis = (rel, text) => { const f = join(tmp, rel); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, text); };
  const manifest = (v) => zapis(`${SLOZKA}/.claude-plugin/plugin.json`, JSON.stringify({ name: 'ukazka', version: v }));
  g('init', '-q');
  manifest('1.0.0');
  zapis(`${SLOZKA}/hooks/skript.mjs`, 'a\n');
  zapis(`${SLOZKA}/hooks/skript.test.mjs`, 't\n');
  zapis('README.md', 'x\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'zaklad', '--no-gpg-sign');
  return { g, zapis, manifest, env };
}

function s_repem(fn) {
  const tmp = mkdtempSync(join(tmpdir(), 'claude-sdilene-verze-'));
  try { return fn(tmp, nastav(tmp)); } finally { rmSync(tmp, { recursive: true, force: true }); }
}

describe('porovnání verzí', () => {
  it('řadí podle semver včetně předvydání', () => {
    const t = (a, b, want) => assert.equal(porovnejVerze(a, b), want, `porovnejVerze(${a}, ${b}) má být ${want}`);
    t('1.0.1', '1.0.0', 1); t('1.0.0', '1.0.0', 0); t('0.9.9', '1.0.0', -1); t('1.10.0', '1.9.0', 1);
    t('1.0.0-rc.1', '1.0.0', -1); t('1.0.0-rc.2', '1.0.0-rc.10', -1); t('2.0.0', '1.99.99', 1);
    assert.equal(porovnejVerze('x', '1.0.0'), null);
    assert.equal(porovnejVerze(undefined, '1.0.0'), null);
  });
});

// Samotest potřebuje git. Lokálně bez gitu se přeskočí s hláškou, v CI (CI=true) běží a bez gitu selže.
const jeCI0 = String(process.env.CI ?? '').toLowerCase() === 'true';
const bezGitu = !git(ROOT, ['--version']).ok && !jeCI0 ? 'Git není v PATH, samotest kontroly verzí se přeskakuje (v CI by selhal).' : false;

describe('kontrola zvýšení verze (samotest na dočasném repozitáři)', { skip: bezGitu }, () => {
  it('změna zdroje pluginu bez zvýšení verze se označí (red)', () => {
    s_repem((tmp, { g, zapis }) => {
      g('update-ref', 'refs/remotes/origin/main', 'HEAD');
      zapis(`${SLOZKA}/hooks/skript.mjs`, 'b\n');
      const z = zaklady(tmp, 'ukazka');
      assert.equal(z.length, 1, 'Základ z origin/main se měl najít.');
      const problemy = zkontrolujVerze(tmp, z[0], PLUGINY);
      assert.equal(problemy.length, 1, `Čekal jsem 1 problém, dostal: ${problemy.join(' | ')}`);
      assert.match(problemy[0], /zůstala 1\.0\.0/);
    });
  });

  it('změna se zvýšenou verzí projde (green)', () => {
    s_repem((tmp, { g, zapis, manifest }) => {
      g('update-ref', 'refs/remotes/origin/main', 'HEAD');
      zapis(`${SLOZKA}/hooks/skript.mjs`, 'b\n');
      manifest('1.0.1');
      assert.deepEqual(zkontrolujVerze(tmp, zaklady(tmp, 'ukazka')[0], PLUGINY), []);
    });
  });

  it('snížení verze se označí', () => {
    s_repem((tmp, { g, zapis, manifest }) => {
      g('update-ref', 'refs/remotes/origin/main', 'HEAD');
      zapis(`${SLOZKA}/hooks/skript.mjs`, 'b\n');
      manifest('0.9.0');
      assert.match(zkontrolujVerze(tmp, zaklady(tmp, 'ukazka')[0], PLUGINY)[0] ?? '', /nesmí snižovat/);
    });
  });

  it('nový nesledovaný soubor v pluginu bez zvýšení verze se označí', () => {
    s_repem((tmp, { g, zapis }) => {
      g('update-ref', 'refs/remotes/origin/main', 'HEAD');
      zapis(`${SLOZKA}/skills/novy/SKILL.md`, 'nový\n');
      assert.equal(zkontrolujVerze(tmp, zaklady(tmp, 'ukazka')[0], PLUGINY).length, 1);
    });
  });

  it('smazaný soubor pluginu bez zvýšení verze se označí', () => {
    s_repem((tmp, { g }) => {
      g('update-ref', 'refs/remotes/origin/main', 'HEAD');
      rmSync(join(tmp, SLOZKA, 'hooks', 'skript.mjs'));
      assert.equal(zkontrolujVerze(tmp, zaklady(tmp, 'ukazka')[0], PLUGINY).length, 1);
    });
  });

  it('změna jen testu v pluginu a změna mimo plugin verzi nevyžaduje', () => {
    s_repem((tmp, { g, zapis }) => {
      g('update-ref', 'refs/remotes/origin/main', 'HEAD');
      zapis(`${SLOZKA}/hooks/skript.test.mjs`, 'jiný test\n');
      zapis('README.md', 'jiný text\n');
      assert.deepEqual(zkontrolujVerze(tmp, zaklady(tmp, 'ukazka')[0], PLUGINY), []);
    });
  });

  it('plugin, který v základu nebyl, verzi nevyžaduje', () => {
    s_repem((tmp, { g, zapis }) => {
      g('update-ref', 'refs/remotes/origin/main', 'HEAD');
      zapis('plugins/novy/.claude-plugin/plugin.json', JSON.stringify({ name: 'novy', version: '0.1.0' }));
      zapis('plugins/novy/x.md', 'x\n');
      assert.deepEqual(zkontrolujVerze(tmp, zaklady(tmp, 'ukazka')[0], [{ name: 'novy', slozka: 'plugins/novy' }]), []);
    });
  });

  it('bez origin/main se použije poslední tag pluginu a změna bez zvýšení se označí', () => {
    s_repem((tmp, { g, zapis }) => {
      g('tag', 'ukazka--v1.0.0');
      zapis(`${SLOZKA}/hooks/skript.mjs`, 'b\n');
      g('add', '-A');
      g('commit', '-q', '-m', 'zmena', '--no-gpg-sign');
      const z = zaklady(tmp, 'ukazka');
      assert.deepEqual(z.map((x) => x.ref), ['ukazka--v1.0.0']);
      assert.equal(zkontrolujVerze(tmp, z[0], PLUGINY).length, 1);
    });
  });

  it('bez origin/main a bez tagu není s čím porovnávat', () => {
    s_repem((tmp) => assert.deepEqual(zaklady(tmp, 'ukazka'), []));
  });

  it('ignoruje GIT_DIR a GIT_INDEX_FILE z okolí (pre-commit hook je nastavuje na skutečné repo)', () => {
    const puvodni = { GIT_DIR: process.env.GIT_DIR, GIT_INDEX_FILE: process.env.GIT_INDEX_FILE };
    try {
      s_repem((tmp, { g, zapis }) => {
        g('update-ref', 'refs/remotes/origin/main', 'HEAD');
        zapis(`${SLOZKA}/hooks/skript.mjs`, 'b\n');
        process.env.GIT_DIR = join(ROOT, '.git');
        process.env.GIT_INDEX_FILE = join(ROOT, '.git', 'index');
        const z = zaklady(tmp, 'ukazka');
        assert.equal(z.length, 1, 'Základ se v dočasném repu nenašel, když je v prostředí GIT_DIR skutečného repa.');
        assert.equal(zkontrolujVerze(tmp, z[0], PLUGINY).length, 1, 'Kontrola v dočasném repu se řídí GIT_DIR z okolí.');
      });
    } finally {
      for (const [k, h] of Object.entries(puvodni)) { if (h === undefined) delete process.env[k]; else process.env[k] = h; }
    }
  });

  it('mimo git repozitář není s čím porovnávat a nic nespadne', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'claude-sdilene-bezgitu-'));
    try { assert.deepEqual(zaklady(tmp, 'ukazka'), []); } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
});

// ------------------------------------------------------------------ skutečné repo

describe('verze pluginů v tomto repu', () => {
  const seznam = pluginy();
  const jeCI = String(process.env.CI ?? '').toLowerCase() === 'true';

  it('změněný plugin má zvýšenou version proti origin/main a poslednímu tagu', (t) => {
    const gitDostupny = git(ROOT, ['--version']).ok && git(ROOT, ['rev-parse', '--git-dir']).ok;
    const vsechnyZaklady = gitDostupny ? seznam.flatMap((p) => zaklady(ROOT, p.name).map((z) => ({ ...z, plugin: p }))) : [];
    if (!vsechnyZaklady.length) {
      const zprava = gitDostupny
        ? 'Chybí základ pro porovnání: žádná větev origin/main (nebo origin/master) ani tag <plugin>--v<verze>. Po prvním pushi a po vydání s tagem se kontrola zapne sama.'
        : 'Git není k dispozici nebo se nespouští v repozitáři.';
      assert.ok(!jeCI, `${zprava} V CI se kontrola nesmí tiše přeskočit: checkout musí stáhnout celou historii a tagy (actions/checkout, fetch-depth: 0).`);
      return t.skip(`${zprava} Kontrola se přeskakuje jen lokálně.`);
    }
    const problemy = [];
    for (const z of vsechnyZaklady) problemy.push(...zkontrolujVerze(ROOT, z, [z.plugin]));
    nic('Pravidlo vydání porušeno (viz sekce Přispívání v README):', [...new Set(problemy)]);
  });
});
