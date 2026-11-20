# Выручка фич

Панель BB для оценки выручки фич Mashina.kg. Она показывает прогноз релиза, шаги расчёта, сценарии изменений, приоритеты и замеры.

## Установка

Нужен BB 0.50.1 или новее на Windows. Установите плагин из GitHub.

```powershell
bb plugin install https://github.com/muringeorgia-sys/bb-plugin-feature-revenue
```

В настройках установленного плагина укажите абсолютный путь к рабочей папке Mashina.kg в поле `projectRoot`. В ней должны быть калькулятор `03_scripts/stable/feature_revenue/build.py`, конфиги в `03_scripts/stable/feature_revenue/releases/` и методика. Укажите `python`, если подходящий Python с зависимостями калькулятора запускается другой командой. После изменения настроек работающей панели перезагрузите её командой `bb plugin reload feature-revenue`.

Для задач ИИ задайте `projectId` и `environmentId` своего проекта BB. Панель запускает задачи через провайдер Claude Code. Для работы с Jira использует адрес и поля из `jira` в локальном конфиге, а также переменные `ATLASSIAN_EMAIL` и `ATLASSIAN_API_TOKEN`. При настроенной интеграции панель сверяет ICE по будням.

Репозиторий содержит исходники панели. Калькулятор, рабочие конфиги, данные и значения настроек хранятся в локальной среде.

## Сборка из исходников

```powershell
npm ci
bb plugin types --check
npx tsc --noEmit
bb plugin build .
```
