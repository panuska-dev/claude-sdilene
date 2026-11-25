# orchestrace

Plugin pro Claude Code. Při workflows a ultracode má hlavní session řídit práci a subagenti ji vykonávat: velké podklady čtou a dokumenty i kód píšou subagenti, hlavní session čte jejich výtahy s důkazem.

## Instalace

```bash
claude plugin marketplace add LiberaFatum/claude-sdilene
claude plugin install orchestrace@claude-sdilene
```

## Co obsahuje

- Skill `orchestrace` (`SKILL.md`, podrobnosti a zdroje v `REFERENCE.md`): role hlavní session, rozklad práce, zadání agentům, volba modelu a effortu, ověření výsledků.
- Hook PreToolUse `orchestrace-guard.mjs` na nástroje Agent, Task a Workflow. Test hooku (z kořene pluginu): `node hooks/orchestrace-guard.test.mjs`.

## Co hook zamítne

- Volání Agent nebo Task bez výslovného `model`. Výjimky: agent typu `fork`, agent z pluginu (typ s dvojtečkou) a vlastní typ, jehož definice má model ve frontmatteru.
- Workflow, jehož skript volá `agent(` bez `model` nebo `effort` v druhém argumentu. Stejné výjimky platí pro `agentType`, tedy typ agenta, který se ve volání zadá jako `agentType`: když definice agenta (soubor v `.claude/agents` projektu nebo v `~/.claude/agents`) obsahuje model, stačí `effort`.

Hodnota modelu se nekontroluje proti seznamu. Když hook vstupu nerozumí, nic nezamítne.

## Meze kontroly

Kontrola je statická, skript workflow se nespouští.

- Vnořený workflow se kontroluje jen přes `workflow({ scriptPath: 'soubor.js' })` s řetězcovým literálem, jedním zanořením (soubor se čte relativně k cwd). Volání podle jména a cesta z proměnné se nekontrolují.
- Hook nevidí `eval`, `new Function`, `globalThis['agent']`, vypočtená jména ani skript sestavený za běhu z textu.
- `agent` použitý jako hodnota (alias, callback, `pipeline(items, agent)`, `Reflect.apply`, `.call`) a \u escape v identifikátoru se hlásí jako neověřitelné a volání se zamítne; ověřit jde jen přímé volání `agent(prompt, { model, effort })`.
- Definice agentů z managed settings a z přepínače `--agents` hook nevidí; vlastní typ, který je jen tam, bere jako typ bez modelu. Hledá se v `.claude/agents` od aktuální složky nahoru, v `CLAUDE_PROJECT_DIR` a v podsložce `agents` konfigurační složky (`CLAUDE_CONFIG_DIR`, jinak výchozí konfigurační složka Claude Code).
- Při `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` nastaveném na `1`, `true`, `yes` nebo `on` Claude model předat nemůže, proto hook model nežádá: Agent a Task bez `model` projdou a ve workflow se hlídá jen `effort`. `ORCHESTRACE_GUARD=off` kvůli tomu není potřeba.

## Vypnutí

Proměnná prostředí `ORCHESTRACE_GUARD=off` (velikost písmen nehraje roli) vypne jen kontrolu hooku. Nastav ji při spuštění Claude Code:

```bash
# bash, zsh
ORCHESTRACE_GUARD=off claude
```

```powershell
# PowerShell
$env:ORCHESTRACE_GUARD = 'off'; claude
```

Na chvíli je pohodlnější vypnout celý plugin a zpět ho zapnout:

```bash
claude plugin disable orchestrace@claude-sdilene
claude plugin enable orchestrace@claude-sdilene
```

## Požadavky

- Node.js dostupný v `PATH` (ověříš `node --version`). Node.js stáhneš z https://nodejs.org. Po instalaci otevři nový terminál a restartuj Claude Code, aby našel `node` v `PATH`.
- Bez Node.js plugin funguje jen jako skill; Claude Code při každém volání agenta nebo workflow ukáže varování o chybě hooku, volání pustí a kontrola neběží.
- Ověřeno v CI na Windows, macOS a Linuxu s Node.js 18, 20, 22 a 24 a s Claude Code 2.1.318. Node.js starší než 18 podporovaný není. Hook používá jen standardní moduly `node:`.

## Licence

MIT.
