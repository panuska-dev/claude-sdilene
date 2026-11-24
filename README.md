# claude-sdilene

Marketplace pluginů pro Claude Code, které sdílím s českými kolegy a s lidmi, které školím.

## Instalace

Zkopíruj Claudovi tuto větu:

> Ověř `node --version`, přidej marketplace `LiberaFatum/claude-sdilene`, nainstaluj plugin `orchestrace@claude-sdilene` a řekni mi, co mám udělat dál.

Claude spustí tyto dva příkazy:

```bash
claude plugin marketplace add LiberaFatum/claude-sdilene
claude plugin install orchestrace@claude-sdilene
```

Plugin se načte při příštím startu Claude Code, nebo hned v otevřené session po příkazu `/reload-plugins`. Instalace z příkazové řádky ve výchozím nastavení ukládá plugin pro tvého uživatele (user scope), takže platí ve všech projektech. Hook v pluginu potřebuje Node.js v `PATH` (ověříš `node --version`). Bez něj se hook nespustí, Claude Code volání pustí a kontrola neběží. Ověřeno na Claude Code 2.1.318 a Node.js 24, starší verze ověřené nejsou.

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

První příkaz obnoví seznam pluginů v marketplace, druhý aktualizuje nainstalovaný plugin. Příkaz `claude plugin marketplace update` bez názvu obnoví jen seznamy, nainstalované pluginy nechá na současné verzi.

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

Při nejasnosti nebo chybě vstupu hook nic nezamítne a volání projde. Vypnout ho lze proměnnou prostředí `ORCHESTRACE_GUARD=off`.

## Licence

MIT, viz [LICENSE](LICENSE).
