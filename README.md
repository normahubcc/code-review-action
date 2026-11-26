<p align="center">
  <a href="https://normahub.cc">
    <img src="https://raw.githubusercontent.com/normahubcc/.github/main/docs/images/logo.png" alt="NormaHub" width="120" />
  </a>
</p>

# NormaHub AI Code Review Action

[![GitHub Marketplace](https://img.shields.io/badge/Marketplace-NormaHub_Code_Review-blue?style=flat-square&logo=github-actions)](https://github.com/marketplace/actions/normahub-ai-code-review)
[![GitHub Action](https://img.shields.io/badge/action-NormaHub_Code_Review-purple?style=flat-square&logo=github)](https://github.com/normahubcc/code-review-action)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg?style=flat-square)](LICENSE)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-zero-blue.svg?style=flat-square)](package.json)
[![Models](https://img.shields.io/badge/models-DeepSeek_|_Claude-6366f1.svg?style=flat-square)](https://normahub.cc/models)

Автоматизированный GitHub Action для проведения код-ревью в Pull Request на базе моделей [NormaHub API](https://normahub.cc) (DeepSeek v4.1 Flash, Claude Sonnet 5.5).

---

## Ключевые возможности

- 🛡️ **Фокус на реальных багах:** Ищет уязвимости (OWASP, инъекции, утечки секретов), race conditions, неперехваченные ошибки в async, утечки ресурсов и регрессии. Не спамит придирками к стилю и форматированию (табы, точки с запятой), доверяя это линтерам.
- 🧹 **Умная фильтрация шума (Smart Noise Filter):** Автоматически исключает из анализа lock-файлы (`pnpm-lock.yaml`, `package-lock.json`, `Cargo.lock`), минифицированные бандлы (`dist/**`, `build/**`), медиа-ассеты и вендорные директории.
- 🔄 **Анти-спам (Idempotent Updates):** При повторных пушах в PR бот **редактирует свой существующий комментарий**, а не плодит новые простыни текста. In-line замечания публикуются один раз на PR — повторный запуск обновляет summary-комментарий, чтобы не дублировать комментарии к строкам.
- ⚡ **Zero Dependencies:** Написан на стандартном Node.js 18+ (`fetch`), работает мгновенно без `npm install`.
- 💰 **Экономика:** На модели `deepseek-v4.1-flash` средняя стоимость полного ревью одного PR составляет **~$0.0005 (менее половины копейки)**.

---

## Быстрый старт

Создайте в своем репозитории файл `.github/workflows/ai-review.yml`:

```yaml
name: NormaHub Code Review

on:
  pull_request:
    types: [opened, synchronize]

jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - name: NormaHub AI Review
        uses: normahubcc/code-review-action@v1
        with:
          normahub_api_key: ${{ secrets.NORMAHUB_API_KEY }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
          model: 'deepseek-v4.1-flash' # или 'claude-sonnet-5-5'
```

Добавьте ваш API-ключ в **Settings > Secrets and variables > Actions > Secrets**:
- **Name:** `NORMAHUB_API_KEY`
- **Value:** ключ из личного кабинета [normahub.cc](https://normahub.cc)

---

## Пример вердикта в Pull Request

> 🔍 **Живая витрина кода:** Посмотрите реальный код и дифф в ветке [`demo/showcase-code-review`](https://github.com/normahubcc/code-review-action/tree/demo/showcase-code-review) или откройте [сравнение веток (Compare Pull Request)](https://github.com/normahubcc/code-review-action/compare/main...demo/showcase-code-review).

Бот публикует лаконичный структурированный комментарий без спама придирками к стилю, фокусируясь только на реальных дефектах:

<details open>
<summary><b>🤖 NormaHub Code Review — ⚠️ CHANGES REQUESTED (1 Critical, 1 Warning)</b></summary>

### 🎯 Резюме
В PR обнаружена потенциальная уязвимость SQL Injection в обработчике авторизации и утечка обработчика событий при отмене сетевого запроса.

### 🚨 Критические замечания (Critical)
- **`src/auth/login.ts` (L42): SQL Injection**  
  Параметр `username` передаётся напрямую в конкатенацию SQL-запроса без экранирования.  
  *Рекомендация:* Использовать параметризованный запрос `$1` через пул соединений.

### ⚠️ Предупреждения (Warnings & Suggestions)
- **`src/services/network.ts` (L75): Resource Leak**  
  Слушатель `abort` не удаляется при успешном завершении запроса, вызывая рост числа слушателей на `AbortController`.

---
<sub>Reviewed with NormaHub API (`deepseek-v4.1-flash`) · <a href="https://normahub.cc">normahub.cc</a></sub>
</details>

---

## Поддержка внешних форков (Open Source)

Для открытых репозиториев, где PR приходят из форков сторонних контрибьюторов, используйте триггер `pull_request_target`, чтобы action имел доступ к секрету `NORMAHUB_API_KEY`:

```yaml
on:
  pull_request_target:
    types: [opened, synchronize]

jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: normahubcc/code-review-action@v1
        with:
          normahub_api_key: ${{ secrets.NORMAHUB_API_KEY }}
```

> [!WARNING]
> `pull_request_target` выполняется с правами базовой ветки и доступом к секретам. Не добавляйте в такой workflow `actions/checkout` с кодом из PR (`ref: ${{ github.event.pull_request.head.sha }}`) и не запускайте скрипты из PR — это даёт контрибьютору выполнение произвольного кода с вашими секретами. Action не требует checkout: дифф забирается через API и проверяется только текстом.

---

## Ограничения GitHub API

GitHub не отдаёт диффы больше **300 изменённых файлов** или **20 000 строк** (HTTP 406). В этом случае action не падает: он публикует (или обновляет) комментарий о том, что ревью пропущено, и завершается успешно. Разбейте PR на меньшие — следующее ревью пройдёт по обычному сценарию.

---

## Параметры (Inputs)

| Параметр | Описание | Обязательный | По умолчанию |
|---|---|---|---|
| `normahub_api_key` | API-ключ от NormaHub | **Да** | — |
| `github_token` | GitHub токен для публикации/обновления комментариев | Нет | токен workflow (`github.token`) |
| `model` | Идентификатор модели (`deepseek-v4.1-flash`, `claude-sonnet-5-5`) | Нет | `deepseek-v4.1-flash` |
| `max_diff_length` | Лимит символов диффа, после которого остаток отбрасывается | Нет | `50000` |
| `ignore_patterns` | Дополнительные regex-паттерны для исключения файлов через запятую | Нет | `""` |
| `fail_on_critical` | Прерывать ли выполнение шага (`true`/`false`) при обнаружении уязвимостей | Нет | `false` |
| `inline_comments` | Публиковать интерактивные in-line замечания с кнопкой «Commit suggestion» | Нет | `true` |

Для работы action достаточно `permissions: contents: read` и `pull-requests: write`.

---

## Конфигурация в репозитории

Action читает `.normahub-review.yml` (или `.github/normahub-review.yml`) из workspace (нужен шаг `actions/checkout`) — см. [`.normahub-review.example.yml`](.normahub-review.example.yml):

| Ключ | Описание | По умолчанию |
|---|---|---|
| `language` | `ru` или `en` — язык текста ревью | `en` |
| `model` | Переопределяет input `model` | — |
| `min_severity` | Отбрасывать findings ниже уровня: `CRITICAL`, `WARNING`, `SUGGESTION` | `SUGGESTION` |
| `custom_rules` | Дополнительные правила команды (список строк) | — |
| `ignore_patterns` | Дополнительные **regex** (не globs) для исключения файлов | — |

Паттерны — регулярные выражения: `^dist/`, `\\.generated\\.`. Невалидный regex не ломает запуск, а пропускается с предупреждением в логе. Если в паттерне нужна запятая (квантификаторы `{2,3}`), разделяйте паттерны переводом строки.

---


## Поддерживаемые модели

| Модель | Назначение | Стоимость на NormaHub (1M токенов) |
|---|---|---|
| `deepseek-v4.1-flash` | Рекомендуется по умолчанию. Быстрый и глубокий анализ логики. | **$0.018 in / $0.050 out** (~0.05 ₽ за ревью) |
| `claude-sonnet-5-5` | Архитектурный синтез и аудит безопасности сложных систем. | $0.35 in / $1.80 out |

---

## Лицензия

MIT License. См. [LICENSE](LICENSE).
