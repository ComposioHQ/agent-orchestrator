# Agent Orchestrator To'liq Qo'llanma (UZ)

Ushbu hujjat `agent-orchestrator` ni **alohida loyihada ishlab turib** ishlatish uchun yozilgan.
Maqsad: imkoniyatlar, arxitektura, ish oqimi, z.ai GLM integratsiyasi, API va operatsion qoidalarni bitta joyga jamlash.

## 1. Loyiha nima qiladi

Agent Orchestrator (AO) bir nechta AI coding agentlarni parallel boshqaradi:

- har bir task uchun alohida session ochadi
- har bir session uchun alohida branch/workspace yaratadi
- PR/CI/review holatini kuzatadi
- kerak bo'lsa agentga avtomatik qayta topshiriq yuboradi
- dashboard va CLI orqali real-time nazorat beradi

Bu "1 ta agent bilan terminalda ishlash" emas, balki "ko'p agentli ishlab chiqarish oqimi" uchun orchestrator.

## 2. Arxitektura (source-of-truth)

Asosiy arxitektura `packages/core/src/types.ts` asosida:

- Runtime (qayerda ishlaydi): `tmux`, `process`
- Agent (qaysi coding agent): `claude-code`, `codex`, `aider`, `zai`
- Workspace (izolyatsiya): `worktree`, `clone`
- Tracker (issue manbasi): `github`, `linear`
- SCM (PR/CI/review): `github`
- Notifier: `desktop`, `slack`, `webhook`, `composio`
- Terminal plugin: `iterm2`, `web`
- Lifecycle manager (core): status transition + reaction engine

Muhim: AO plugin-based, lekin session lifecycle va metadata boshqaruvi core ichida.

## 3. Haqiqiy imkoniyatlar (kod bo'yicha)

### CLI buyruqlari

`ao` quyidagilarni beradi:

- `init`
- `start`
- `stop`
- `status`
- `spawn`
- `batch-spawn`
- `session ls|kill|cleanup|restore`
- `send`
- `review-check`
- `dashboard`
- `open`

### Dashboard

- attention zonalar: `merge`, `respond`, `review`, `pending`, `working`, `done`
- PR jadvali (CI/review/unresolved commentlar)
- session card actions: send/kill/restore/merge
- orchestrator session uchun alohida detail page
- real-time yangilanish: `/api/events` (SSE, poll-based snapshot)
- live terminal: WebSocket + `xterm.js` (`direct-terminal`)

### API endpointlar (web)

`packages/web/src/app/api` bo'yicha:

- `GET /api/sessions`
- `GET /api/sessions/:id`
- `POST /api/spawn`
- `POST /api/sessions/:id/send`
- `POST /api/sessions/:id/message`
- `POST /api/sessions/:id/kill`
- `POST /api/sessions/:id/restore`
- `POST /api/prs/:id/merge`
- `GET /api/events` (SSE)

## 4. Alohida loyihada ishlatish (recommended workflow)

### 4.1. 1 martalik o'rnatish

Repo ni klon qilasiz va CLI ni global ishlatishga tayyorlaysiz:

```bash
git clone https://github.com/ComposioHQ/agent-orchestrator.git
cd agent-orchestrator
bash scripts/setup.sh
```

`scripts/setup.sh`:

- `pnpm install`
- monorepo build
- `npm link` orqali `ao` command ni global qiladi

Environment shablon:

```bash
cp .env.example .env
```

Keyin kerakli qiymatlarni to'ldiring (`ZAI_API_KEY`, `LINEAR_API_KEY`, `COMPOSIO_API_KEY`, va h.k.).

### 4.2. Ishlaydigan loyiha ichida init

Endi siz boshqarmoqchi bo'lgan target loyiha papkasiga o'ting:

```bash
cd ~/your-project
ao init --auto
```

Yoki interaktiv:

```bash
ao init
```

`ao init --auto --smart` ham bor (template rules generatsiya qiladi, AI mode hozir TODO).

### 4.3. Minimal config namunasi

```yaml
port: 3000

defaults:
  runtime: tmux
  agent: claude-code
  workspace: worktree
  notifiers: [desktop]

projects:
  my-app:
    repo: owner/my-app
    path: ~/my-app
    defaultBranch: main
```

### 4.4. Boshlash va birinchi session

```bash
gh auth login
ao start
ao spawn my-app 123
```

Issue ixtiyoriy:

```bash
ao spawn my-app
```

Issue bo'lmasa branch `session/<id>` formatida ketadi.

## 5. Config qoidalari va discovery

Config fayl nomi:

- `agent-orchestrator.yaml`
- yoki `agent-orchestrator.yml`

Qidirish tartibi (`packages/core/src/config.ts`):

1. `AO_CONFIG_PATH` env
2. current directory dan yuqoriga qarab tree search
3. home locationlar (`~/.agent-orchestrator.yaml`, va h.k.)

Amaliy tavsiya:

- har bir target repo root'ida o'z config bo'lsin
- yoki markaziy config uchun `AO_CONFIG_PATH` ishlating

## 6. Kundalik ish oqimi

### 6.1. Bir nechta issue parallel

```bash
ao batch-spawn my-app INT-101 INT-102 INT-103
```

`batch-spawn` duplicate issue'larni tekshiradi:

- allaqachon session bor bo'lsa skip
- shu batch ichida takror bo'lsa skip

### 6.2. Monitoring

CLI:

```bash
ao status
ao status -p my-app
ao status --json
```

Dashboard:

- `ao start` yoki `ao dashboard`
- default `http://localhost:3000`

### 6.3. Agentga instruction yuborish

```bash
ao send app-1 "CI xatolarini to'liq yopib push qiling"
ao send app-1 --file ./message.txt
```

`send` busy detection va retry qiladi.

### 6.4. Session restore

```bash
ao session restore app-1
```

Restore quyidagilarni qiladi:

- archived metadata dan ham qidiradi
- kerak bo'lsa workspace restore qiladi
- runtime ni qayta ko'taradi

Merged session restore qilinmaydi (`SessionNotRestorableError`).

### 6.5. Cleanup

```bash
ao session cleanup -p my-app --dry-run
ao session cleanup -p my-app
```

Cleanup kriteriyalari:

- PR merged/closed
- issue completed
- runtime dead

## 7. Reaction engine (automation)

Core default reactionlar:

- `ci-failed` -> `send-to-agent`
- `changes-requested` -> `send-to-agent`
- `merge-conflicts` -> `send-to-agent`
- `approved-and-green` -> `notify` (default auto false)
- `agent-stuck` / `agent-needs-input` -> `notify`
- `all-complete` -> `notify`

Reaction config:

- `retries`
- `escalateAfter` (`2`, `30m`, `10m` formatlar)
- `priority`

Project-level override `projects.<id>.reactions` bilan beriladi.

## 8. z.ai GLM integratsiyasi (GLM 3.7+ uchun)

AO ichida `zai` agent plugin bor (`packages/plugins/agent-zai/src/index.ts`).
Bu plugin Claude Code plugin ustiga qurilgan va Anthropic-compatible endpointga route qiladi.

### 8.1. Ishlash mexanizmi

- `agent: zai` bo'lsa launch command Claude Code formatida yuradi
- environment qo'shiladi:
  - `ANTHROPIC_BASE_URL` (default `https://api.z.ai/api/anthropic`)
  - `ANTHROPIC_AUTH_TOKEN` (`ZAI_API_KEY` yoki fallback `ANTHROPIC_AUTH_TOKEN`)
- model qiymati passthrough qilinadi (`--model`)

Shuning uchun GLM model nomini to'g'ridan-to'g'ri berish mumkin.

### 8.2. Config namunasi (GLM)

```yaml
defaults:
  agent: zai
  runtime: tmux
  workspace: worktree

projects:
  my-app:
    repo: owner/my-app
    path: ~/my-app
    defaultBranch: main
    agentConfig:
      model: glm-3.7
      # optional:
      # zaiModel: glm-4.5
      # zaiApiKeyEnv: ZAI_API_KEY
      # zaiBaseUrl: https://api.z.ai/api/anthropic
```

Env:

```bash
export ZAI_API_KEY="your_zai_key"
```

Eslatma:

- Model availability z.ai akkaunt va endpointga bog'liq.
- AO model nomini validatsiya qilmaydi; string pass-through qiladi.
- Agar token yo'q bo'lsa plugin aniq xato qaytaradi.

## 9. Dashboard/API bilan integratsiya (external automation)

Misollar:

Sessionlar ro'yxati:

```bash
curl http://localhost:3000/api/sessions
```

Yangi session spawn:

```bash
curl -X POST http://localhost:3000/api/spawn \
  -H "Content-Type: application/json" \
  -d '{"projectId":"my-app","issueId":"123"}'
```

Sessionga xabar yuborish:

```bash
curl -X POST http://localhost:3000/api/sessions/app-1/send \
  -H "Content-Type: application/json" \
  -d '{"message":"Please re-run tests and push fixes"}'
```

Restore:

```bash
curl -X POST http://localhost:3000/api/sessions/app-1/restore
```

SSE stream:

```bash
curl -N http://localhost:3000/api/events
```

## 10. Operatsion cheklovlar (muqarrar nuqtalar)

### Platform

Loyiha amalda Unix/macOS flowga yaqin:

- `tmux`, `sh`, `lsof`, `kill`, `open` commandlar ishlatiladi
- Windows native flow uchun qo'shimcha moslashtirish kerak bo'lishi mumkin

### Web service plugin loading

`packages/web/src/lib/services.ts` hozir statik plugin register qiladi:

- runtime: `tmux`
- agents: `claude-code`, `zai`
- workspace: `worktree`
- tracker: `github`, `linear`
- scm: `github`

CLI tomoni esa pluginlarni kengroq yuklaydi.

### `open` command

`ao open` tmux sessionlar bilan ishlaydi; `open-iterm-tab` bo'lmasa manual attach hint beradi.

### `session attach`

Hozirgi CLI'da `ao session attach` yo'q.
Attach qilish uchun:

```bash
tmux attach -t <tmux-session-name>
```

## 11. Governance (ushbu fork uchun)

`AGENTS.md` bo'yicha:

- `upstream` ga push qilinmaydi
- faqat `origin` ga push
- internal code default locked
- internal edit uchun explicit unlock command kerak: `@unlock-internal-edit`

Bu qoidalarni CI/hook darajasida ham saqlash tavsiya etiladi.

## 12. Professional amaliy tavsiyalar

- Har project uchun aniq `sessionPrefix` bering (collision oldini oladi).
- `agentRules` yoki `agentRulesFile` orqali coding standardni majburiy qiling.
- `postCreate` da dependency installni standartlashtiring.
- `notificationRouting` ni priority bo'yicha ajrating.
- `--dry-run` variantlarini avval ishlatib keyin destructive command bering.
- `batch-spawn` dan oldin `ao status` bilan duplicate holatlarni tekshiring.

## 13. Tezkor cheat sheet

```bash
# setup
ao init --auto

# boot
ao start

# spawn
ao spawn <project> <issue>
ao batch-spawn <project> <issue1> <issue2> ...

# observe
ao status
ao session ls -p <project>

# interact
ao send <session> "..."
ao session restore <session>
ao session cleanup --dry-run
ao session cleanup

# web
ao dashboard --port 3000
```

---

Manba sifatida kod ishlatilgan:

- `packages/core/*`
- `packages/cli/*`
- `packages/web/*`
- `packages/plugins/*`
- `AGENTS.md`
- `examples/*`
