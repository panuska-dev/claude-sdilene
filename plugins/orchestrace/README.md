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
- Workflow, jehož skript volá `agent(` bez `model` nebo `effort` v druhém argumentu. Stejné výjimky platí pro `agentType`: s modelem v definici agenta stačí `effort`.

Hodnota modelu se nekontroluje proti seznamu. Když hook vstupu nerozumí, nic nezamítne.

## Vypnutí

Proměnná prostředí `ORCHESTRACE_GUARD=off`. Plugin celý vypneš příkazem `claude plugin disable orchestrace@claude-sdilene`.

## Předpoklad

Node.js dostupný v `PATH` (ověříš `node --version`). Bez něj se hook nespustí, Claude Code volání pustí a kontrola neběží. Ověřeno na Claude Code 2.1.318 a Node.js 24; hook používá jen standardní moduly `node:`, minimální verze ale ověřená není.

## Licence

MIT.
