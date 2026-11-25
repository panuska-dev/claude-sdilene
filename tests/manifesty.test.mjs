// Manifesty: marketplace.json, plugin.json, hooks.json a frontmatter SKILL.md podle dokumentace Claude Code
// (https://code.claude.com/docs/en/plugins-reference, plugin-marketplaces, skills) a specifikace Agent Skills
// (https://agentskills.io/specification). Autoritativní kontrolu dělá `claude plugin validate`, ta běží v
// tests/instalace.test.mjs; tady jsou pravidla, která se dají ověřit bez Claude CLI a která validate nehlídá.
// Spuštění: node --test tests/manifesty.test.mjs. Bez sítě, nic nezapisuje.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { cesta, cti, ctiJson, existuje, jeSlozka, nactiMarketplace, nic, parsujFrontmatter, pluginy } from './lib/pomocne.mjs';

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const ID_CAST = /^[A-Za-z0-9][A-Za-z0-9._-]*$/; // část id pluginu@marketplace podle docs

// plugin-marketplaces: Reserved names
const REZERVOVANA_JMENA_MARKETPLACE = [
  'claude-code-marketplace', 'claude-code-plugins', 'claude-plugins-official', 'anthropic-marketplace', 'anthropic-plugins',
  'agent-skills', 'anthropic-agent-skills', 'life-sciences', 'knowledge-work-plugins', 'claude-for-legal',
  'claude-for-financial-services', 'financial-services-plugins', 'first-party-plugins', 'claude-tag-plugins',
  'claude-community', 'claude-plugins-community', 'healthcare', 'anthropic-plugin-directory', 'claude-plugin-directory',
  'inline', 'builtin', 'skills-dir', 'synced', 'claude-plugin-test',
  'constructor', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString', 'toString', 'valueOf',
];

// plugins-reference: Fields; marketplace-reference: Top-level fields a Plugin entries. Neznámý klíč se načte bez chyby
// a překlep tak zůstane nepovšimnut, proto se hlídá.
const MARKETPLACE_KLICE = ['$schema', 'name', 'owner', 'plugins', 'description', 'version', 'metadata', 'forceRemoveDeletedPlugins', 'allowCrossMarketplaceDependenciesOn', 'renames'];
const PLUGIN_KLICE = [
  '$schema', 'name', 'displayName', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'metadata',
  'icon', 'documentationUrl', 'supportUrl', 'privacyPolicyUrl', 'termsOfServiceUrl', 'defaultEnabled', 'engines', 'dependencies',
  'network', 'userConfig', 'types', 'channels', 'skills', 'commands', 'agents', 'hooks', 'mcpServers', 'lspServers', 'outputStyles',
  'workflows', 'experimental',
];
const ENTRY_KLICE = [...PLUGIN_KLICE.filter((k) => !['icon', 'documentationUrl', 'supportUrl', 'privacyPolicyUrl', 'termsOfServiceUrl', '$schema'].includes(k)),
  'source', 'category', 'tags', 'strict', 'relevance', 'headers', 'headersHelper'];

// SPDX identifikátor v plugin.json -> úvodní řádek souboru LICENSE (musí sedět oběma směry)
const LICENSE_UVOD = {
  'MIT': /^MIT License/,
  'Apache-2.0': /^\s*Apache License\s+Version 2\.0/,
  'ISC': /^ISC License/,
  'BSD-3-Clause': /^BSD 3-Clause License/,
  'BSD-2-Clause': /^BSD 2-Clause License/,
  'Unlicense': /^This is free and unencumbered software/,
};

// agentskills.io: name nejvýše 64 znaků, popis nejvýše 1024 znaků (Claude Code navíc ořezává seznam skillů na 1536 znaků)
const SKILL_JMENO_MAX = 64;
const SKILL_POPIS_MAX = 1024;
const SKILL_RADKU_MAX = 500; // doporučení spec: SKILL.md pod 500 řádků, detaily do dalších souborů

const mp = nactiMarketplace();
const seznam = pluginy();

function manifestPluginu(slozka) {
  return ctiJson(`${slozka}/.claude-plugin/plugin.json`);
}

describe('marketplace.json', () => {
  it('má jen známé klíče na nejvyšší úrovni (překlep by se načetl bez chyby)', () => {
    nic('Neznámé klíče v .claude-plugin/marketplace.json (překlep? povolené jsou ' + MARKETPLACE_KLICE.join(', ') + '):',
      Object.keys(mp).filter((k) => !MARKETPLACE_KLICE.includes(k)));
  });

  it('name je platný a nerezervovaný', () => {
    assert.equal(typeof mp.name, 'string', 'marketplace.json: pole "name" chybí nebo není řetězec.');
    assert.match(mp.name, ID_CAST, `marketplace.json: name "${mp.name}" smí obsahovat jen písmena a-z A-Z, číslice, ".", "_" a "-" a musí začínat písmenem nebo číslicí (uživatelé ho píšou za @ v příkazu install).`);
    assert.ok(!mp.name.includes('..'), 'marketplace.json: name nesmí obsahovat "..".');
    assert.ok(mp.name.length <= 128, 'marketplace.json: name je delší než 128 znaků (Claude Desktop ho odmítne).');
    assert.ok(!REZERVOVANE(mp.name), `marketplace.json: name "${mp.name}" je rezervované jméno Claude Code. Zvol jiné.`);
    assert.ok(!mp.name.startsWith('claudeai-'), 'marketplace.json: jména začínající "claudeai-" jsou rezervovaná pro marketplace na claude.ai.');
    assert.ok(/^[\x20-\x7e]+$/.test(mp.name), 'marketplace.json: name smí obsahovat jen ASCII znaky.');
  });

  it('owner.name je neprázdný řetězec', () => {
    assert.ok(mp.owner && typeof mp.owner === 'object', 'marketplace.json: pole "owner" chybí (povinné: name, plugins, owner).');
    assert.ok(typeof mp.owner.name === 'string' && mp.owner.name.trim(), 'marketplace.json: owner.name chybí nebo je prázdné.');
  });

  it('description je neprázdný řetězec (validate jinak varuje)', () => {
    assert.ok(typeof mp.description === 'string' && mp.description.trim(), 'marketplace.json: doplň "description", uživatelé ji vidí v seznamu marketplace.');
  });

  it('plugins je neprázdné pole a jména se neopakují', () => {
    assert.ok(Array.isArray(mp.plugins) && mp.plugins.length >= 1, 'marketplace.json: pole "plugins" je prázdné nebo chybí.');
    const videno = new Set();
    const duplicity = [];
    for (const p of mp.plugins) { if (videno.has(p.name)) duplicity.push(p.name); videno.add(p.name); }
    nic('marketplace.json: jména pluginů se opakují:', duplicity);
  });

  for (const p of mp.plugins) {
    describe(`položka pluginu ${p.name}`, () => {
      it('má platné name, popis a jen známé klíče', () => {
        assert.match(String(p.name), ID_CAST, `marketplace.json: jméno pluginu "${p.name}" smí obsahovat jen písmena, číslice, ".", "_" a "-" a začínat písmenem nebo číslicí.`);
        assert.ok(typeof p.description === 'string' && p.description.trim(), `marketplace.json: plugin ${p.name} nemá "description" (zobrazí se v /plugin).`);
        nic(`marketplace.json: plugin ${p.name} má neznámé klíče:`, Object.keys(p).filter((k) => !ENTRY_KLICE.includes(k)));
      });

      it('source je relativní cesta ./... bez "..", bez zpětných lomítek, a složka existuje', () => {
        assert.equal(typeof p.source, 'string', `marketplace.json: plugin ${p.name}: source musí být řetězec s relativní cestou.`);
        assert.ok(p.source.startsWith('./'), `marketplace.json: plugin ${p.name}: source "${p.source}" musí začínat "./" (cesta od kořene marketplace).`);
        assert.ok(!p.source.split('/').includes('..'), `marketplace.json: plugin ${p.name}: source "${p.source}" nesmí obsahovat "..".`);
        assert.ok(!p.source.includes('\\'), `marketplace.json: plugin ${p.name}: source "${p.source}" nesmí obsahovat zpětná lomítka, na macOS a Linuxu ho Claude Code odmítne.`);
        const slozka = p.source.replace(/^\.\//, '').replace(/\/$/, '');
        assert.ok(jeSlozka(slozka), `marketplace.json: plugin ${p.name}: složka "${p.source}" neexistuje (instalace by selhala s "Source path does not exist").`);
      });
    });
  }
});

function REZERVOVANE(jmeno) {
  return REZERVOVANA_JMENA_MARKETPLACE.includes(jmeno);
}

describe('plugin.json každého pluginu', () => {
  for (const p of seznam) {
    describe(p.name, () => {
      it('existuje a má povinné i doporučené položky', () => {
        assert.ok(existuje(`${p.slozka}/.claude-plugin/plugin.json`), `Chybí ${p.slozka}/.claude-plugin/plugin.json.`);
        const pj = manifestPluginu(p.slozka);
        assert.equal(typeof pj.name, 'string', `${p.slozka}/.claude-plugin/plugin.json: pole "name" je povinné.`);
        assert.ok(pj.description && typeof pj.description === 'string', `${p.slozka}/.claude-plugin/plugin.json: doplň "description".`);
        assert.ok(pj.author && typeof pj.author.name === 'string' && pj.author.name.trim(), `${p.slozka}/.claude-plugin/plugin.json: author.name je povinné, pokud je author uveden (validate varuje, když chybí).`);
        assert.ok(typeof pj.license === 'string' && pj.license.trim(), `${p.slozka}/.claude-plugin/plugin.json: doplň "license" (SPDX, např. MIT).`);
        nic(`${p.slozka}/.claude-plugin/plugin.json: neznámé klíče (překlep? Claude Code je tiše zahodí):`, Object.keys(pj).filter((k) => !PLUGIN_KLICE.includes(k)));
      });

      it('name je kebab-case a nevydává se za plugin Anthropic', () => {
        const { name } = manifestPluginu(p.slozka);
        assert.match(name, KEBAB, `plugin.json: name "${name}" musí být kebab-case (malá písmena, číslice, pomlčky).`);
        assert.ok(!/^(claude-|anthropic-|anthropics-|cc-plugin-)/i.test(name), `plugin.json: name "${name}" začíná rezervovanou předponou (claude-, anthropic-, anthropics-, cc-plugin-).`);
        assert.ok(!['claude', 'anthropic', 'anthropics', 'claude-code', 'claude-mods'].includes(name.toLowerCase()), `plugin.json: name "${name}" je rezervované.`);
        assert.ok(!/official/i.test(name) || !/claude|anthropic/i.test(name), `plugin.json: name "${name}" kombinuje "official" s claude/anthropic.`);
      });

      it('version je ve tvaru semver (x.y.z)', () => {
        const { version } = manifestPluginu(p.slozka);
        assert.equal(typeof version, 'string', `${p.slozka}/.claude-plugin/plugin.json: chybí "version". Bez ní se každý commit tváří jako nová verze; s ní se změna dostane k uživatelům jen po zvýšení čísla.`);
        assert.match(version, SEMVER, `plugin.json: version "${version}" není ve tvaru semver (např. 1.0.1).`);
      });

      it('homepage a repository jsou URL s https', () => {
        const pj = manifestPluginu(p.slozka);
        for (const k of ['homepage', 'repository']) {
          assert.ok(typeof pj[k] === 'string', `plugin.json: doplň "${k}".`);
          let url;
          try { url = new URL(pj[k]); } catch { assert.fail(`plugin.json: "${k}" (${pj[k]}) není platná URL.`); }
          assert.equal(url.protocol, 'https:', `plugin.json: "${k}" musí být https URL.`);
        }
      });

      it('license odpovídá souboru LICENSE v kořeni repa', () => {
        const { license } = manifestPluginu(p.slozka);
        assert.ok(existuje('LICENSE'), 'Chybí soubor LICENSE v kořeni repa.');
        const text = cti('LICENSE');
        const znamy = Object.keys(LICENSE_UVOD);
        assert.ok(znamy.includes(license), `plugin.json: license "${license}" nemá známý úvodní řádek souboru LICENSE (umím: ${znamy.join(', ')}). Přidej ho do LICENSE_UVOD v tests/manifesty.test.mjs.`);
        assert.match(text, LICENSE_UVOD[license], `plugin.json deklaruje ${license}, ale LICENSE tak nezačíná.`);
        // opačný směr: text LICENSE nesmí patřit jiné licenci, než jakou plugin.json deklaruje
        for (const [spdx, re] of Object.entries(LICENSE_UVOD)) {
          if (spdx !== license) assert.ok(!re.test(text), `LICENSE vypadá jako ${spdx}, ale plugin.json deklaruje ${license}.`);
        }
      });
    });
  }
});

describe('shoda marketplace.json a plugin.json', () => {
  it('jméno položky v marketplace.json je stejné jako name v plugin.json (jinak install podle jména selže)', () => {
    nic('Jména se liší (entry name != plugin.json name):', seznam
      .filter((p) => manifestPluginu(p.slozka).name !== p.name)
      .map((p) => `marketplace.json "${p.name}" x ${p.slozka}/.claude-plugin/plugin.json "${manifestPluginu(p.slozka).name}"`));
  });

  it('složka pluginu se jmenuje stejně jako plugin', () => {
    nic('Složka pluginu má jiný název než plugin:', seznam.filter((p) => p.slozka !== `plugins/${p.name}`).map((p) => `${p.name} je ve složce ${p.slozka}, čekám plugins/${p.name}`));
  });

  it('pokud položka v marketplace.json uvádí version, shoduje se s plugin.json (jinak vyhrává plugin.json a validate varuje)', () => {
    nic('Verze se liší:', mp.plugins.filter((p) => p.version !== undefined && p.version !== manifestPluginu(String(p.source).replace(/^\.\//, '')).version)
      .map((p) => `${p.name}: marketplace.json ${p.version}, plugin.json ${manifestPluginu(String(p.source).replace(/^\.\//, '')).version}`));
  });

  it('každá složka v plugins/ je v marketplace.json a naopak', () => {
    assert.ok(jeSlozka('plugins'), 'Chybí složka plugins/.');
    const naDisku = readdirSync(cesta('plugins'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => `plugins/${e.name}`).sort();
    const vMarketplace = seznam.map((p) => p.slozka).sort();
    nic('Složky v plugins/ bez položky v marketplace.json (plugin by se neinstaloval):', naDisku.filter((d) => !vMarketplace.includes(d)));
    nic('Položky v marketplace.json bez složky v plugins/:', vMarketplace.filter((d) => !naDisku.includes(d)));
  });
});

describe('skills každého pluginu', () => {
  for (const p of seznam) {
    const skillRoot = `${p.slozka}/skills`;
    const slozky = jeSlozka(skillRoot)
      ? readdirSync(cesta(skillRoot), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()
      : [];

    it(`${p.name}: obsahuje aspoň jeden skill (SKILL.md v každé složce skills/*)`, () => {
      assert.ok(slozky.length >= 1, `${skillRoot}: žádná složka se skillem (čekám skills/<jméno>/SKILL.md).`);
      nic(`${skillRoot}: složky bez SKILL.md:`, slozky.filter((s) => !existuje(`${skillRoot}/${s}/SKILL.md`)));
    });

    for (const s of slozky.filter((x) => existuje(`${skillRoot}/${x}/SKILL.md`))) {
      const soubor = `${skillRoot}/${s}/SKILL.md`;
      describe(soubor, () => {
        const fm = parsujFrontmatter(cti(soubor));

        it('frontmatter začíná na prvním řádku a je platný', () => {
          assert.ok(!fm.chyba, `${soubor}: ${fm.chyba}.`);
        });

        it('name odpovídá názvu složky a pravidlům specifikace', () => {
          assert.equal(fm.data.name, s, `${soubor}: name "${fm.data.name}" musí být stejné jako název složky "${s}".`);
          assert.ok(fm.data.name.length <= SKILL_JMENO_MAX, `${soubor}: name je delší než ${SKILL_JMENO_MAX} znaků.`);
          assert.match(fm.data.name, KEBAB, `${soubor}: name smí obsahovat jen malá písmena a-z, číslice a pomlčky, bez pomlčky na začátku a na konci a bez dvou pomlček za sebou.`);
        });

        it(`description je neprázdný a nejvýše ${SKILL_POPIS_MAX} znaků`, () => {
          const d = fm.data.description ?? '';
          assert.ok(d.trim().length > 0, `${soubor}: chybí "description"; podle ní Claude pozná, kdy skill použít.`);
          assert.ok(d.length <= SKILL_POPIS_MAX, `${soubor}: description má ${d.length} znaků, limit specifikace Agent Skills je ${SKILL_POPIS_MAX}. Zkrať ji, klíčový případ použití dej na začátek.`);
          assert.ok(!/[<>]/.test(d), `${soubor}: description nesmí obsahovat < a > (Claude Code je zobrazí jako entity).`);
        });

        it(`SKILL.md je kratší než ${SKILL_RADKU_MAX} řádků (detaily patří do REFERENCE.md)`, () => {
          const radku = cti(soubor).split('\n').length;
          assert.ok(radku < SKILL_RADKU_MAX, `${soubor}: má ${radku} řádků, doporučení je pod ${SKILL_RADKU_MAX}. Přesuň podrobnosti do dalšího souboru ve složce skillu.`);
        });
      });
    }
  }
});

describe('hooks.json každého pluginu', () => {
  for (const p of seznam) {
    const soubor = `${p.slozka}/hooks/hooks.json`;
    if (!existuje(soubor)) continue;
    describe(soubor, () => {
      const hj = ctiJson(soubor);

      it('má obálku "hooks" a události jako pole (soubor jen s mapou událostí se nenačte)', () => {
        assert.ok(hj.hooks && typeof hj.hooks === 'object' && !Array.isArray(hj.hooks), `${soubor}: nejvyšší klíč musí být "hooks" s mapou událostí (např. {"hooks": {"PreToolUse": [...]}}).`);
        assert.ok(Object.keys(hj.hooks).length >= 1, `${soubor}: žádná událost.`);
        for (const [udalost, skupiny] of Object.entries(hj.hooks)) {
          assert.ok(Array.isArray(skupiny) && skupiny.length >= 1, `${soubor}: událost ${udalost} musí být neprázdné pole.`);
        }
      });

      it('každý handler je příkaz bez shellu: command bez mezer a metaznaků, argumenty v args, kladný timeout', () => {
        const problemy = [];
        let pocet = 0;
        for (const [udalost, skupiny] of Object.entries(hj.hooks)) {
          for (const skupina of skupiny) {
            if (skupina.matcher !== undefined) {
              try { new RegExp(skupina.matcher); } catch { problemy.push(`${udalost}: matcher "${skupina.matcher}" není platný regulární výraz`); }
            }
            for (const h of skupina.hooks ?? []) {
              pocet++;
              if (h.type !== 'command') problemy.push(`${udalost}: handler má type "${h.type}", čekám "command"`);
              if (typeof h.command !== 'string' || !h.command.trim()) { problemy.push(`${udalost}: handler nemá command`); continue; }
              if (/[\s"'|&;<>$`]/.test(h.command)) problemy.push(`${udalost}: command "${h.command}" obsahuje mezeru nebo metaznak; použij tvar exec: "command": "node" a cestu ve "args" (funguje i bez Git Bash na Windows)`);
              if (!Array.isArray(h.args) || h.args.some((a) => typeof a !== 'string')) problemy.push(`${udalost}: "args" musí být pole řetězců`);
              if (!(typeof h.timeout === 'number' && h.timeout > 0)) problemy.push(`${udalost}: chybí kladný "timeout" (jinak by zaseknutý hook držel volání nástroje)`);
            }
          }
        }
        assert.ok(pocet >= 1, `${soubor}: žádný handler.`);
        nic(`${soubor}:`, problemy);
      });

      it('skripty odkazované přes ${CLAUDE_PLUGIN_ROOT} existují v pluginu', () => {
        const chybi = [];
        let odkazu = 0;
        for (const skupiny of Object.values(hj.hooks)) {
          for (const skupina of skupiny) {
            for (const h of skupina.hooks ?? []) {
              for (const a of h.args ?? []) {
                const m = /^\$\{CLAUDE_PLUGIN_ROOT\}\/(.+)$/.exec(a);
                if (!m) continue;
                odkazu++;
                if (!existuje(`${p.slozka}/${m[1]}`)) chybi.push(`${a} (čekám soubor ${p.slozka}/${m[1]})`);
              }
            }
          }
        }
        assert.ok(odkazu >= 1, `${soubor}: žádný argument s \${CLAUDE_PLUGIN_ROOT}, hook by běžel z nejasného místa.`);
        nic(`${soubor}: odkazované skripty neexistují:`, chybi);
      });

      it('každá skupina PreToolUse a PostToolUse má matcher omezující nástroje (hook bez omezení běží při každém volání)', () => {
        const siroke = [];
        for (const udalost of ['PreToolUse', 'PostToolUse']) {
          for (const skupina of hj.hooks[udalost] ?? []) {
            const m = skupina.matcher;
            if (typeof m !== 'string' || ['', '*', '.*', '.+'].includes(m.trim())) siroke.push(`${udalost}: matcher ${JSON.stringify(m)} nezužuje nástroje`);
          }
        }
        nic(`${soubor}: hook by běžel při každém volání nástroje, zúži matcher na konkrétní nástroje:`, siroke);
      });
    });
  }
});

describe('každý plugin je otestovaný a zdokumentovaný', () => {
  for (const p of seznam) {
    describe(p.name, () => {
      it('každý skript hooku (hooks/*.mjs) má vedle sebe test *.test.mjs, který ho spouští', () => {
        const slozka = `${p.slozka}/hooks`;
        if (!jeSlozka(slozka)) return;
        const mjs = readdirSync(cesta(slozka)).filter((f) => f.endsWith('.mjs'));
        const skripty = mjs.filter((f) => !f.endsWith('.test.mjs'));
        const bezTestu = skripty.filter((f) => !mjs.includes(f.replace(/\.mjs$/, '.test.mjs')));
        nic(`${slozka}: skript hooku nemá test vedle zdroje (kód, který rozhoduje o zamítnutí volání, musí mít test):`, bezTestu);
        const nespousti = skripty.filter((f) => existuje(`${slozka}/${f.replace(/\.mjs$/, '.test.mjs')}`)
          && !cti(`${slozka}/${f.replace(/\.mjs$/, '.test.mjs')}`).includes(f));
        nic(`${slozka}: test nezmiňuje skript, který má testovat:`, nespousti);
      });

      it('má README.md', () => {
        assert.ok(existuje(`${p.slozka}/README.md`), `${p.slozka}/README.md chybí; plugin musí říct, co dělá, jak se instaluje a vypíná.`);
      });
    });
  }
});
