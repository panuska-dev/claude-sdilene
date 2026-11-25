# claude-sdilene

Marketplace pluginů pro Claude Code, které sdílím s českými kolegy a s lidmi, které školím.

## Instalace

Zkopíruj Claudovi tuto větu:

> V shellu spusť `node --version`, potom `claude plugin marketplace add LiberaFatum/claude-sdilene` a `claude plugin install orchestrace@claude-sdilene`. Nakonec spusť `claude plugin list` a ověř, že `orchestrace@claude-sdilene` má Status enabled. Když `node` chybí, plugin přesto nainstaluj, ale napiš mi, že kontrola hooku bez Node.js neběží a kde Node.js stáhnout (https://nodejs.org). Až budeš hotový, napiš mi, že mám spustit `/reload-plugins` nebo restartovat Claude Code.

Claude Code se může zeptat na povolení spuštění příkazů, potvrď je.

Nebo je spusť sám:

```bash
claude plugin marketplace add LiberaFatum/claude-sdilene
claude plugin install orchestrace@claude-sdilene
```

- **Načtení:** plugin se načte při příštím startu Claude Code, nebo hned v otevřené session po příkazu `/reload-plugins`.
- **Rozsah:** instalace z příkazové řádky nainstaluje plugin pro tebe do všech projektů (user scope).
- **Požadavky:** hook v pluginu potřebuje Node.js v `PATH` (ověříš `node --version`). Node.js stáhneš z https://nodejs.org. Po instalaci otevři nový terminál a restartuj Claude Code, aby našel `node` v `PATH`. Bez Node.js plugin funguje jen jako skill; Claude Code při každém volání agenta nebo workflow ukáže varování o chybě hooku a kontrola neběží.
- **Aktuální Claude Code:** aliasy modelů (`fable`, `opus`, `sonnet`, `haiku`) se posouvají s verzí Claude Code, proto ho udržuj aktuální příkazem `claude update`.
- **Ověřené verze:** testy v CI běží na Windows, macOS a Linuxu s Node.js 18, 20, 22 a 24 a s Claude Code 2.1.318, jednou týdně i proti nejnovějšímu Claude Code. Node.js starší než 18 podporovaný není.

## Pluginy

| Plugin | Co dělá | Co instaluje |
| :- | :- | :- |
| [orchestrace](plugins/orchestrace/README.md) | Hlavní session při workflows a ultracode deleguje, subagenti čtou podklady a píšou výstupy. Každý agent má mít výslovně zvolený model. | Skill `orchestrace` a hook PreToolUse na nástroje Agent, Task a Workflow, který zamítne agenta bez výslovného modelu. |

## Aktualizace

Marketplaces třetích stran mají automatickou aktualizaci ve výchozím stavu vypnutou. Zapneš ji v session: `/plugin`, záložka **Marketplaces**, vybrat `claude-sdilene` a zapnout auto-update. Po aktualizaci Claude Code napíše `Run /reload-plugins to apply`, nové verze se každopádně načtou při příštím startu.

Ruční aktualizace jednoho pluginu:

```bash
claude plugin marketplace update claude-sdilene
claude plugin update orchestrace@claude-sdilene
```

První příkaz obnoví seznam pluginů v marketplace, druhý aktualizuje nainstalovaný plugin. Příkaz `claude plugin marketplace update` bez názvu obnoví jen seznamy, nainstalované pluginy nechá na současné verzi. Změna se načte po restartu Claude Code nebo po `/reload-plugins`.

Nová verze se k tobě dostane jen tehdy, když se u pluginu změní číslo verze. Zkontroluj ho příkazem `claude plugin list`; když `update` napíše `already at the latest version`, máš aktuální verzi.

## Odinstalace

```bash
claude plugin uninstall orchestrace@claude-sdilene
claude plugin marketplace remove claude-sdilene
```

Odebrání marketplace odinstaluje také všechny pluginy, které jsi z něj nainstaloval.

## Co plugin spouští na tvém počítači

Plugin `orchestrace` registruje hook, tedy skript v Node.js, který Claude Code spustí před každým voláním nástroje Agent, Task nebo Workflow. Skript čte vstup tohoto volání, u workflow případně soubor se skriptem, na který volání ukazuje, a u vlastních typů agentů jejich definice v `.claude/agents` projektu a v `~/.claude/agents`. Nic nezapisuje a nepoužívá síť.

Zamítne volání, když:

- agent (Agent, Task) nemá výslovně zadaný `model`,
- ve workflow skriptu některé volání `agent(` nemá `model` nebo `effort` (u `agentType` s modelem v definici agenta stačí `effort`).

Výjimky (agent typu `fork`, agent z pluginu, vlastní typ s modelem v definici) a přesná pravidla jsou v [README pluginu](plugins/orchestrace/README.md).

Meze kontroly (statická analýza, skript se nespouští):

- Vnořený workflow se kontroluje jen přes volání `workflow({ scriptPath: 'soubor.js' })` s řetězcovým literálem, a to jedním zanořením. Volání podle jména a cesta z proměnné se nekontrolují.
- Hook nevidí `eval`, `new Function`, `globalThis['agent']`, vypočtená jména ani skript sestavený za běhu z textu. Když se `agent` použije jako hodnota (alias, callback, `pipeline(items, agent)`) nebo se v identifikátoru objeví \u escape, hook volání zamítne s hláškou, že kontrola nejde ověřit.
- Definice agentů z managed settings a z přepínače `--agents` hook nevidí; takový vlastní typ bere jako typ bez modelu.
- Při `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` (`1`, `true`, `yes` nebo `on`) Claude model předat nemůže, proto hook model nežádá: Agent bez `model` projde a ve workflow se hlídá jen `effort`.

Při nejasnosti nebo chybě vstupu hook nic nezamítne a volání projde.

## Vypnutí hooku

Proměnná prostředí `ORCHESTRACE_GUARD=off` (velikost písmen nehraje roli) vypne jen kontrolu hooku. Nastav ji při spuštění Claude Code:

```bash
# bash, zsh
ORCHESTRACE_GUARD=off claude
```

```powershell
# PowerShell
$env:ORCHESTRACE_GUARD = 'off'; claude
```

Na chvíli je pohodlnější vypnout celý plugin a potom ho zase zapnout:

```bash
claude plugin disable orchestrace@claude-sdilene
claude plugin enable orchestrace@claude-sdilene
```

## Vydání nové verze (pro autora)

Číslo verze je v `plugins/orchestrace/.claude-plugin/plugin.json`. Při každé změně pluginu ho zvyš, jinak se změna k uživatelům nedostane. Před vydáním spusť:

```bash
claude plugin validate . --strict
claude plugin tag plugins/orchestrace --dry-run
```

## Přispívání

Testy nepotřebují žádné závislosti, jen Node.js 18 nebo novější. Příkazy se spouštějí z kořene repa:

```bash
npm test             # všechny testy včetně instalace v čistém profilu (potřebuje claude v PATH)
npm run test:rychle  # bez instalace a bez claude
```

- **Co testy hlídají:** obsah souborů (bez em dash, BOM, CRLF a osobních údajů), manifesty, shodu dokumentace s hookem, chování hooku, instalaci pluginu do čistého profilu, to, že Claude Code nainstalovaný hook opravdu spustí (skutečný `claude -p` proti falešnému API na loopbacku, bez přihlášení a bez sítě), a zvýšení verze. V CI se nesmí přeskočit žádný test mimo výslovné výjimky v `tests/spust.mjs`. Hláška při selhání česky říká, co a kde opravit.
- **Zakázané řetězce:** obecné vzory jsou v `tests/zakazane.txt`. Vlastní osobní údaje (jméno, e-mail, zaměstnavatele) si doplň do `tests/zakazane.local.txt` ve stejném formátu. Soubor je v `.gitignore` a test ho načte, když existuje.
- **Pre-commit hook:** v klonu ho zapneš jednou příkazem `git config core.hooksPath .githooks`. Před každým commitem pak běží `npm run test:rychle`. Na Linuxu a macOS musí mít `.githooks/pre-commit` příznak spustitelnosti (`chmod +x`). Na Windows (`core.filemode` je `false`) ho po prvním `git add .githooks/pre-commit` nastav do indexu příkazem `git update-index --chmod=+x .githooks/pre-commit`; test v `tests/infrastruktura.test.mjs` to v indexu hlídá.
- **Verze:** když změníš cokoli v `plugins/<plugin>/` mimo testy (`*.test.mjs`), zvyš `version` v `plugins/<plugin>/.claude-plugin/plugin.json`. Test `tests/verze.test.mjs` porovnává s `origin/main` a s posledním tagem pluginu (`<plugin>--v<verze>`, vytvoří ho `claude plugin tag`).
- **CI:** `.github/workflows/test.yml` spouští `npm test` na Ubuntu, macOS a Windows (ve Windows v PowerShellu, bez Git Bash) s Node.js 18, 20, 22 a 24. Verze Claude Code je ve workflow pevně daná a README ji musí uvádět stejnou.

## Licence

MIT, viz [LICENSE](LICENSE).
