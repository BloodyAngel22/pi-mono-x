# Настройка MCP-серверов

Pi-x поддерживает [Model Context Protocol](https://modelcontextprotocol.io/) через встроенное расширение. MCP-серверы дают агенту доступ к веб-поиску, документации, семантическому анализу кода и другим внешним инструментам.

## Конфигурация

Файл: `~/.pi/agent/mcp-config.json`

При первом запуске создается шаблон автоматически.

```json
{
  "mcpServers": {
    "имя-сервера": {
      "type": "local" | "remote",
      "command": "команда",
      "args": ["аргументы"],
      "env": { "KEY": "value" },
      "url": "https://...",
      "headers": { "Authorization": "Bearer ..." },
      "disabled": false
    }
  }
}
```

### Поля

| Поле | Описание |
|------|----------|
| `type` | `"local"` -- запуск процесса (stdio), `"remote"` -- подключение по URL (SSE/HTTP) |
| `command` | Команда для запуска (для `local`): `npx`, `uvx`, `node` и т.д. |
| `args` | Аргументы команды |
| `env` | Переменные окружения для процесса |
| `url` | URL для remote-серверов |
| `headers` | HTTP-заголовки (поддерживает `{env:VAR_NAME}` для подстановки из окружения) |
| `disabled` | `true` чтобы временно отключить сервер |

## Рекомендуемые серверы

### context7 -- документация библиотек

Актуальная документация для любых библиотек и фреймворков. Работает как remote-сервер.

```json
"context7": {
  "type": "remote",
  "url": "https://mcp.context7.com/mcp",
  "headers": {
    "CONTEXT7_API_KEY": "{env:CONTEXT7_API_KEY}"
  }
}
```

Получите бесплатный ключ на [context7.com](https://context7.com) и добавьте в окружение:

```bash
export CONTEXT7_API_KEY="your-key"
```

### ddg-search -- DuckDuckGo

Веб-поиск через DuckDuckGo без API-ключей.

```json
"ddg-search": {
  "type": "local",
  "command": "uvx",
  "args": ["duckduckgo-mcp-server"]
}
```

Требует `uv` (Python package manager):

```bash
pip install uv
```

### serena -- семантический анализ кода

AST-анализ: поиск ссылок, иерархии типов, call-графы.

```json
"serena": {
  "type": "local",
  "command": "uvx",
  "args": [
    "--from", "git+https://github.com/oraios/serena",
    "serena", "start-mcp-server",
    "--context", "ide-assistant",
    "--project", "."
  ]
}
```

### sentry -- мониторинг ошибок

```json
"sentry": {
  "type": "local",
  "command": "npx",
  "args": ["@sentry/mcp-server@latest"]
}
```

## Полный пример

```json
{
  "mcpServers": {
    "context7": {
      "type": "remote",
      "url": "https://mcp.context7.com/mcp",
      "headers": {
        "CONTEXT7_API_KEY": "{env:CONTEXT7_API_KEY}"
      }
    },
    "ddg-search": {
      "type": "local",
      "command": "uvx",
      "args": ["duckduckgo-mcp-server"]
    },
    "serena": {
      "type": "local",
      "command": "uvx",
      "args": [
        "--from", "git+https://github.com/oraios/serena",
        "serena", "start-mcp-server",
        "--context", "ide-assistant",
        "--project", "."
      ]
    }
  }
}
```

## Логи

Логи MCP-серверов записываются в `~/.pi/agent/mcp/mcp.log`. Полезно для отладки подключений.

## Permissions для MCP

Чтобы агент не спрашивал подтверждение для каждого вызова MCP-инструмента, добавьте правила в [permissions.json](permissions.md):

```json
{
  "mcp": {
    "allow": [
      "fetch_content",
      "resolve-library-id",
      "query-docs"
    ]
  }
}
```
