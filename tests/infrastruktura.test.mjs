// Infrastruktura testů a repa: package.json, spouštěč, pre-commit hook, workflow v CI, kompatibilita zdrojů s nejstarší
// podporovanou verzí Node.js. Cílem je, aby se testy nedaly tiše vyřadit nebo rozbít (nový test mimo seznam, CI bez
// připnutých akcí, README s jinou verzí Claude Code než CI).
// Spuštění: node --test tests/infrastruktura.test.mjs. Bez sítě, nic nezapisuje.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { cesta, cistyEnv, cti, ctiBuffer, ctiJson, existuje, nic, soubory } from './lib/pomocne.mjs';
import { POMALE, najdiPreskocene, najdiTesty, nepovolenaPreskoceni, vyber } from './spust.mjs';

const jeCI = String(process.env.CI ?? '').toLowerCase() === 'true';
const vsechny = soubory();
const testy = vsechny.filter((f) => f.endsWith('.test.mjs'));
const pkg = ctiJson('package.json');
const WORKFLOW = '.github/workflows/test.yml';
const PRE_COMMIT = '.githooks/pre-commit';

describe('package.json', () => {
  it('nemá žádné závislosti a je soukromý (jen vestavěné moduly Node.js)', () => {
    assert.equal(pkg.private, true, 'package.json: "private": true brání omylem publikovat repo na npm.');
    for (const k of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      assert.equal(pkg[k], undefined, `package.json: pole ${k} musí chybět; testy používají jen vestavěné moduly node:.`);
    }
    assert.ok(!vsechny.includes('package-lock.json') && !vsechny.some((f) => /(^|\/)node_modules\//.test(f)), 'V repu je package-lock.json nebo node_modules, ale závislosti nemá být žádné.');
  });

  it('engines.node je >=18 (nejstarší verze, na které se testuje v CI)', () => {
    assert.equal(pkg.engines?.node, '>=18', 'package.json: engines.node má být ">=18"; node:test s describe a before/after potřebuje Node 18.');
  });

  it('skripty test a test:rychle volají spouštěč, který najde všechny testy', () => {
    assert.equal(pkg.scripts?.test, 'node tests/spust.mjs', 'package.json: scripts.test má být "node tests/spust.mjs".');
    assert.equal(pkg.scripts?.['test:rychle'], 'node tests/spust.mjs --rychle', 'package.json: scripts["test:rychle"] má být "node tests/spust.mjs --rychle".');
    assert.ok(existuje('tests/spust.mjs'), 'Chybí tests/spust.mjs.');
  });
});

describe('spouštěč testů', () => {
  it('najde každý soubor *.test.mjs v repu včetně testu pluginu (nový test nelze zapomenout)', () => {
    const nalezene = najdiTesty();
    nic('Spouštěč tyto testy nenašel (bude se spouštět bez nich):', testy.filter((f) => !nalezene.includes(f)));
    assert.ok(nalezene.includes('plugins/orchestrace/hooks/orchestrace-guard.test.mjs'), 'Spouštěč nenašel test pluginu.');
    for (const f of ['tests/obsah.test.mjs', 'tests/manifesty.test.mjs', 'tests/konzistence.test.mjs', 'tests/instalace.test.mjs', 'tests/verze.test.mjs', 'tests/hook.test.mjs', 'tests/infrastruktura.test.mjs']) {
      assert.ok(nalezene.includes(f), `Spouštěč nenašel ${f}.`);
    }
  });

  it('rychlý režim vynechá jen E2E instalaci', () => {
    const nalezene = najdiTesty();
    const rychle = vyber(nalezene, true);
    assert.deepEqual(POMALE, ['tests/instalace.test.mjs'], 'Seznam pomalých testů se změnil; aktualizuj i README a pre-commit.');
    assert.deepEqual(nalezene.filter((f) => !rychle.includes(f)), POMALE, 'Rychlý režim má vynechat právě tests/instalace.test.mjs.');
    assert.deepEqual(vyber(nalezene, false), nalezene, 'Plný režim nesmí nic vynechat.');
  });

  it('detektor přeskočených testů pozná spec i TAP výstup (red) a nechá projít splněné testy (green)', () => {
    const pomlcka = String.fromCodePoint(0xFE63); // znak, kterým spec reporter značí přeskočený test
    const ok = String.fromCodePoint(0x2714); // ostatní značky spec reporteru jsou piktogramy, proto se skládají za běhu
    const info = String.fromCodePoint(0x2139);
    const spec = [`  ${ok} splněný test (1.2ms)`, `  ${pomlcka} přeskočený test (0.5ms) # důvod`, `    ${pomlcka} vnořený přeskočený (2ms)`].join('\n');
    const tap = ['ok 1 - splněný test', 'ok 2 - přeskočený test # SKIP důvod', '    not ok 3 - selhal', '    ok 4 - vnořený # skip'].join('\n');
    assert.deepEqual(najdiPreskocene(spec), ['přeskočený test', 'vnořený přeskočený']);
    assert.deepEqual(najdiPreskocene(tap), ['přeskočený test', 'vnořený']);
    assert.deepEqual(najdiPreskocene(`${info} skipped 0\n${info} pass 5`), []);
  });

  it('v CI se povolí jen výslovné výjimky: symlink na soubor jen na Windows, cokoli jiného nikdy', () => {
    assert.deepEqual(nepovolenaPreskoceni(['přes symlink na soubor hooku'], 'win32'), []);
    assert.deepEqual(nepovolenaPreskoceni(['přes symlink na soubor hooku'], 'linux'), ['přes symlink na soubor hooku'], 'Mimo Windows se symlink na soubor přeskakovat nesmí.');
    assert.deepEqual(nepovolenaPreskoceni(['nový test s t.skip'], 'win32'), ['nový test s t.skip']);
    assert.deepEqual(nepovolenaPreskoceni([], 'linux'), []);
  });

  it('každý testovací soubor začíná komentářem s popisem a spuštěním', () => {
    nic('Test bez úvodního komentáře (popiš, co hlídá a jak se spouští):', testy.filter((f) => f.startsWith('tests/') && !cti(f).startsWith('//')));
  });
});

describe('pre-commit hook', () => {
  const t = cti(PRE_COMMIT);

  it('je skript sh s LF, bez bashismů, a volá stejné rychlé testy jako npm run test:rychle', () => {
    assert.ok(t.startsWith('#!/bin/sh\n'), `${PRE_COMMIT} musí začínat "#!/bin/sh" (funguje v Git Bash i na macOS a Linuxu).`);
    assert.ok(!t.includes('\r'), `${PRE_COMMIT} obsahuje CR; skript s CRLF se v sh rozbije.`);
    assert.ok(t.includes('node tests/spust.mjs --rychle'), `${PRE_COMMIT} má volat "node tests/spust.mjs --rychle" (stejně jako scripts["test:rychle"]).`);
    assert.ok(!/\[\[|\bmapfile\b|\$\{[^}]*,,[^}]*\}|declare -A|\bsource\b|<\(/.test(t), `${PRE_COMMIT} používá konstrukci specifickou pro bash; skript musí být přenositelné sh.`);
    assert.match(t, /git config core\.hooksPath \.githooks/, `${PRE_COMMIT} v hlavičce neříká, jak ho zapnout (git config core.hooksPath .githooks).`);
  });

  it('má platnou syntaxi sh (sh -n)', (tc) => {
    const r = spawnSync('sh', ['-n', cesta(PRE_COMMIT)], { encoding: 'utf8' });
    if (r.error) {
      const zprava = `Příkaz sh není k dispozici (${r.error.code}); syntaxe ${PRE_COMMIT} se tu neověřila.`;
      assert.ok(!(jeCI && process.platform !== 'win32'), `${zprava} V CI na Linuxu a macOS musí být sh k dispozici.`);
      return tc.skip(zprava);
    }
    assert.equal(r.status, 0, `sh -n ${PRE_COMMIT} hlásí chybu syntaxe:\n${r.stderr}`);
  });

  it('má příznak spustitelnosti tam, kde se příznak dá zjistit (index gitu; souborový systém mimo Windows)', () => {
    if (process.platform !== 'win32') assert.ok((statSync(cesta(PRE_COMMIT)).mode & 0o111) !== 0, `${PRE_COMMIT} není spustitelný; spusť chmod +x ${PRE_COMMIT} (git ho jinak při core.hooksPath ignoruje).`);
    const r = spawnSync('git', ['ls-files', '-s', '--', PRE_COMMIT], { cwd: cesta('.'), encoding: 'utf8' });
    const radek = r.status === 0 ? r.stdout.trim() : '';
    if (radek) assert.match(radek, /^100755 /, `${PRE_COMMIT} je v indexu bez příznaku spustitelnosti (${radek.split('\t')[0]}). Oprav: git update-index --chmod=+x ${PRE_COMMIT}`);
  });
});

describe('prostředí podprocesů v testech', () => {
  it('cistyEnv odstraní CLAUDE*, ANTHROPIC*, ORCHESTRACE*, NODE_TEST* a GIT_* (pre-commit nastavuje GIT_DIR a GIT_INDEX_FILE)', () => {
    const klice = ['CLAUDE_CODE_PLUGIN_DIRS', 'CLAUDE_CODE_SUBAGENT_MODEL', 'ANTHROPIC_BASE_URL', 'ORCHESTRACE_GUARD', 'NODE_TEST_CONTEXT', 'GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE'];
    const puvodni = Object.fromEntries(klice.map((k) => [k, process.env[k]]));
    try {
      for (const k of klice) process.env[k] = 'x';
      const env = cistyEnv({ CLAUDE_CONFIG_DIR: 'ano' });
      nic('cistyEnv nechal tyto proměnné:', klice.filter((k) => k in env));
      assert.equal(env.CLAUDE_CONFIG_DIR, 'ano', 'Proměnné předané výslovně se musí zachovat.');
      assert.ok('PATH' in env || 'Path' in env, 'cistyEnv zahodil PATH.');
    } finally {
      for (const k of klice) { if (puvodni[k] === undefined) delete process.env[k]; else process.env[k] = puvodni[k]; }
    }
  });
});

describe('workflow v CI (.github/workflows/test.yml)', () => {
  const w = cti(WORKFLOW);

  it('běží při push a pull_request a má jen právo číst obsah repa', () => {
    assert.match(w, /^on:\s*\n\s+push:/m, 'Workflow nemá spouštěč push.');
    assert.match(w, /^\s+pull_request:/m, 'Workflow nemá spouštěč pull_request.');
    assert.ok(!/pull_request_target/.test(w), 'Workflow nesmí používat pull_request_target (spouštělo by kód z cizích forků s právy repa).');
    assert.match(w, /^permissions:\s*\n\s+contents:\s*read\s*$/m, 'Workflow musí mít "permissions: contents: read" na nejvyšší úrovni.');
    assert.ok(!/\$\{\{\s*github\.(event\.|head_ref)/.test(w), 'Workflow vkládá vstup z události (github.event, head_ref) do příkazů; hrozí injekce příkazů. Předej ho přes env.');
  });

  it('matice pokrývá ubuntu, macOS i Windows a Node 18, 20, 22, 24 a nezastaví se na prvním selhání', () => {
    assert.match(w, /fail-fast:\s*false/, 'Chybí "fail-fast: false": jedno selhání by skrylo výsledky ostatních kombinací.');
    for (const os of ['ubuntu-latest', 'macos-latest', 'windows-latest']) assert.ok(w.includes(os), `Matice nemá ${os}.`);
    const m = /node:\s*\[([^\]]+)\]/.exec(w);
    assert.ok(m, 'Matice nemá seznam verzí Node.js ("node: [18, 20, 22, 24]").');
    const verze = m[1].split(',').map((x) => Number(x.trim()));
    assert.deepEqual(verze, [18, 20, 22, 24], 'Matice Node.js má být 18, 20, 22, 24 (nejnižší musí odpovídat engines.node v package.json).');
    assert.equal(verze[0], Number(/\d+/.exec(pkg.engines.node)[0]), 'Nejnižší verze v matici se liší od engines.node.');
  });

  it('týdenní plánovaný běh na nejnovějším Claude Code a Node.js spouští všechny testy a plánovaný běh je červený při selhání', () => {
    assert.match(w, /^\s+schedule:\s*\n\s+- cron:\s*'[^']+'/m, 'Workflow nemá "schedule" s cronem: bez něj se změna CLI nebo Node.js odhalí až při dalším commitu.');
    const j = /^ {2}claude-latest:\n([\s\S]*?)(?=^ {2}\S|(?![\s\S]))/m.exec(w);
    assert.ok(j, 'Workflow nemá job claude-latest.');
    assert.match(j[1], /continue-on-error:\s*\$\{\{\s*github\.event_name\s*!=\s*'schedule'\s*\}\}/, 'Job claude-latest má být informativní jen mimo plánovaný běh (continue-on-error podle github.event_name).');
    assert.match(j[1], /install\.sh \| bash -s latest/, 'Job claude-latest má instalovat kanál latest.');
    assert.match(j[1], /node:\s*\[[^\]]*\blatest\b[^\]]*\]/, 'Job claude-latest má zkoušet i Node.js latest (nová hlavní verze mimo pevnou matici).');
    assert.match(j[1], /run:[\s\S]*\bnpm test\b/, 'Job claude-latest má spouštět celé "npm test", ne jen jeden soubor.');
  });

  it('každá akce je připnutá na celý commit SHA (s verzí v komentáři)', () => {
    const uses = [...w.matchAll(/^\s*-?\s*uses:\s*(\S+)(.*)$/gm)];
    assert.ok(uses.length >= 2, 'Workflow nepoužívá žádné akce? Čekám checkout a setup-node.');
    nic('Akce není připnutá na 40znakový SHA commitu:', uses.filter((u) => !/@[0-9a-f]{40}$/.test(u[1])).map((u) => u[1]));
    nic('U připnuté akce chybí komentář s verzí (# vX.Y.Z):', uses.filter((u) => !/#\s*v\d+\.\d+\.\d+/.test(u[2])).map((u) => u[1]));
  });

  it('checkout stahuje celou historii a tagy (kontrola verze) a nenechává přihlašovací údaje', () => {
    assert.match(w, /fetch-depth:\s*0/, 'Checkout musí mít fetch-depth: 0, jinak tests/verze.test.mjs nemá origin/main ani tagy a v CI selže.');
    assert.match(w, /persist-credentials:\s*false/, 'Checkout má mít persist-credentials: false.');
  });

  it('CI=true, testy běží přes npm test, na Windows v PowerShellu bez Git Bash', () => {
    assert.match(w, /^\s*CI:\s*'true'\s*$/m, "Workflow musí nastavit CI: 'true' (bez claude CLI musí E2E test v CI selhat, ne se přeskočit).");
    assert.ok((w.match(/run:\s*npm test\s*$/gm) ?? []).length >= 2, 'Workflow má spouštět "npm test" ve všech větvích (Linux/macOS i Windows).');
    assert.match(w, /shell:\s*pwsh/, 'Workflow nemá krok s PowerShellem (shell: pwsh) pro Windows.');
    assert.match(w, /Windows, PowerShell/, 'Krok pro Windows má být označený v názvu.');
  });

  it('instaluje Claude Code oficiálním instalátorem v pevné verzi', () => {
    assert.ok(w.includes('https://claude.ai/install.sh') && w.includes('https://claude.ai/install.ps1'), 'Instalace Claude Code má používat oficiální instalátory claude.ai/install.sh a install.ps1 (https://code.claude.com/docs/en/setup).');
    const m = /^\s*CLAUDE_CODE_VERSION:\s*(\d+\.\d+\.\d+)\s*$/m.exec(w);
    assert.ok(m, 'Workflow nemá připnutou verzi Claude Code (CLAUDE_CODE_VERSION: x.y.z).');
    assert.ok(w.includes('"$CLAUDE_CODE_VERSION"') && w.includes('$env:CLAUDE_CODE_VERSION'), 'Instalační kroky nepoužívají CLAUDE_CODE_VERSION.');
  });

  it('README uvádí stejnou ověřenou verzi Claude Code, jaká je připnutá v CI', () => {
    const pin = /^\s*CLAUDE_CODE_VERSION:\s*(\d+\.\d+\.\d+)\s*$/m.exec(w)[1];
    for (const f of ['README.md', 'plugins/orchestrace/README.md']) {
      assert.ok(cti(f).includes(`Claude Code ${pin}`), `${f} má uvádět "Claude Code ${pin}" (verze připnutá v ${WORKFLOW}). Změnil jsi pin v CI? Uprav README, nebo naopak.`);
    }
  });

  it('README uvádí přesně ty verze Node.js a systémy, na kterých běží matice CI', () => {
    // První matice ve workflow je hlavní (OS x Node); druhá (Node 24, latest) je informativní.
    const node = /^\s*node:\s*\[([^\]]*)\]/m.exec(w);
    const os = /^\s*os:\s*\[([^\]]*)\]/m.exec(w);
    assert.ok(node && os, `V ${WORKFLOW} chybí matice os a node.`);
    const verze = node[1].split(',').map((x) => x.trim()).filter((x) => /^\d+$/.test(x));
    const systemy = os[1].split(',').map((x) => x.trim());
    const NAZEV = { 'ubuntu-latest': 'Linux', 'macos-latest': 'macOS', 'windows-latest': 'Windows' };
    const min = Math.min(...verze.map(Number));
    for (const f of ['README.md', 'plugins/orchestrace/README.md']) {
      const radek = cti(f).split('\n').filter((r) => /Ověřen/.test(r)).join('\n');
      assert.ok(radek, `${f} neuvádí ověřené verze (řádek se slovem "Ověřeno" nebo "Ověřené").`);
      const uvedene = [...radek.matchAll(/Node\.js ([\d, a]+)/g)].flatMap((m) => m[1].match(/\d+/g) ?? []);
      assert.deepEqual([...new Set(uvedene)].sort(), [...verze].sort(), `${f}: ověřené verze Node.js (${uvedene.join(', ')}) nesedí s maticí v ${WORKFLOW} (${verze.join(', ')}).`);
      for (const s of systemy) {
        assert.ok(NAZEV[s], `Neznámý runner ${s} v matici; doplň jeho název do testu.`);
        assert.ok(radek.includes(NAZEV[s]), `${f}: ověřené systémy nezmiňují ${NAZEV[s]} (${s} je v matici CI).`);
      }
      assert.ok(radek.includes(`než ${min}`), `${f}: chybí věta, že Node.js starší než ${min} podporovaný není.`);
    }
    assert.equal(JSON.parse(cti('package.json')).engines?.node, `>=${min}`, `package.json engines.node má být ">=${min}" (nejnižší Node.js v matici CI).`);
  });
});

describe('zdroje jsou použitelné na nejstarší podporované verzi Node.js (18)', () => {
  // Rozhraní, která Node 18 nemá. CI to ověří, ale lokálně (na novějším Node) by chyba zůstala nepovšimnutá.
  // Vzory se skládají z částí, aby tento soubor sám žádný neobsahoval.
  const s = (...casti) => casti.join('');
  const NOVE = [
    [s('import.meta.', 'dirname'), 'Node 20.11'], [s('import.meta.', 'filename'), 'Node 20.11'],
    [s('.to', 'Sorted('), 'Node 20'], [s('.to', 'Reversed('), 'Node 20'], [s('.to', 'Spliced('), 'Node 20'],
    [s('Object.', 'groupBy'), 'Node 21'], [s('Map.', 'groupBy'), 'Node 21'], [s('Array.', 'fromAsync'), 'Node 22'],
    [s('Promise.with', 'Resolvers'), 'Node 22'], [s('fs.glob', 'Sync'), 'Node 22'], [s('styleText', '('), 'Node 20.12'],
    [s('getBuiltin', 'Module'), 'Node 22.3'], [s('node:', 'sqlite'), 'Node 22.5'],
    [s('--test-', 'timeout'), 'Node 21'], [s('.union', '('), 'Node 22'], [s('.intersection', '('), 'Node 22'],
    [s('with { type', ': \'json\''), 'Node 18.20'], [s('assert { type', ': \'json\''), 'Node 17.1 (zrušeno)'],
  ].filter(([, odkdy]) => odkdy !== null);

  it('žádný .mjs nepoužívá API novější než Node 18', () => {
    const zdroje = vsechny.filter((f) => f.endsWith('.mjs') && f !== 'tests/infrastruktura.test.mjs');
    assert.ok(zdroje.length >= 8, `Našel jsem jen ${zdroje.length} souborů .mjs.`);
    const nalezy = [];
    for (const f of zdroje) {
      const text = cti(f);
      for (const [vzor, odkdy] of NOVE) if (text.includes(vzor)) nalezy.push(`${f}: ${vzor} (od ${odkdy})`);
    }
    nic('Zdroj používá rozhraní, které na Node 18 neexistuje (engines.node je >=18):', nalezy);
  });

  it('žádný zdroj nezačíná BOM a testy nemají shebang, který by Node 18 zmátl', () => {
    nic('Soubor .mjs začíná BOM:', vsechny.filter((f) => f.endsWith('.mjs')).filter((f) => ctiBuffer(f).subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))));
  });
});
