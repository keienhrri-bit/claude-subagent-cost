# 发布与收录清单（v0.1.0）

只列不需要登录别的网站就能做的事：本仓库自己的门面，以及在 GitHub 上收稿或自动抓取的列表。这里只是草稿，没有提交任何东西。所有规则都在 2026-11-16 用 `gh api` 读过原文；提交前请按链接再看一遍。

## 1. 仓库门面

**简介**（`gh repo edit --description`）：

> Claude Code mod: each subagent's model and tokens under its Agent row, 5h/7d quota above the prompt, compaction after a finished task, and a handoff brief before the quota runs out.

**Topics**（`gh repo edit --add-topic`）：

`claude-code`, `claude-code-mod`, `claude-code-plugin`, `claude-code-mods`, `function-hooks`, `subagents`, `token-usage`, `rate-limit`, `usage-limits`, `context-compaction`, `handoff`

其中 `claude-code-mod`、`claude-code-mods`、`claude-code-plugin`、`function-hooks` 是下面 karanb192 目录每 3 小时扫描时认的 topic。

**README 开头**：第一句说用途，接着是示意图（标明是示意图、数字虚构，不是截图），然后是安装命令。已写好。

**Release 说明**（`gh release create v0.1.0 --notes-file`）：

```markdown
First release of subagent-cost, a Claude Code mod.

- A line under each Agent tool row: subagent type, the model it ran on, input / output / cache write (5m or 1h) / cache read tokens, tool calls, duration.
- A line above the prompt: 5-hour and 7-day usage, the 5-hour reset, main-session and subagent tokens, and how many subagents inherited Opus, Fable or Mythos.
- A toast when a subagent inherits an expensive model; `subagentModelPolicy` can also downgrade such subagent types.
- Compaction after a turn that ended with an answer (60% of the context window or 150,000 tokens), skipped after a question or while background work runs; in desktop-app and SDK sessions it runs as a queued `/compact`.
- A warning at 88% and a handoff-brief request at 90% of the 5-hour window; separate thresholds for the 7-day window.

Install: `/plugin install subagent-cost --marketplace keienhrri-bit/claude-subagent-cost`

**About the "% of 5h quota" figure.** It is an estimate, and its error has not been measured. It weights tokens by API list prices and calibrates against the 5-hour percentage that Claude Code reports, once that percentage has moved 2 points. It assumes this is the only session using the account (other sessions push it too high), that list-price ratios match how plan usage is counted (not published by Anthropic), and it prices main-loop cache writes as 5-minute writes. Read it as an order of magnitude.

**What was tested.** The 34 unit and engine tests pass. In throwaway headless sessions (Claude Code 2.1.325, Haiku main model, low test thresholds), the handoff request was added between turns and Claude wrote the brief with the next message; no compaction followed a question or ran while a background subagent worked; after an answer, a queued `/compact` took the context from 28,180 to 7,090 tokens; and a background subagent's usage was reported apart from the main loop's.

**Not tested.** Drawing: headless sessions draw nothing, so the rows and the button have not been seen on screen, in the terminal or the desktop app. Direct between-turn compaction in an interactive terminal session. The estimate's error.
```

**相关项目互链**：同一作者的其他项目公开以后，可以在 README 末尾加一节 Related 互相链接。现在还没有可链接的公开仓库，先不加。

## 2. 收稿的列表

### testy-cool/awesome-claude-code-mods（提 PR）

- 维护情况：最近提交 2026-11-15（每天刷新星数）；每周一由 GitHub Action 开 issue 列出新 mod，维护者挑选加入。
- 规则原文：<https://github.com/testy-cool/awesome-claude-code-mods#add-one>。要点：提 PR，在 `.claude-plugin/marketplace.json` 里加一条；mod 要放在自己的公开仓库，带许可证；在它的仓库里 `claude plugin validate .` 要能通过。没有写仓库年龄或星数要求。
- 同类条目格式：`plugins` 数组里的一个对象，现有 86 条，`category` 全是 `appearance`，`tags` 是 `["mod"]`。
- 要加的条目：

```json
{
  "name": "subagent-cost",
  "description": "A Claude Code mod that shows each subagent's model and token use under its Agent row, keeps 5-hour and 7-day usage above the prompt, compacts after a finished task, and asks Claude for a handoff brief near the limit.",
  "author": {
    "name": "keienhrri-bit",
    "url": "https://github.com/keienhrri-bit"
  },
  "homepage": "https://github.com/keienhrri-bit/claude-subagent-cost",
  "category": "appearance",
  "tags": ["mod"],
  "source": {
    "source": "github",
    "repo": "keienhrri-bit/claude-subagent-cost"
  },
  "license": "MIT"
}
```

- PR 标题：`Add subagent-cost`。PR 正文：`Adds subagent-cost (MIT), a mod in its own public repository. claude plugin validate . passes with the entry added.` 提交前在它的仓库里加上条目，跑一次 `claude plugin validate .`，确认通过再提。

### karanb192/awesome-claude-code-mods（自动抓取，必要时补 seed PR）

见下面第 3 节。

## 3. 自动抓取的目录

### karanb192/awesome-claude-code-mods（mods.aidojo.si）

- 维护情况：最近提交 2026-11-16，扫描由 GitHub Actions 定时跑。
- 规则原文：<https://github.com/karanb192/awesome-claude-code-mods/blob/main/contributing.md>，以及 <https://github.com/karanb192/awesome-claude-code-mods/blob/main/SCANNING.md>。
- 怎么收录：每天用代码搜索找带 `hooks/hooks.json` 且 JSON 里有 `modules` 键的仓库；另外每 3 小时扫一次最近有推送、带 `claude-code-mod`（或 `claude-code-mods`、`claude-mods`、`function-hooks`、`claude-code-plugin`）topic 的仓库。扫描会克隆仓库，跑 `claude plugin validate`，记录 mod 用到的 hook 和 `$` 调用，再生成目录页。
- 本仓库已经满足：`hooks/hooks.json` 写了 `"modules": ["./register.tsx"]`；topic 里有 `claude-code-mod`。不用做别的。设好 topic 后再推送一次，通常几小时内就会被扫到。
- 没被收录时的补救：提 seed PR，把 `keienhrri-bit/claude-subagent-cost` 按字母顺序（不分大小写）插进 `data/seeds.txt`，跑 `npm test` 和 `npm run lint`。提之前先在 <https://mods.aidojo.si/> 搜一下，已经收录的话 seed PR 会被直接关掉。
- 注意：如果 README 写的权限比扫描记录到的少（比如“只读”“不联网”），seed 会被挂起。本仓库 README 已经写明会写自己的 `$.store`，并且会压缩对话、往对话里加交接请求。

### testy-cool/awesome-claude-code-mods 的每周 scout

它每周读 karanb192 的目录，把新 mod 列进 issue，由维护者挑选。被 karanb192 收录以后，可能会进它的候选，但不保证。

### claudemarketplaces.com

- 网站首页写着有爬虫定期发现条目、刷新安装数和星数，但没写爬虫找的是哪些文件或 topic。
- 主动提交要先在网站上用 GitHub 登录，不在本清单范围内。
- 本仓库有 `.claude-plugin/marketplace.json`，如果它的爬虫认这个文件就能被发现；这一点没有核实。

### claude-plugins.dev

2026-11-16 访问返回 HTTP 402，读不到收录规则，没有核实。

## 4. 看过但不建议投的

| 列表 | 原因 |
| --- | --- |
| [hesreallyhim/awesome-claude-code](https://github.com/hesreallyhim/awesome-claude-code) | 规则（[CONTRIBUTING.md](https://github.com/hesreallyhim/awesome-claude-code/blob/main/CONTRIBUTING.md)）要求仓库首次提交满 14 天且之后还有提交，或者有 100 星；只能本人在网页 issue 表单里推荐，明确写了不能用 `gh` 提交，推荐必须由真人发出。要等仓库首次提交满 14 天、之后又有提交，再由作者本人提交。提交时可以用这段描述（分类 Observability & Monitoring > Usage & Cost）：“A mod that shows each subagent's model and input, output and cache tokens under its Agent row, keeps 5-hour and 7-day usage above the prompt, compacts after a turn that ended with an answer, and asks Claude for a handoff brief near the usage limit. The per-subagent share of the 5-hour window is labelled as an estimate.” |
| [whyashthakker/awesome-claude-code-mods](https://github.com/whyashthakker/awesome-claude-code-mods) | 最近提交 2026-10-03，之后关掉的 PR 都没合并。 |
| [ccplugins/awesome-claude-code-plugins](https://github.com/ccplugins/awesome-claude-code-plugins) | 最近推送 2026-08-12，PR 列表接口返回 404。 |
| [jqueryscript/awesome-claude-code](https://github.com/jqueryscript/awesome-claude-code) | 投稿说明一节写着 “Under Construction”，维护者自己成批加条目，最近关掉的 PR 都没合并。 |
| [helloianneo/awesome-claude-code-skills](https://github.com/helloianneo/awesome-claude-code-skills) | 只收 Skills / Agents，不收 mod；最近关掉的 PR 都没合并。 |
| Anthropic 官方插件目录 | 要在开发者门户登录提交，不在本清单范围内。 |
