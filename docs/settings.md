# Настройки (Settings)

Pi использует JSON-файлы настроек. Локальные настройки проекта перекрывают глобальные.

## Файлы

| Файл | Область |
|------|---------|
| `~/.pi/agent/settings.json` | Глобальные (все проекты) |
| `.pi/settings.json` | Локальные (текущий проект, приоритет выше) |

Редактируйте вручную или через `/settings` в интерактивном режиме.

## Основные настройки

### Модель и thinking

| Параметр | Тип | Описание |
|----------|-----|----------|
| `defaultProvider` | string | Провайдер по умолчанию (`"anthropic"`, `"openai"`, `"omniroute"` и т.д.) |
| `defaultModel` | string | ID модели по умолчанию |
| `defaultThinkingLevel` | string | `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"` |
| `hideThinkingBlock` | boolean | Скрывать блоки thinking в выводе |

### Интерфейс

| Параметр | Тип | По умолчанию | Описание |
|----------|-----|--------------|----------|
| `theme` | string | `"dark"` | Тема оформления (см. [themes.md](themes.md)) |
| `showHardwareCursor` | boolean | `false` | Показывать курсор терминала |
| `editorPaddingX` | number | `0` | Горизонтальный отступ редактора (0-3) |
| `treeFilterMode` | string | `"default"` | Фильтр для `/tree` |
| `quietStartup` | boolean | `false` | Скрывать заголовок при запуске |
| `vimModeEnabled` | boolean | `false` | Включить Vim-режим редактирования (INSERT/NORMAL/VISUAL) |

### Изображения

| Параметр | Тип | Описание |
|----------|-----|----------|
| `images.blockImages` | boolean | Блокировать отправку изображений в LLM |
| `images.autoResize` | boolean | Автоуменьшение до 2000x2000 |
| `terminal.showImages` | boolean | Показывать изображения в терминале |

### Компактизация контекста

| Параметр | Тип | По умолчанию | Описание |
|----------|-----|--------------|----------|
| `compaction.enabled` | boolean | `true` | Автоматическая компактизация |
| `compaction.reserveTokens` | number | `16384` | Резерв токенов для ответа LLM |
| `compaction.keepRecentTokens` | number | `20000` | Сколько недавних токенов сохранять |

### Многословность инструментов

Управляет тем, сколько вывода показывается для каждого инструмента:

| Параметр | Значения | Описание |
|----------|----------|----------|
| `toolVerbosity.<tool>` | `"compact"`, `"full"` | Режим отображения для конкретного инструмента |

```json
{
  "toolVerbosity": {
    "mcp": "compact",
    "read": "compact",
    "find": "compact",
    "grep": "compact",
    "ls": "compact",
    "bash": "full",
    "write": "full",
    "edit": "full"
  }
}
```

### Fast Fetch

`fast_fetch` — встроенный инструмент для быстрого веб-поиска/загрузки URL без MCP-серверов. По умолчанию использует DuckDuckGo HTML, но endpoint можно заменить в настройках.

| Параметр | Тип | По умолчанию | Описание |
|----------|-----|--------------|----------|
| `fastFetch.searchUrl` | string | `https://html.duckduckgo.com/html/` | URL поискового endpoint |
| `fastFetch.queryParam` | string | `q` | Имя query-параметра |
| `fastFetch.headers` | object | - | HTTP-заголовки |
| `fastFetch.timeoutMs` | number | `20000` | Таймаут запроса в миллисекундах |
| `fastFetch.maxBytes` | number | `65536` | Максимум байт ответа |
| `fastFetch.maxResults` | number | `5` | Сколько результатов/сниппетов оставить |

Пример с SearXNG:

```json
{
  "fastFetch": {
    "searchUrl": "https://searx.example.com/search",
    "queryParam": "q",
    "headers": {
      "Accept": "text/html"
    },
    "timeoutMs": 10000,
    "maxBytes": 65536,
    "maxResults": 5
  }
}
```

> **Примечание:** Для веб-поиска рекомендуется использовать MCP-инструменты (например, `searxng_web_search`, `searxng_web_url_read`) вместо `fast_fetch`. MCP-инструменты, как правило, более надёжны и дают более точные результаты. `fast_fetch` лучше использовать как запасной вариант, когда MCP недоступен или медленен.

### Терминал

| Параметр | Тип | Описание |
|----------|-----|----------|
| `terminal.showTerminalProgress` | boolean | Показывать прогресс в терминале |
| `terminal.clearOnShrink` | boolean | Очищать пустые строки при уменьшении контента |

### Повторы при ошибках

```json
{
  "retry": {
    "enabled": true,
    "maxRetries": 3,
    "baseDelayMs": 2000
  }
}
```

## Рекомендуемый конфиг

```json
{
  "defaultProvider": "omniroute",
  "defaultModel": "opencode-zen/minimax-m2.5-free",
  "defaultThinkingLevel": "medium",
  "theme": "dark",
  "showHardwareCursor": false,
  "hideThinkingBlock": true,
  "editorPaddingX": 2,
  "images": {
    "blockImages": true
  },
  "terminal": {
    "showTerminalProgress": true,
    "clearOnShrink": true
  },
  "toolVerbosity": {
    "mcp": "compact",
    "read": "compact",
    "find": "compact",
    "grep": "compact",
    "ls": "compact",
    "bash": "full",
    "write": "full",
    "edit": "full",
    "fast_fetch": "compact"
  },
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  },
  "retry": {
    "enabled": true,
    "maxRetries": 3
  }
}
```

## Переопределение для проекта

Локальные настройки (`.pi/settings.json`) мержатся с глобальными. Вложенные объекты объединяются:

```json
// ~/.pi/agent/settings.json (глобальный)
{ "theme": "dark", "compaction": { "enabled": true, "reserveTokens": 16384 } }

// .pi/settings.json (проект)
{ "compaction": { "reserveTokens": 8192 } }

// Результат
{ "theme": "dark", "compaction": { "enabled": true, "reserveTokens": 8192 } }
```

Полная документация всех параметров: [packages/coding-agent/docs/settings.md](../packages/coding-agent/docs/settings.md)
