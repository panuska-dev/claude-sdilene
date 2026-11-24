// Test orchestrace-guard.mjs: node orchestrace-guard.test.mjs (zapojení se kontroluje v hooks.json vedle testu)
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { decide, checkScript } from './orchestrace-guard.mjs';

const HOOK = fileURLToPath(new URL('./orchestrace-guard.mjs', import.meta.url));
const HOOKS_JSON = fileURLToPath(new URL('./hooks.json', import.meta.url));

let fails = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `: dostal ${JSON.stringify(got)}, čekal ${JSON.stringify(want)}`}`);
  if (!ok) fails++;
}

// pracovní složka s definicemi agentů; CONFIG je prázdná, aby se nečetl skutečný ~/.claude
const root = mkdtempSync(join(tmpdir(), 'orchestrace-guard-'));
const agents = join(root, 'proj', '.claude', 'agents');
mkdirSync(agents, { recursive: true });
mkdirSync(join(root, 'cfg'), { recursive: true });
writeFileSync(join(agents, 'ma-model.md'), '---\nname: ma-model\nmodel: haiku\n---\nTělo\n');
writeFileSync(join(agents, 'bez-modelu.md'), '---\nname: bez-modelu\ndescription: x\n---\nTělo\n');
writeFileSync(join(agents, 'dedi.md'), '---\nname: dedi\nmodel: inherit\n---\nTělo\n');
writeFileSync(join(agents, 'crlf.md'), '---\r\nname: crlf\r\nmodel: "sonnet"\r\n---\r\nTělo\r\n');
writeFileSync(join(agents, 'jiny-soubor.md'), '---\nname: pod-jinym-jmenem\nmodel: opus\n---\n');
const ENV = { CLAUDE_PROJECT_DIR: join(root, 'proj'), CLAUDE_CONFIG_DIR: join(root, 'cfg') };

const deny = (input, env = ENV) => decide(input, env) !== null;
const agent = (ti, tool = 'Agent') => ({ tool_name: tool, tool_input: ti });
const wf = (script) => ({ tool_name: 'Workflow', tool_input: { script } });
const lines = (script, hasModel = (type) => type === 'reviewer') => checkScript(script, hasModel).map((b) => `${b.line}:${b.missing.join('+')}`);

// nástroj Agent a Task
t('Agent bez model', deny(agent({ prompt: 'x' })), true);
t('Agent s prázdným model', deny(agent({ prompt: 'x', model: '  ' })), true);
t('Agent s model', deny(agent({ prompt: 'x', model: 'sonnet' })), false);
t('Agent bez effort je v pořádku', deny(agent({ prompt: 'x', model: 'haiku' })), false);
t('Agent general-purpose bez model', deny(agent({ prompt: 'x', subagent_type: 'general-purpose' })), true);
t('Agent fork bez model', deny(agent({ prompt: 'x', subagent_type: 'fork' })), false);
t('Agent z pluginu', deny(agent({ prompt: 'x', subagent_type: 'plugin:reviewer' })), false);
t('vlastní typ s model ve frontmatteru', deny(agent({ prompt: 'x', subagent_type: 'ma-model' })), false);
t('vlastní typ s model, CRLF a uvozovky', deny(agent({ prompt: 'x', subagent_type: 'crlf' })), false);
t('vlastní typ podle name ve frontmatteru', deny(agent({ prompt: 'x', subagent_type: 'pod-jinym-jmenem' })), false);
t('vlastní typ bez model', deny(agent({ prompt: 'x', subagent_type: 'bez-modelu' })), true);
t('vlastní typ s model: inherit', deny(agent({ prompt: 'x', subagent_type: 'dedi' })), true);
t('vlastní typ bez definice', deny(agent({ prompt: 'x', subagent_type: 'neexistuje' })), true);
t('vlastní typ s cestou v názvu', deny(agent({ prompt: 'x', subagent_type: '../x' })), true);
t('vlastní typ s model přes cwd', deny({ ...agent({ prompt: 'x', subagent_type: 'ma-model' }), cwd: join(root, 'proj') }, { CLAUDE_CONFIG_DIR: join(root, 'cfg') }), false);
t('Task bez model', deny(agent({ prompt: 'x' }, 'Task')), true);
t('Task s model', deny(agent({ prompt: 'x', model: 'opus' }, 'Task')), false);
t('model jiného typu (neznámý tvar)', deny(agent({ prompt: 'x', model: 5 })), false);
t('subagent_type jiného typu (neznámý tvar)', deny(agent({ prompt: 'x', subagent_type: 5 })), false);

// obecné: vypínač, neznámé tvary
t('vypínač off', deny(agent({ prompt: 'x' }), { ...ENV, ORCHESTRACE_GUARD: 'off' }), false);
t('vypínač OFF u Workflow', deny(wf("agent('p')"), { ORCHESTRACE_GUARD: 'OFF' }), false);
t('jiná hodnota vypínače nevypíná', deny(agent({ prompt: 'x' }), { ...ENV, ORCHESTRACE_GUARD: 'on' }), true);
t('neznámý nástroj', deny({ tool_name: 'Bash', tool_input: { command: "agent('p')" } }), false);
t('bez tool_input', deny({ tool_name: 'Agent' }), false);
t('tool_input není objekt', deny({ tool_name: 'Agent', tool_input: 'x' }), false);
t('null na vstupu', deny(null), false);

// Workflow: volání agent()
const S = 'const S = { type: "object" }\n';
t('agent bez options', lines(`agent('p')`), ['1:model+effort']);
t('agent s options bez model a effort, číslo řádku', lines(`${S}\nconst r = await agent('p', {schema: S})`), ['3:model+effort']);
t('model a effort literál', lines(`agent('p', { model: 'haiku', effort: 'low' })`), []);
t('klíče v uvozovkách', lines(`agent('p', { 'model': 'haiku', "effort": 'low' })`), []);
t('zkratka {model, effort}', lines(`const model = 'haiku', effort = 'low'\nagent('p', { model, effort })`), []);
t('chybí jen effort', lines(`agent('p', { model: 'haiku' })`), ['1:effort']);
t('chybí jen model', lines(`agent('p', { effort: 'low' })`), ['1:model']);
t('prázdný model je chyba', lines(`agent('p', { model: '', effort: 'low' })`), ['1:model']);
t('metoda se za klíč nepočítá', lines(`agent('p', { model() { return 1 }, effort: 'low' })`), ['1:model']);
t('spread konstanty', lines(`const LEVNE = { model: 'haiku', effort: 'low' }\nagent(p, {...LEVNE, schema: S})`), []);
t('spread konstanty bez effort', lines(`const LEVNE = { model: 'haiku' }\nagent(p, {...LEVNE, schema: S})`), ['2:effort']);
t('spread přes Object.freeze', lines(`const L = Object.freeze({ model: 'haiku', effort: 'low' })\nagent(p, {...L})`), []);
t('vnořený spread', lines(`const A = { model: 'haiku' }\nconst B = { ...A, effort: 'low' }\nagent(p, {...B})`), []);
t('spread nedohledatelný', lines(`agent(p, {...cfg, schema: S})`), []);
t('spread volání funkce', lines(`agent(p, {...levne(), schema: S})`), []);
t('spread dvakrát deklarované konstanty', lines(`const L = { model: 'a' }\n{ const L = { model: 'b' } }\nagent(p, {...L})`), []);
t('spread sám sebe (cyklus)', lines(`const A = { ...A }\nagent(p, {...A})`), []);
t('options identifikátor dohledatelný bez effort', lines(`const OPT = { model: 'haiku' }\nagent(p, OPT)`), ['2:effort']);
t('options identifikátor s oběma', lines(`const OPT = { model: 'haiku', effort: 'low' }\nagent(p, OPT)`), []);
t('options identifikátor nedohledatelný (parametr)', lines(`const f = (p, opts) => agent(p, opts)`), []);
t('options volání funkce', lines(`agent(p, opts())`), []);
t('options ternár', lines(`agent(p, deep ? A : B)`), []);
t('options member', lines(`agent(p, CFG.cheap)`), []);
t('vypočtený klíč je neznámý', lines(`agent(p, { [k]: 'haiku' })`), []);
t('argumenty z rozbalení', lines(`agent(...args)`), []);
t('agentType bez model, s effort', lines(`agent(p, { agentType: 'reviewer', effort: 'medium' })`), []);
t('agentType bez effort', lines(`agent(p, { agentType: 'reviewer' })`), ['1:effort']);

// agentType: stejná logika jako subagent_type u Agent (regrese: general-purpose a Explore bez model dědí model session)
t('agentType general-purpose bez model', lines(`agent(p, { agentType: "general-purpose", effort: 'low' })`), ['1:model']);
t('agentType Explore bez model', lines(`agent(p, { agentType: 'Explore', effort: 'low' })`), ['1:model']);
t('agentType general-purpose s model', lines(`agent(p, { agentType: 'general-purpose', model: 'haiku', effort: 'low' })`), []);
t('agentType fork bez model', lines(`agent(p, { agentType: 'fork', effort: 'low' })`), []);
t('agentType z pluginu bez model', lines(`agent(p, { agentType: 'plugin:reviewer', effort: 'low' })`), []);
t('agentType s klíčem v uvozovkách', lines(`agent(p, { 'agentType': 'Explore', effort: 'low' })`), ['1:model']);
t('agentType neznámá hodnota (proměnná) se povolí', lines(`agent(p, { agentType: TYPE, effort: 'low' })`), []);
t('agentType zkratka se povolí', lines(`agent(p, { agentType, effort: 'low' })`), []);
t('agentType výraz se povolí', lines(`agent(p, { agentType: 'a' + b, effort: 'low' })`), []);
t('agentType z dohledaného spreadu', lines(`const C = { agentType: 'Explore', effort: 'low' }\nagent(p, { ...C, schema: S })`), ['2:model']);
t('agentType prázdný řetězec', lines(`agent(p, { agentType: '', effort: 'low' })`), ['1:model']);
t('agentType s komentářem za hodnotou', lines(`agent(p, { agentType: 'Explore', // levné\n effort: 'low' })`), ['1:model']);
const wfType = (type, extra = '') => wf(`await agent(p, { agentType: '${type}', effort: 'low'${extra} })`);
t('Workflow agentType general-purpose bez model zamítne', deny(wfType('general-purpose')), true);
t('Workflow agentType vlastní typ s model v definici', deny(wfType('ma-model')), false);
t('Workflow agentType vlastní typ bez model v definici', deny(wfType('bez-modelu')), true);
t('Workflow agentType vlastní typ s model: inherit', deny(wfType('dedi')), true);
t('Workflow agentType bez definice', deny(wfType('neexistuje')), true);
t('Workflow agentType s cestou v názvu', deny(wfType('../ma-model')), true);
t('Workflow agentType general-purpose s model', deny(wfType('general-purpose', ", model: 'haiku'")), false);
t('Workflow agentType zpráva zmiňuje vestavěné typy', (decide(wfType('Explore'), ENV) ?? '').includes('general-purpose, Explore'), true);
const stdinType = run(JSON.stringify({ tool_name: 'Workflow', tool_input: { script: 'await agent(p, { agentType: "general-purpose", effort: "low" })\n' } }));
t('stdin: Workflow agentType general-purpose zamítne', [stdinType.status, stdinType.stdout.includes('"permissionDecision":"deny"'), stdinType.stdout.includes('řádek 1 (chybí model)')], [0, true, true]);
t('koncová čárka', lines(`agent(p, { model: 'haiku', effort: 'low', },)`), []);
t('agent bez options s koncovou čárkou', lines(`agent(p,)`), ['1:model+effort']);
t('víc volání, jedno vadné', lines(`agent('a', { model: 'haiku', effort: 'low' })\nagent('b', { model: 'haiku' })\nagent('c', { model: 'haiku', effort: 'low' })`), ['2:effort']);
t('více vadných', lines(`agent('a')\n\nagent('b', {})`), ['1:model+effort', '3:model+effort']);

// Workflow: parametr funkce stejného jména jako const jinde je neznámý, ne ta const
t('options je parametr obalovací funkce', lines('const opts = { schema: S }\nconst first = await agent("a", { ...opts, model: "haiku", effort: "low" })\nasync function ask(p, opts) {\n  return agent(p, opts)\n}'), []);
t('spread parametru šipky', lines('const base = { schema: S }\nconst ask = (p, base) => agent(p, { ...base })'), []);
t('spread parametru funkce, const až za ní', lines("function mk(base) { return (p) => agent(p, { ...base, schema: S }) }\nconst base = { model: 'haiku' }"), []);
t('parametr s jedním jménem v šipce bez závorek', lines('const o = { schema: S }\nconst f = o => agent(p, o)'), []);
t('destrukturovaný parametr', lines('const o = { schema: S }\nconst f = ({ o }) => agent(p, o)'), []);
t('parametr metody objektu', lines('const o = { schema: S }\nconst w = { run(p, o) { return agent(p, o) } }'), []);
t('parametr catch', lines('const e = { schema: S }\ntry { x() } catch (e) { agent(p, e) }'), []);
t('destrukturující deklarace', lines('const o = { schema: S }\nfunction f(c) { const { o } = c; return agent(p, o) }'), []);
t('jiná deklarace téhož jména v bloku', lines('const o = { schema: S }\n{ const o = pick(); agent(p, o) }'), []);
t('jména ve volání a v podmínce nejsou parametr', lines('const o = { schema: S }\nif (o.x) { agent(p, o) }\nfoo(o.x)'), ['2:model+effort']);
t('const bez parametru se pořád hlídá', lines('const o = { schema: S }\nconst f = (p) => agent(p, o)'), ['2:model+effort']);

// Workflow: objekt options doplněný po deklaraci je neznámý
t('let doplněné přiřazením klíčů', lines('let opts = {}\nopts.model = "haiku"\nopts.effort = "low"\nawait agent("p", opts)'), []);
t('const doplněné přiřazením klíčů', lines("const o = { schema: S }\no.model = 'haiku'; o.effort = 'low'\nawait agent('p', o)"), []);
t('přiřazení přes závorky a ??=', lines("const o = { schema: S }\no['model'] ??= 'haiku'\nawait agent('p', o)"), []);
t('Object.assign do options', lines("const opts = { schema: S }\nObject.assign(opts, { model: 'haiku', effort: 'low' })\nconst r = await agent('p', opts)"), []);
t('přepsání let', lines("let o = { schema: S }\no = { model: 'haiku', effort: 'low' }\nawait agent('p', o)"), []);
t('delete klíče z options', lines("const o = { model: 'haiku', effort: 'low' }\ndelete o.model\nawait agent('p', o)"), []);
t('spread změněné konstanty', lines("const B = { schema: S }\nB.model = 'haiku'\nagent(p, { ...B })"), []);
t('porovnání a čtení klíče není změna', lines("const o = { schema: S }\nif (o.model == 'x' && o.effort >= 1 && o.n === 2) {}\nawait agent('p', o)"), ['3:model+effort']);
t('arrow za klíčem není přiřazení', lines("const o = { schema: S }\nconst f = o.h => 1\nawait agent('p', o)"), ['3:model+effort']);

// Workflow: lokální jméno agent a identifikátory s českými znaky
t('řagent( není agent(', lines("const řagent = (x) => x\nřagent('p')"), []);
t('přeložagent( není agent(', lines("const přeložagent = 1; přeložagent('x')"), []);
t('agentř( není agent(', lines("agentř('p')"), []);
t('agent( za českým slovem a mezerou se počítá', lines("const čau = 1; agent('p')"), ['1:model+effort']);
t('agent jako parametr callbacku', lines("steps.forEach((agent) => agent('p'))"), []);
t('agent jako destrukturovaný parametr', lines("const run = async ({ agent }) => agent('p')"), []);
t('agent jako parametr bez závorek', lines("steps.map(agent => agent('p'))"), []);
t('agent jako const', lines("const agent = makeAgent()\nagent('p')"), []);
t('agentName není agent', lines("const f = async (agentName) => agentName\nagent('p')"), ['2:model+effort']);

// vestavěné typy agentů: zamítnutí odkáže na referenci s jejich modely, bez seznamu jmen
const reasonGuide = decide(agent({ prompt: 'x', subagent_type: 'claude-code-guide' }), ENV) ?? '';
t('zamítnutí vestavěného typu odkazuje na REFERENCE.md', [reasonGuide.includes('REFERENCE.md'), reasonGuide.includes('zadej model, na kterém má běžet')], [true, true]);
t('zamítnutí bez typu nemá poznámku o vestavěných', (decide(agent({ prompt: 'x' }), ENV) ?? '').includes('REFERENCE.md'), false);
t('claude-code-guide s model projde', deny(agent({ prompt: 'x', subagent_type: 'claude-code-guide', model: 'haiku' })), false);

// Workflow: co se nemá počítat jako volání
t('agent( v řetězci', lines(`const s = "agent('p')"; const t = 'agent(x)'`), []);
t('agent( v šabloně', lines('const s = `volej agent(\'p\') takto`'), []);
t('agent( v komentáři //', lines(`// agent('p')\nconst x = 1`), []);
t('agent( v komentáři /* */', lines(`/* agent('p')\n agent('q') */\nconst x = 1`), []);
t('.agent(', lines(`ctx.agent('p')\nx\n  .agent('q')\nx?.agent('r')`), []);
t('myagent( a agent2(', lines(`myagent('p'); agent2('p'); $agent('p'); agent_('p')`), []);
t('definice funkce agent', lines(`function agent(p) { return p }\nconst o = { agent(p) { return p } }`), []);
t('agent v regex literálu', lines(`const re = /agent\\(x\\)/g; const y = 1 / 2`), []);
t('agent( ve ${} šablony se počítá', lines('const s = `a ${await agent(\'p\')} b`'), ['1:model+effort']);
t('závorky a čárky v řetězci promptu', lines(`agent('text (bez zavřené, "a" , {', { model: 'haiku', effort: 'low' })`), []);
t('slovo model v promptu není klíč', lines(`agent('uprav model a effort v souboru', { schema: S })`), ['1:model+effort']);
t('slovo model v komentáři a řetězci options', lines(`agent(p, { /* model: 'x' */ schema: 'model effort' })`), ['1:model+effort']);
t('model ve vnořeném objektu není klíč nejvyšší úrovně', lines(`agent(p, { schema: { model: 1, effort: 2 } })`), ['1:model+effort']);
t('nevyvážené závorky', lines(`agent('p', { model: 'haiku'`), []);

// Workflow: šablonový literál s vnořením
const tpl = [
  'const prompt = `Shrň (část ${x ? \'a\' : `b${c}`}) a { zavři `;',
  "const r = await agent(prompt, { model: 'sonnet', effort: 'medium' })",
  'const q = await agent(`Znovu ${files.map((f) => `- ${f}`).join("\\n")} (konec`, { schema: S })',
].join('\n');
t('vnořená šablona, závorky v textu, vadné až třetí volání', lines(tpl), ['3:model+effort']);
t('čárka v šabloně prvního argumentu', lines('agent(`a, b ${f(1, 2)}, c`, { model: "haiku", effort: "low" })'), []);
t('komentář uvnitř options', lines(`agent(p, {\n // effort chybí\n model: 'haiku', // levný\n /* effort: 'low' */\n})`), ['1:effort']);

// Workflow: vstup nástroje
const wfFile = join(root, 'wf.js');
writeFileSync(wfFile, `agent('p', { schema: S })\n`);
const okFile = join(root, 'ok.js');
writeFileSync(okFile, `agent('p', { model: 'haiku', effort: 'low' })\n`);
t('script vadný', deny(wf(`agent('p')`)), true);
t('script v pořádku', deny(wf(`agent('p', { model: 'haiku', effort: 'low' })`)), false);
t('scriptPath vadný soubor', deny({ tool_name: 'Workflow', tool_input: { scriptPath: wfFile } }), true);
t('scriptPath v pořádku', deny({ tool_name: 'Workflow', tool_input: { scriptPath: okFile } }), false);
t('scriptPath relativně k cwd', deny({ tool_name: 'Workflow', cwd: root, tool_input: { scriptPath: 'wf.js' } }), true);
t('scriptPath nečitelný', deny({ tool_name: 'Workflow', tool_input: { scriptPath: join(root, 'neni.js') } }), false);
t('jen name', deny({ tool_name: 'Workflow', tool_input: { name: 'ulozeny' } }), false);
t('script má přednost před scriptPath', deny({ tool_name: 'Workflow', tool_input: { script: `agent('p', { model: 'haiku', effort: 'low' })`, scriptPath: wfFile } }), false);
t('script není řetězec', deny({ tool_name: 'Workflow', tool_input: { script: 5 } }), false);
const reason = decide(wf(`const x = 1\nagent('p', { schema: S })`), ENV) ?? '';
t('text zamítnutí uvádí řádek, příklad, skill a nemá em dash', [reason.includes('řádek 2'), reason.includes('LEVNE'), reason.includes('skill orchestrace'), reason.includes('model: \'opus\''), !reason.includes('\u2014')], [true, true, true, true, true]);
const reasonAgent = decide(agent({ prompt: 'x' }), ENV) ?? '';
t('text zamítnutí Agent: příklad, skill, bez em dash', [reasonAgent.includes("model: 'sonnet'"), reasonAgent.includes('skill orchestrace'), !reasonAgent.includes('\u2014')], [true, true, true]);

// reálná struktura workflow (pipeline, parallel, map, schema konstanty), všude model a effort
const real = `
const LEVNE = { model: 'haiku', effort: 'medium' }
const SILNE = { model: 'opus', effort: 'high' }
const EXTRACT = { type: 'object', properties: { files: { type: 'array', items: { type: 'string' } } }, required: ['files'] }
const VERDICT = { type: 'object', properties: { ok: { type: 'boolean' }, note: { type: 'string' } } }

// Fáze 1: seznam souborů
const listing = await agent('Vypiš soubory v C:/x a vrať je podle schématu (zadání obsahuje "agent(" jen jako text).', { ...LEVNE, schema: EXTRACT })

const parts = await pipeline(
  parallel(listing.files.map((f) => () => agent(\`Přečti \${f}\\n(část \${f.length > 3 ? 'dlouhá' : \`krátká \${f}\`})\`, { ...LEVNE, schema: EXTRACT }))),
  async (results) => {
    const merged = results.flatMap((r) => r.files)
    return agent('Syntéza:\\n' + merged.join('\\n'), { model: 'sonnet', effort: 'high' })
  },
)

const checks = await Promise.all(
  [1, 2, 3].map(async (i) => {
    const v = await agent('Ověř ' + i, { ...SILNE, schema: VERDICT })
    return v.ok ? null : v.note
  }),
)
const review = await agent('Revize', { agentType: 'reviewer', effort: 'medium', schema: VERDICT })
const ratio = checks.length / 2 / 3
return { parts, checks, review, ratio }
`;
t('reálný skript se všemi model a effort', lines(real), []);
t('reálný skript s jedním vadným', lines(real.replace("{ ...SILNE, schema: VERDICT }", '{ schema: VERDICT }')), [`${real.split('\n').findIndex((l) => l.includes("'Ověř '")) + 1}:model+effort`]);

// regex literál s uvozovkou nebo backtickem za ) a ++ (regrese: maska se rozhodila a text promptu se bral jako kód)
const okCall = `await agent(p, { model: "haiku", effort: "low" })`;
t('regex s backtickem po if (...)', lines(`if (ok) /\`/.test(s)\nconst p = \`Use agent(x) here\`\n${okCall}\n`), []);
t('regex s uvozovkou po while (...)', lines(`while (x) /"/.test(s)\nconst p = "Use agent(x) here"\n${okCall}\n`), []);
t('regex s apostrofem po for (...)', lines(`for (const a of b) /'/.test(a)\nconst p = 'Use agent(x) here'\n${okCall}\n`), []);
t('dělení po i++ a uvozovka', lines(`let r = i++ / 2, q = "/"; const p = "agent(x)"\n${okCall}\n`), []);
t('dělení po i-- a uvozovka', lines(`let r = i-- / 2, q = "/"; const p = "agent(x)"\n${okCall}\n`), []);
t('dělení po ) zůstává dělením', lines(`const r = (a + b) / 2, q = "/"; const p = "agent(x)"\n${okCall}\n`), []);
t('volání po regexu za if se stále hlídá', lines(`if (ok) /\`/.test(s)\nconst p = \`Use agent(x) here\`\nawait agent(p)\n`), ['3:model+effort']);
t('dělení po zavřené závorce funkce', lines(`const h = f(x) / 2 / 3; const p = "agent(y)"\n${okCall}\n`), []);
const stdinRe = run(JSON.stringify({ tool_name: 'Workflow', tool_input: { script: `if (ok) /\`/.test(s)\nconst p = \`Use agent(x) here\`\n${okCall}\n` } }));
t('stdin: regex po if nezpůsobí falešné zamítnutí', [stdinRe.status, stdinRe.stdout], [0, '']);

// options objekt předaný dál nebo s getterem (regrese: falešné zamítnutí)
t('options předaný cizí funkci se povolí', lines(`const L = { schema: S }\nfill(L)\nawait agent(p, L)\n`), []);
t('options přiřazený jinam se povolí', lines(`const L = { schema: S }\nconst M = L\nawait agent(p, M)\nawait agent(p, L)\n`), []);
t('options v poli se povolí', lines(`const L = { schema: S }\nregister([L])\nawait agent(p, L)\n`), []);
t('options bez předání dál se stále hlídá', lines(`const L = { schema: S }\nawait agent(p, L)\n`), ['2:model+effort']);
t('options použitý ve dvou agent() a čtený přes tečku se stále hlídá', lines(`const L = { schema: S }\nconst s = L.schema\nawait agent(a, L)\nawait agent(b, L)\n`), ['3:model+effort', '4:model+effort']);
t('options předaný jen v nested agent() se stále hlídá', lines(`const L = { schema: S }\nawait Promise.all(xs.map((x) => agent(x, L)))\n`), ['2:model+effort']);
t('spread options se stále hlídá', lines(`const L = { schema: S }\nawait agent(p, { ...L, effort: 'low' })\n`), ['2:model']);
t('getter model se bere jako hodnota', lines(`agent(p, { get model() { return 'haiku' }, effort: 'low' })`), []);
t('getter effort se bere jako hodnota', lines(`agent(p, { model: 'haiku', get effort() { return 'low' } })`), []);
t('metoda model bez getteru zůstává metodou', lines(`agent(p, { model() { return 'haiku' }, effort: 'low' })`), ['1:model']);
const stdinFill = run(JSON.stringify({ tool_name: 'Workflow', tool_input: { script: 'const L = { schema: S }\nfill(L)\nawait agent(p, L)\n' } }));
t('stdin: options předaný funkci projde', [stdinFill.status, stdinFill.stdout], [0, '']);

// zapojení: hooks.json vedle testu (nečte se nic z uživatelského nastavení)
let pluginHooks = null;
try { pluginHooks = JSON.parse(readFileSync(HOOKS_JSON, 'utf8')); } catch { /* níže selže */ }
const entries = pluginHooks?.hooks?.PreToolUse ?? [];
const entry = entries.find((h) => h.matcher === 'Workflow|Agent|Task');
const handler = entry?.hooks?.find((x) => (x.args ?? []).some((a) => a.endsWith('/hooks/orchestrace-guard.mjs')));
t('hooks.json: PreToolUse s matcherem Workflow|Agent|Task', [entries.length, Boolean(entry)], [1, true]);
t('hooks.json: příkaz je node s cestou přes ${CLAUDE_PLUGIN_ROOT} (exec form)', [handler?.type, handler?.command, handler?.args], ['command', 'node', ['${CLAUDE_PLUGIN_ROOT}/hooks/orchestrace-guard.mjs']]);
t('hooks.json: bez pole shell', handler !== undefined && !('shell' in handler), true);
// matcher z jen písmen a svislítek je podle dokumentace seznam přesných názvů nástrojů
const names = (entry?.matcher ?? '').split('|');
t('hooks.json: matcher je seznam přesných názvů Workflow, Agent, Task', [/^[A-Za-z|]+$/.test(entry?.matcher ?? ''), [...names].sort()], [true, ['Agent', 'Task', 'Workflow']]);
// cesta po dosazení kořene pluginu (složka nad hooks/) míří na hook, který test zkouší
const pluginRoot = resolve(dirname(HOOKS_JSON), '..');
const wiredFile = resolve((handler?.args?.[0] ?? '').replace('${CLAUDE_PLUGIN_ROOT}', pluginRoot));
let sameFile = false;
try { sameFile = realpathSync.native(wiredFile) === realpathSync.native(HOOK); } catch { /* níže selže */ }
t('hooks.json: cesta po dosazení kořene pluginu míří na hook', sameFile, true);
// příkaz z hooks.json spuštěný tak, jak ho spustí Claude Code: bez shellu, command a args
if (handler) {
  const viaJson = spawnSync(handler.command, [wiredFile], { input: JSON.stringify({ tool_name: 'Agent', tool_input: { prompt: 'x' } }), encoding: 'utf8', env: { ...process.env, ORCHESTRACE_GUARD: '', ...ENV } });
  t('hooks.json: příkaz zamítne Agent bez model', [viaJson.status, viaJson.stdout.includes('"permissionDecision":"deny"')], [0, true]);
}

// celý hook přes stdin (JSON PreToolUse)
function run(input, env = {}) {
  return spawnSync('node', [HOOK], { input, encoding: 'utf8', env: { ...process.env, ORCHESTRACE_GUARD: '', ...ENV, ...env } });
}
const e2eDeny = run(JSON.stringify({ tool_name: 'Agent', tool_input: { prompt: 'x' } }));
let parsed = null;
try { parsed = JSON.parse(e2eDeny.stdout); } catch { /* níže selže */ }
t('stdin: Agent bez model zamítne', [e2eDeny.status, parsed?.hookSpecificOutput?.hookEventName, parsed?.hookSpecificOutput?.permissionDecision, typeof parsed?.hookSpecificOutput?.permissionDecisionReason], [0, 'PreToolUse', 'deny', 'string']);
const e2eWf = run(JSON.stringify({ tool_name: 'Workflow', tool_input: { script: "agent('p', { schema: S })" } }));
t('stdin: Workflow zamítne', [e2eWf.status, e2eWf.stdout.includes('"permissionDecision":"deny"'), e2eWf.stdout.includes('řádek 1')], [0, true, true]);
const e2ePass = run(JSON.stringify({ tool_name: 'Agent', tool_input: { prompt: 'x', model: 'sonnet' } }));
t('stdin: Agent s model projde', [e2ePass.status, e2ePass.stdout], [0, '']);
const e2eOff = run(JSON.stringify({ tool_name: 'Agent', tool_input: { prompt: 'x' } }), { ORCHESTRACE_GUARD: 'off' });
t('stdin: vypínač off', [e2eOff.status, e2eOff.stdout], [0, '']);
const e2eBom = run('\ufeff' + JSON.stringify({ tool_name: 'Agent', tool_input: { prompt: 'x' } }));
t('stdin: vstup s BOM (PowerShell rourou) zamítne', [e2eBom.status, e2eBom.stdout.includes('"permissionDecision":"deny"')], [0, true]);
const e2eJunk = run('není json');
t('stdin: neplatný JSON projde', [e2eJunk.status, e2eJunk.stdout], [0, '']);
const e2eEmpty = run('');
t('stdin: prázdný vstup projde', [e2eEmpty.status, e2eEmpty.stdout], [0, '']);

rmSync(root, { recursive: true, force: true });
if (fails) { console.log(`${fails} selhání`); process.exit(1); }
console.log('vše ok');
