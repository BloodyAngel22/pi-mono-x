# Темы

Pi поддерживает кастомные цветовые темы для терминального интерфейса. Темы -- это JSON-файлы с определением 51 цветового токена.

## Расположение

| Путь | Описание |
|------|----------|
| Встроенные | `dark`, `light` |
| `~/.pi/agent/themes/*.json` | Глобальные (все проекты) |
| `.pi/themes/*.json` | Локальные (текущий проект) |

## Выбор темы

Через `/settings` в интерактивном режиме или в `settings.json`:

```json
{
  "theme": "my-theme"
}
```

## Создание своей темы

```bash
mkdir -p ~/.pi/agent/themes
```

Создайте файл `~/.pi/agent/themes/my-theme.json`:

```json
{
  "$schema": "https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/src/modes/interactive/theme/theme-schema.json",
  "name": "my-theme",
  "vars": {
    "primary": "#00aaff",
    "secondary": 242,
    "bg_dark": "#1e1e2e"
  },
  "colors": {
    "accent": "primary",
    "border": "primary",
    "borderAccent": "#00ffff",
    "borderMuted": "secondary",
    "success": "#00ff00",
    "error": "#ff0000",
    "warning": "#ffff00",
    "muted": "secondary",
    "dim": 240,
    "text": "",
    "thinkingText": "secondary",
    "selectedBg": "bg_dark",
    "userMessageBg": "bg_dark",
    "userMessageText": "",
    "customMessageBg": "bg_dark",
    "customMessageText": "",
    "customMessageLabel": "primary",
    "toolPendingBg": "#1e1e2e",
    "toolSuccessBg": "#1e2e1e",
    "toolErrorBg": "#2e1e1e",
    "toolTitle": "primary",
    "toolOutput": "",
    "mdHeading": "#ffaa00",
    "mdLink": "primary",
    "mdLinkUrl": "secondary",
    "mdCode": "#00ffff",
    "mdCodeBlock": "",
    "mdCodeBlockBorder": "secondary",
    "mdQuote": "secondary",
    "mdQuoteBorder": "secondary",
    "mdHr": "secondary",
    "mdListBullet": "#00ffff",
    "toolDiffAdded": "#00ff00",
    "toolDiffRemoved": "#ff0000",
    "toolDiffContext": "secondary",
    "syntaxComment": "secondary",
    "syntaxKeyword": "primary",
    "syntaxFunction": "#00aaff",
    "syntaxVariable": "#ffaa00",
    "syntaxString": "#00ff00",
    "syntaxNumber": "#ff00ff",
    "syntaxType": "#00aaff",
    "syntaxOperator": "primary",
    "syntaxPunctuation": "secondary",
    "thinkingOff": "secondary",
    "thinkingMinimal": "primary",
    "thinkingLow": "#00aaff",
    "thinkingMedium": "#00ffff",
    "thinkingHigh": "#ff00ff",
    "thinkingXhigh": "#ff0000",
    "bashMode": "#ffaa00"
  }
}
```

**Hot reload:** При редактировании активной темы pi применяет изменения мгновенно.

## Структура

- `name` -- уникальное имя темы (обязательно)
- `vars` -- переиспользуемые цвета, на которые можно ссылаться в `colors`
- `colors` -- все 51 цветовой токен (обязательно заполнить все)

## Группы токенов

| Группа | Количество | Примеры |
|--------|------------|---------|
| Core UI | 11 | `accent`, `border`, `success`, `error`, `warning`, `muted`, `text` |
| Фоны и контент | 11 | `selectedBg`, `userMessageBg`, `toolPendingBg`, `toolSuccessBg` |
| Markdown | 10 | `mdHeading`, `mdLink`, `mdCode`, `mdCodeBlock`, `mdListBullet` |
| Diff | 3 | `toolDiffAdded`, `toolDiffRemoved`, `toolDiffContext` |
| Подсветка синтаксиса | 9 | `syntaxKeyword`, `syntaxFunction`, `syntaxString`, `syntaxNumber` |
| Уровни thinking | 6 | `thinkingOff` ... `thinkingXhigh` |
| Bash mode | 1 | `bashMode` |

## Форматы цветов

| Формат | Пример | Описание |
|--------|--------|----------|
| Hex | `"#ff0000"` | RGB в hex |
| 256-color | `39` | Индекс палитры xterm (0-255) |
| Переменная | `"primary"` | Ссылка на `vars` |
| Дефолт | `""` | Цвет по умолчанию терминала |

## Советы

- Используйте `$schema` для автодополнения в редакторе
- Начните с существующей палитры (Nord, Gruvbox, Tokyo Night, Everforest) и определите ее в `vars`
- Для VS Code: установите `terminal.integrated.minimumContrastRatio: 1` для точных цветов
- Встроенные темы для справки: [dark.json](../packages/coding-agent/src/modes/interactive/theme/dark.json), [light.json](../packages/coding-agent/src/modes/interactive/theme/light.json)

Полная документация по темам: [packages/coding-agent/docs/themes.md](../packages/coding-agent/docs/themes.md)
