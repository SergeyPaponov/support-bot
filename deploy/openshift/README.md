# WP2: OpenShift deployment

Манифесты и Containerfile подготовлены на основе WP1 (`dff23c3`). Бизнес-логика, providers, sanitization и REST contracts сохранены; в текущей ветке MCP server и transport удалены. Команды ниже предназначены для ручного выполнения оператором; никакого автоматического deploy/merge нет.

## Сборка production-образа

Из корня репозитория, Docker с BuildKit:

```sh
npm ci
npm run typecheck
npm run build
npm test
docker build -f Containerfile -t support-bot:wp2 .
node scripts/container-smoke.mjs support-bot:wp2
```

Containerfile использует Node.js 24, отдельные build и production-dependencies stages. Оба `npm ci` используют существующий lockfile; runtime получает только production dependencies, `dist/src`, `package.json` и встроенную `config/sanitization-policy.json`. Исходники, тесты, dev dependencies, `.git`, `.env`, registry credentials и deployment Secret examples не копируются в runtime. `.dockerignore` задаёт allowlist build context.

Runtime запускает напрямую тот же production entrypoint, что и `npm start`:

```text
node --use-env-proxy --env-file-if-exists=.env dist/src/index.js
```

Node является PID 1 и получает SIGTERM. `.env` в образе отсутствует; конфигурация поступает через environment. Сообщение Node о том, что optional `.env` отсутствует, допустимо.

Image USER — `1001:0`. Deployment не фиксирует UID/GID/fsGroup, чтобы OpenShift restricted SCC мог назначить UID из диапазона namespace. Runtime files доступны на чтение произвольному UID и не требуют writable application directory, root, privileged mode, service-account token или PVC. Проверка запускается с UID `1000770001`, read-only root filesystem, drop ALL capabilities, no-new-privileges, лимитом 1 CPU/1 GiB.

Для воспроизводимого релиза используйте одобренный base digest через `--build-arg NODE_IMAGE=node:24-bookworm-slim@sha256:...`, затем immutable tag/digest готового образа. По умолчанию base tag обновляемый. Этот образ на Debian slim; он совместим с проверенными ограничениями runtime, но не заявляется как Red Hat certified/UBI image. Подмена base на другой дистрибутив требует повторной проверки.

### Build proxy и CA

Docker поддерживает стандартные proxy build arguments; текущие настройки Docker credential store изменять не требуется. Если сборке нужен корпоративный CA, передайте **публичный CA**, а не credentials, как BuildKit secret:

```sh
docker build -f Containerfile \
  --secret id=proxy_ca,src=/secure/pki/company-ca.pem \
  -t support-bot:wp2 .
```

CA монтируется только на время dependency installation и расширяет Node/npm trust. Он не копируется в слои. Не отключайте TLS verification. Не передавайте application credentials через build args или Containerfile ENV.

В этой managed cloud среде использовались предоставленный `CODEX_PROXY_CERT`, существующие Docker proxy defaults и writable cache:

```sh
BUILDX_CONFIG=/tmp/support-bot-buildx docker build -f Containerfile \
  --secret id=proxy_ca,src="$CODEX_PROXY_CERT" -t support-bot:wp2 .
npm ci --cache /tmp/support-bot-wp2-npm --no-audit --no-fund
```

В этой ветке логи извлекаются только через API Connect Analytics. `SPLUNK_*` не нужны; удалите устаревшие поля из локальных overlays/Secrets при следующем согласованном обновлении. Обязательные credentials: `SERVER_API_KEY`, `APIC_TOKEN`, `LLM_API_KEY`. Поле ответа `sources.splunk` сохраняется со значением `0`.

## Transaction-ID-only HTTP workflow

`POST /api/analyze` принимает только `{"transaction_id":"abc-123-xyz"}`. Время и API ID клиент не задаёт: сервер рассчитывает единое UTC окно последних 14 суток, читает все подходящие Analytics events и определяет API по `api_ref` (`name:version`), либо по однозначному `api_name`. Успешная схема ответа не меняется. `APIC_TRANSACTION_FIELD` остаётся серверной настройкой: `global_transaction_id` по умолчанию, `transaction_id` для gateway-local ID.

Укажите реальные `APIC_ORG`/`APIC_CATALOG` (имя либо ID той же области, которую возвращает Analytics). Новый `APIC_SPEC_URL_TEMPLATE` использует `{org}`/`{catalog}` из настроенного scope, сверенного с metadata, и `{apiId}` с сохранённой версией. Фиксированный native URL тоже допустим при совпадении scope. Область другой организации/каталога не выбирается автоматически: несовпадение или конфликт metadata приводит к структурированной ошибке.

Для name fallback нужен catalog list endpoint и `product:view`. При native document URL list выводится автоматически; для custom routing добавьте `APIC_API_LIST_URL_TEMPLATE` с `{apiName}` в ConfigMap. Name fallback читает весь список, выбирая ровно одну версию (с учётом `api_version`, если задана). Никакого выбора latest/первого элемента нет. Ошибки запроса по валидному `api_ref` не приводят к name fallback. Проверяется совпадение `info.version` полученной спецификации.

Успешный пустой Analytics search даёт `404 TRANSACTION_NOT_FOUND`; ошибки связи/auth/schema источников — upstream errors. Сохраняются 200-event/20-page Analytics limits, timeout и concurrency. Более длинное окно не гарантирует, что любой поиск уложится в 90-секундный shutdown budget; лимит остаётся best effort. Для интеграционной проверки используйте известную транзакцию в последние 14 суток, не передавайте timestamps/API ID в body. Operational logs не содержат transaction ID, metadata либо текст upstream errors.

## Манифесты и ресурсы

| Файл | Назначение |
| --- | --- |
| `deployment.yaml` | 1 replica, port 3000, restricted security context, probes и env references |
| `service.yaml` | ClusterIP, port/target port 3000; public Route отсутствует |
| `configmap.yaml` | Несекретная runtime конфигурация; URL/model/org/catalog placeholders нужно заменить |
| `secret.example.yaml` | Только пример с пустыми credentials; не включён в Kustomize base |
| `kustomization.yaml` | Base из ConfigMap, Service и Deployment |
| `policy-mount.patch.yaml` | Optional approved policy ConfigMap mount и `DATA_POLICY_FILE` |
| `corporate-ca.patch.yaml` | Optional public CA ConfigMap mount и `NODE_EXTRA_CA_CERTS` |

| Ресурс | Request | Limit |
| --- | --- | --- |
| CPU | 250m | 1000m |
| Memory | 512Mi | 1Gi |

`HOST=0.0.0.0`, `PORT=3000`. Это начальные значения, не результат load testing. Default RollingUpdate может временно создать второй pod; namespace quota должна это позволять. Concurrency limit действует на pod, а не глобально.

Используйте явные resource files или Kustomize base. Команда `oc apply -f deploy/openshift` для всего каталога не подходит: там также находятся неполные patch-документы и Secret example.

## Ручное развёртывание через oc

Предварительно: авторизованный `oc`, доступный namespace и опубликованный в разрешённом registry образ. Сборка и smoke test сами образ в registry не отправляют.

```sh
export SUPPORT_BOT_IMAGE=registry.example.com/team/support-bot:wp2
export SUPPORT_BOT_NAMESPACE=banking-poc
docker tag support-bot:wp2 "$SUPPORT_BOT_IMAGE"
docker push "$SUPPORT_BOT_IMAGE"
oc project "$SUPPORT_BOT_NAMESPACE"
```

Замените placeholders в `configmap.yaml` реальными **несекретными** настройками до применения. Не добавляйте credentials в ConfigMap. Создайте Secret через принятый в организации secure workflow; пример для защищённого файла вне checkout (`chmod 600`, три ключа из `secret.example.yaml`):

```sh
oc create secret generic support-bot-secrets \
  --from-env-file=/secure/support-bot/credentials.env \
  --dry-run=client -o yaml | oc apply -f -
oc apply -f deploy/openshift/configmap.yaml
oc set image --local -f deploy/openshift/deployment.yaml \
  "support-bot=$SUPPORT_BOT_IMAGE" -o yaml | oc apply -f -
oc apply -f deploy/openshift/service.yaml
oc rollout status deployment/support-bot --timeout=120s
```

Не применяйте `secret.example.yaml` без заполнения: пустые значения намеренно не проходят startup validation. Минимальная длина `SERVER_API_KEY` — 24. Не передавайте credentials в shell history через `--from-literal`. При private registry настройте namespace/service-account imagePullSecrets согласно процедуре вашей организации; Secret приложения не используется для image pull.

Для GitOps можно использовать локальный Kustomize overlay с base `deploy/openshift`, собственным ConfigMap patch и `images` replacement. Проверка base без cluster access:

```sh
oc kustomize deploy/openshift
```

Base сам по себе содержит placeholder image `support-bot:wp2`. Перед `oc apply -k` задайте разрешённый registry image в overlay. Secret не создаётся Kustomize base автоматически. Server-side admission можно проверить вручную через `oc apply --dry-run=server -f <rendered-file>`; это не выполнялось в данной среде.

## External sanitization policy

Если `DATA_POLICY_FILE` не задан, загружается встроенная policy из образа. Для утверждённого внешнего файла:

```sh
oc create configmap support-bot-policy \
  --from-file=sanitization-policy.json=/secure/support-bot/approved-policy.json \
  --dry-run=client -o yaml | oc apply -f -
oc patch deployment/support-bot --type=strategic \
  --patch-file=deploy/openshift/policy-mount.patch.yaml
oc rollout status deployment/support-bot --timeout=120s
```

Policy доступна read-only по `/etc/support-bot/sanitization-policy.json`, `defaultMode: 0444`, что позволяет произвольному UID читать ConfigMap. Не помещайте secrets или реальные клиентские примеры внутрь policy. Для Docker bind mount нужен аналогичный read permission; host umask может сделать только что созданный файл недоступным UID контейнера.

Изменение ConfigMap не перезагружает policy в работающем Analyzer. После review и обновления ConfigMap нужен контролируемый restart:

```sh
oc rollout restart deployment/support-bot
oc rollout status deployment/support-bot --timeout=120s
```

Неподдерживаемая/нечитаемая policy останавливает приложение до открытия listener; fallback на встроенную policy при явно заданном файле отсутствует. Храните утверждённые версии для rollback: `oc rollout undo` сам по себе не восстанавливает содержимое mutable ConfigMap. Для production GitOps предпочтительны versioned/hashed ConfigMap names.

## Corporate proxy и runtime CA

Приложение сохраняет поддержку `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` и `NODE_EXTRA_CA_CERTS`. Для authenticated proxy URLs используйте дополнительные ключи в `support-bot-secrets`; для несекретных proxy URLs можно использовать ConfigMap. Не дублируйте один ключ в ConfigMap и Secret. Учитывайте локальные/cluster destinations в NO_PROXY и правила egress вашей сети.

Публичный CA bundle можно смонтировать отдельно, без изменения image/system trust и без root:

```sh
oc create configmap support-bot-corporate-ca \
  --from-file=ca-bundle.pem=/secure/pki/company-bundle.pem \
  --dry-run=client -o yaml | oc apply -f -
oc patch deployment/support-bot --type=strategic \
  --patch-file=deploy/openshift/corporate-ca.patch.yaml
oc rollout status deployment/support-bot --timeout=120s
```

После последующих изменений CA/Secret/config нужен контролируемый restart. Runtime trust file остаётся mounted data, а не image layer. CA patch совместим с policy patch.

## Probes, доступ и остановка

Startup и liveness используют существующий публичный `/healthz` (200, `{"status":"ok"}`). Readiness использует публичный `/readyz`: 200 (`{"status":"ready"}`) после успешной проверки локальной конфигурации/policy и открытия listener; 503 (`{"status":"not_ready"}`) при initializing/draining. Readiness не подтверждает доступность APIC/LLM, действительность credentials или разрешения сети и не вызывает внешние API. После закрытия listener probe может получить connection refusal вместо HTTP 503 — pod всё равно не Ready.

Сервис обслуживает только REST `POST /api/analyze` и публичные `GET /healthz`, `GET /readyz`. MCP endpoint `/mcp` удалён. Для вызовов нужен существующий Bearer key. Public Route/Ingress, новые auth/RBAC и TLS termination не создаются. Доступ для ручной проверки без Route:

```sh
oc port-forward service/support-bot 3000:3000
# В другом терминале:
curl --fail http://127.0.0.1:3000/healthz
curl --fail http://127.0.0.1:3000/readyz
oc logs -f deployment/support-bot
```

Внутренний Service использует HTTP. При необходимости TLS/mTLS или более строгой namespace isolation используйте одобренные ingress/mesh/network policy решения отдельной задачей.

WP2.2 пишет JSON Lines в stdout (startup, ready, shutdown started/completed, analysis success) и stderr (startup/analysis failure, shutdown timeout). Поля: UTC timestamp, level, event, generated requestId, interface (`process`/`REST`), durationMs, outcome, safe errorCode. Клиентские IDs/headers, URLs, bodies, credentials, события Analytics, specs, LLM prompts/completions и тексты исключений не логируются. Unknown codes → `INTERNAL_ERROR`; startup failures → `STARTUP_FAILED`. Записи синхронные и небольшие; учитывайте возможную задержку event loop при медленном collector.

SIGINT/SIGTERM немедленно и idempotently включают draining, закрывают admission новых analyses (`503 DRAINING`) и вызывают `server.close()`. Инициализация использует `503 NOT_READY`. Новые TCP connections не принимаются; уже начатые REST requests получают возможность завершиться, включая analysis после client disconnect. Повторные сигналы не меняют deadline. Shutdown ждёт HTTP close и завершения активных analysis promises; затем `shutdown_completed`, exit 0. Только по истечении `SHUTDOWN_TIMEOUT_MS` вызывается `closeAllConnections()`, пишется `shutdown_timeout`, exit 1. Smoke harness проверяет idle stop; npm tests также проверяют настоящие SIGTERM во время REST calls с mock upstream barrier и deadline/repeated signals через injectable clock.

Default `SHUTDOWN_TIMEOUT_MS=90000` задан в ConfigMap; `terminationGracePeriodSeconds=105` даёт дополнительный запас. Это **best-effort operational budget**, не гарантия zero-downtime: pagination и последовательные upstream стадии могут превысить deadline; SIGKILL/OOM/event-loop stalls могут помешать graceful shutdown. При override согласуйте grace period и rollout timeout. Не изменены upstream timeout (20000 ms), fail-fast provider behavior, retries и business/sanitization semantics. ConfigMap/Secret updates требуют restart, как и прежде.

## Проверка текущей ветки

Transaction-only версия: `npm run typecheck`, `npm run build`, `npm test` — **124 passed, 0 failed**. Проверены строгий HTTP contract, точное 14-дневное UTC окно, Analytics pagination/errors, API identity/version/scope, безопасный name fallback, REST output compatibility, operational logging и SIGTERM на mock upstreams. YAML и scoped URL template проверены локально. Container smoke harness обновлён для transaction-only body; образ в этой итерации не пересобирался, container smoke / OpenShift admission и реальные Analytics/Management/LLM повторно не вызывались.

## Историческая проверка WP2 и ограничения

- `npm ci` по lockfile (с writable cache в `/tmp`), `npm run typecheck`, `npm run build`, `npm test`: **63 passed, 0 failed**.
- Production image собран Docker/BuildKit с Node.js 24; TLS verification сохранена, build CA передан secret mount.
- `scripts/container-smoke.mjs`: встроенная и custom mounted policies, реальный production entrypoint, UID `1000770001`, read-only filesystem, dropped capabilities и analysis calls. Все внешние API в harness имитируются внутри контейнера; WP1 pattern validation и отсутствие raw sensitive values в LLM body проверяются.
- Invalid mounted policy: startup exit 1 без fallback. SIGTERM для валидных конфигураций: exit 0.
- Runtime metadata/filesystem проверены на отсутствие embedded credential env, `.env`, source/test/dev dependencies и build CA. Дополнительно synthetic canaries из исключённых `.env` и nondefault config файлов не найдены в сохранённых runtime image layers. Это проверка build boundary, не универсальный независимый secrets/vulnerability audit всех upstream dependencies.
- Runtime HTTPS через существующий cloud proxy с read-only CA mount вернул HTTP 200 при включённой проверке TLS.
- Kustomize base и оба strategic patches обработаны локально `kubectl v1.34.1`; Deployment/Service/ConfigMap YAML и image replacement проверены без cluster access.

В среде не было `oc` и OpenShift cluster connection. SCC admission, registry pull, cluster DNS/egress, probes через kubelet и реальные внешние API **не проверялись**. Docker security flags не заменяют проверку реального restricted SCC. Production image signing, SBOM/vulnerability scanning, admission policies и load testing остаются частью release-процесса. Новые auth, business logic, provider changes, transport rewrite, автоматический merge и deploy в WP2 не входят.
