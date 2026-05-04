# pi-x

Форк [pi-mono](https://github.com/badlogic/pi-mono) с системой суб-агентов, управлением правами доступа, plan mode и MCP-интеграцией.

## Что изменено по сравнению с оригиналом

### Система прав доступа (permissions)

Гибкое управление тем, какие команды агент может выполнять без подтверждения:

- Вложенный формат `permissions.json` с секциями `bash`, `mcp`, `file` и политиками `allow` / `ask` / `deny`
- Автоматическая миграция из старого плоского формата
- Разбор составных bash-команд (`&&`, `||`, `;`, `|`) -- побеждает самая строгая политика
- Встроенные критические блокировки (`rm -rf /`, `dd of=/dev/...`, fork-bomb и т.д.)
- Управление через `/permissions`

Глобальный файл: `~/.pi/agent/permissions.json`
Локальный (для проекта): `<project>/.pi/permissions.json`

Пример:
```json
{
  "defaultPolicy": "ask",
  "bash": {
    "allow": ["ls *", "cat *", "pwd", "grep *", "find *"],
    "ask": ["git *", "npm *", "rm *"]
  },
  "mcp": {
    "allow": ["searxng_web_search", "query-docs"]
  }
}
```

### Plan Mode

- `/plan <описание>` -- агент анализирует код и составляет план, не выполняя команд
- `/execute` -- выход из режима планирования и выполнение плана
- Автоматическое разрешение записи в plan-файлы

### Система суб-агентов

Инструмент `task` делегирует тяжелые задачи изолированным агент-сессиям с чистым контекстным окном. В основной контекст возвращается только итоговый результат, что экономит токены.

**Когда используются суб-агенты:**
- Исследование кодовой базы (чтение множества файлов)
- Веб-поиск через MCP (searxng, context7, ddg-search)
- Code review и аудит безопасности
- Семантический анализ кода через Serena MCP
- Параллельные независимые задачи (до 3 одновременно)

Ллм сам решает, когда делегировать, на основе системного промпта.

**Кастомные агенты** -- создайте `.md` файлы в `.pi/agents/` (проект) или `~/.pi/agent/agents/` (глобально):

```markdown
---
name: security-reviewer
description: Ревью кода на уязвимости
tools: [read, grep, find, ls, bash]
mcpTools: [searxng_*, context7_*]
---
Ты security-ревьюер. Анализируй код на SQL injection, XSS, утечки данных.
Возвращай приоритезированные находки с file:line.
```

Подробнее: [docs/subagents.md](packages/coding-agent/docs/subagents.md)

### File Checkpointing

До того как агент изменяет файл (`write` / `edit`), оригинал автоматически копируется в `/tmp/.pi/checkpoints/<session-id>/`. В любой момент:

- `/checkpoint` — показать список изменённых и созданных файлов
- `/undo` — открывает интерактивный селектор: откатить **все** файлы сразу или выбрать конкретный

Подробнее: [docs/file-checkpointing.md](packages/coding-agent/docs/file-checkpointing.md)

### Markdown Commands

Slash-команды как `.md`-файлы без TypeScript. Кладёте файл в `~/.pi/agent/commands/` или `.pi/commands/`, вызываете `/имя [args]`. Опциональный frontmatter позволяет ограничить набор инструментов (`allowed-tools`) и временно переключить модель (`model`) на время этой команды.

Подробнее: [docs/markdown-commands.md](packages/coding-agent/docs/markdown-commands.md)

### Shell Hooks

Исполняемые скрипты, срабатывающие на события агента (`agent_start`, `agent_end`, `turn_start`, `turn_end`, `tool_execution_start`, `tool_execution_end`). Кладёте скрипт с именем события в `~/.pi/agent/hooks/` или `.pi/hooks/`. Данные приходят в stdin как JSON + через env vars `PI_EVENT`, `PI_CWD`, `PI_SESSION_ID`.

Подробнее: [docs/hooks.md](packages/coding-agent/docs/hooks.md)

### Флаг `--max-turns`

Ограничивает количество итераций агента за один промпт. Удобно в CI/headless-режиме:

```bash
pi -p --max-turns 5 --no-session "Запусти тесты и исправь упавшие"
```

Без числа — дефолт 10.

### Новые slash-команды

| Команда | Описание |
|---------|----------|
| `/cd <path>` | Сменить рабочую директорию |
| `/pwd` | Показать текущую директорию |
| `/ls [path]` | Показать содержимое директории |
| `/permissions` | Просмотр и управление правами доступа |
| `/plan <desc>` | Войти в режим планирования |
| `/execute` | Выполнить план |
| `/tasks` | Показать запущенные и недавние задачи суб-агентов |
| `/agents` | Список доступных специализированных суб-агентов |

## Установка

### Из исходников (рекомендуется)

```bash
git clone https://github.com/BloodyAngel22/pi-mono-x.git
cd pi-mono-x
npm install
./build.sh              # Собрать все пакеты
cd packages/coding-agent
npm link
```

Запуск:
```bash
pi
```

### Сборка с опциями

```bash
./build.sh --clean      # Очистить dist перед сборкой
./build.sh --no-web-ui  # Пропустить web-ui (быстрее, для CLI не нужен)
```

## Настройка провайдера

После установки нужно подключить API-ключ. Например, для Anthropic:

```bash
export ANTHROPIC_API_KEY="sk-..."
```

Или через интерактивный вход:
```
/login
```

Поддерживаемые провайдеры: Anthropic, OpenAI, Google Gemini, Groq, xAI, OpenRouter и другие.
Полный список: [packages/coding-agent/docs/providers.md](packages/coding-agent/docs/providers.md)

## Документация

| Тема | Описание |
|------|----------|
| **[Настройки](docs/settings.md)** | Параметры `settings.json`: модель, тема, компактизация, verbose и др. |
| **[Права доступа](docs/permissions.md)** | Конфигурация `permissions.json`: bash, MCP, файловые политики |
| **[MCP-серверы](docs/mcp.md)** | Подключение context7, searxng, ddg-search, serena и других |
| **[Темы](docs/themes.md)** | Создание кастомных цветовых тем |
| **[Суб-агенты](packages/coding-agent/docs/subagents.md)** | Система делегирования задач и кастомные агенты |
| **[File Checkpointing](packages/coding-agent/docs/file-checkpointing.md)** | Автоматические снапшоты файлов + `/undo` и `/checkpoint` |
| **[Markdown Commands](packages/coding-agent/docs/markdown-commands.md)** | Slash-команды из `.md`-файлов с опциональным ограничением инструментов и модели |
| **[Shell Hooks](packages/coding-agent/docs/hooks.md)** | Shell-скрипты на события агента (`agent_end`, `turn_end` и др.) |
| **[Провайдеры](packages/coding-agent/docs/providers.md)** | Настройка API-ключей и провайдеров |
| **[CLI Reference](packages/coding-agent/docs/usage.md)** | Все CLI-флаги включая `--max-turns` |

## Разработка

```bash
npm install          # Установить зависимости
./build.sh           # Собрать все пакеты
npm run check        # Линтинг, форматирование, проверка типов
./test.sh            # Запуск тестов
./pi-test.sh         # Запуск pi-x из исходников
```

## Пакеты

| Пакет | Описание |
|-------|----------|
| **[pi-ai](packages/ai)** | Единый API для LLM-провайдеров (OpenAI, Anthropic, Google и др.) |
| **[pi-agent-core](packages/agent)** | Рантайм агента с вызовом инструментов |
| **[pi-coding-agent](packages/coding-agent)** | Интерактивный CLI-агент для кодинга |
| **[pi-tui](packages/tui)** | Библиотека терминального UI |
| **[pi-web-ui](packages/web-ui)** | Веб-компоненты для AI-чатов |

## Upstream

Оригинальный проект: [badlogic/pi-mono](https://github.com/badlogic/pi-mono)

## Лицензия

MIT
