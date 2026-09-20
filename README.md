# config-merge-rehearsal-api

配置发布系统的**并发修改预演（dry-run rehearsal）服务**。客户端提交一份基准 JSON 文档和
A、B 两组 RFC 6902 补丁（仅支持 `add` / `remove` / `replace`），服务在**基准坐标系**下合并两组
补丁：以基准数组索引标识原元素、同一插入缝隙按 **A 后 B** 定序、自动重定位增删引起的索引漂移，
产出**确定的合并结果**；当两组补丁在同一元素/对象路径上发生「删除 vs 修改」或「不同值替换」等
冲突时，返回**结构化冲突**（含双方操作序号、规范化路径、原因）。

技术栈：Node.js 20+ · Fastify 5 · 纯内存存储（无外部依赖服务）。

---

## 快速开始

### 单条启动命令（Docker Compose，推荐）

```bash
docker compose up --build
```

依赖安装（`npm ci`）与初始化全部在镜像构建/启动阶段完成，无需额外步骤。

### 本地运行

```bash
npm ci && npm start
```

### 服务地址与端口

| 项 | 值 |
| --- | --- |
| 监听地址 | `0.0.0.0`（容器内） |
| 端口 | `3000` |
| 健康检查 | `http://localhost:3000/health` |
| 合并接口 | `POST http://localhost:3000/api/v1/merges` |

## 配置项（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | HTTP 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `LOG_LEVEL` | `info` | 日志级别（`debug` / `info` / `warn` / `error`） |
| `STORE_MAX` | `1000` | 内存中最多保留的预演记录数，超出后按 FIFO 淘汰 |

## API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/health` | 健康检查（存活/就绪探针） |
| `GET` | `/` | 服务元信息与端点清单 |
| `GET` | `/api/v1/example` | 返回示例请求体（干净合并 + 冲突各一份） |
| `POST` | `/api/v1/merges` | 执行合并预演，结果落内存存储 |
| `GET` | `/api/v1/merges` | 列出全部预演记录（摘要） |
| `GET` | `/api/v1/merges/:id` | 查询单条预演（含输入与结果） |
| `DELETE` | `/api/v1/merges/:id` | 删除单条预演（`204`） |

### `POST /api/v1/merges`

请求体：

```json
{
  "base":   { "任意": "JSON 文档" },
  "patchA": [ { "op": "replace", "path": "/replicas", "value": 3 } ],
  "patchB": [ { "op": "remove",  "path": "/servers/0" } ]
}
```

- `base`：任意 JSON 文档（对象、数组、标量均可）。
- `patchA` / `patchB`：RFC 6902 操作数组，**仅接受 `add` / `remove` / `replace`**；
  其他操作（`move`/`copy`/`test`）返回 `400`。
- 两组补丁都针对**同一份基准文档**求值（模拟两个变更基于同一版本并发提出）。

响应：

- **合并干净 → `200`**：`{ id, status: "clean", merged, conflicts: [], stats, createdAt }`
- **存在冲突 → `409`**：`{ id, status: "conflict", merged: null, conflicts: [...], stats, createdAt }`
- **补丁不合法（路径不存在、越界、缺 `value` 等）→ `422`**：
  `{ statusCode, error, code: "INVALID_PATCH", message, details: { side, index } }`
- **请求体结构/操作类型不合法 → `400`**

无论 `200` 还是 `409`，记录都会存入内存存储，可凭 `id` 查询。

## 示例请求

干净合并（也见 `examples/merge-request.json`，或 `GET /api/v1/example`）：

```bash
curl -s -X POST http://localhost:3000/api/v1/merges \
  -H 'Content-Type: application/json' \
  -d @examples/merge-request.json | jq
```

该示例中：A 把 `replicas` 改为 `3`、在 `servers` 索引 1 处插入一台机器、开启 `tracing`；
B 删除 `servers[0]`、在**同一插入缝隙**（索引 1）插入另一台机器、新增 `features.retries`、
同样开启 `tracing`。合并结果：

```json
{
  "status": "clean",
  "merged": {
    "app": "payment-service",
    "replicas": 3,
    "servers": [
      { "host": "a2.internal", "port": 8080 },
      { "host": "b2.internal", "port": 9090 },
      { "host": "b.internal",  "port": 8080 }
    ],
    "features": { "cache": true, "tracing": true, "retries": 3 },
    "tags": ["stable"]
  },
  "stats": { "received": { "A": 3, "B": 4 }, "normalized": { "A": 3, "B": 4 },
             "deduplicated": 1, "conflicts": 0, "applied": 6 }
}
```

可以看到：同一缝隙的插入按 **A 后 B** 排列；`servers[0]` 被删除后其余元素按基准身份
重新定位；双方对 `/features/tracing` 的相同修改被去重（`deduplicated: 1`）。

冲突示例（`examples/conflict-request.json`）：

```bash
curl -s -X POST http://localhost:3000/api/v1/merges \
  -H 'Content-Type: application/json' \
  -d @examples/conflict-request.json | jq
```

返回 `409`：

```json
{
  "status": "conflict",
  "merged": null,
  "conflicts": [
    {
      "reason": "delete-vs-modify",
      "path": "/database",
      "operations": [
        { "side": "A", "index": 0, "op": "remove",  "path": "/database" },
        { "side": "B", "index": 0, "op": "replace", "path": "/database/host", "value": "db2.internal" }
      ],
      "message": "one patch deletes this element while the other modifies it (A#0 vs B#0)"
    },
    {
      "reason": "replace-mismatch",
      "path": "/mode",
      "operations": [
        { "side": "A", "index": 1, "op": "replace", "path": "/mode", "value": "single" },
        { "side": "B", "index": 1, "op": "replace", "path": "/mode", "value": "readonly" }
      ],
      "message": "both patches replace the same target with different values (A#1 vs B#1)"
    }
  ]
}
```

其他常用命令：

```bash
curl -s http://localhost:3000/health | jq                 # 健康检查
curl -s http://localhost:3000/api/v1/merges | jq          # 预演记录列表
curl -s http://localhost:3000/api/v1/merges/<id> | jq     # 单条记录（含输入）
curl -s -X DELETE http://localhost:3000/api/v1/merges/<id> # 删除记录
```

## 合并语义

### 基准坐标模型

两组补丁中的所有路径都相对**基准文档**解释：数组索引标识的是基准数组中的**原元素**，
而非某个中间结果。服务据此重定位增删造成的索引漂移——例如 A 在 `/servers/0` 前插入、
B 修改 `/servers/2/host`，合并后 B 的修改仍落在基准第 2 号元素上（其新下标可能已变化）。

### 数组

- `add /arr/i`：在**缝隙 i**（基准第 i 号元素之前）插入；`i == 数组长度` 或 `-` 表示追加。
- 同一缝隙的多个插入：先 A 后 B，同侧保持补丁内顺序。
- `remove /arr/i`、`replace /arr/i`：作用于基准第 i 号元素，与其最终下标无关。
- 元素内部的深层修改（如 `/arr/1/host`）跟随元素身份漂移。

### 去重（不产生冲突）

- 双方 `replace` 同一目标且值深度相等 → 应用一次。
- 双方 `remove` 同一目标 → 应用一次。
- 一方删除祖先路径、另一方删除其内部后代 → 后代删除被祖先覆盖，丢弃。
- 双方 `add` 同一个新对象成员且值相等 → 应用一次。

### 冲突类型（返回 `409`）

| `reason` | 含义 |
| --- | --- |
| `delete-vs-modify` | 一方删除某元素/子树，另一方对同一路径或其内部做 `replace`/`add` |
| `replace-mismatch` | 双方 `replace` 同一目标但值不同 |
| `add-mismatch` | 双方 `add` 同一个（基准中不存在的）对象成员但值不同 |
| `replace-overlap` | 一方整体替换某子树，另一方修改其子树内部 |

每条冲突包含：`reason`（原因）、`path`（规范化后的争议路径，RFC 6901 转义）、
`operations`（双方操作的 `side`、`index`（操作序号）、`op`、`path`、`value`）、`message`。

### 补丁内规则（同一补丁）

- 同一路径的多个非插入操作：**后者覆盖前者**（last-wins）；数组插入不去重，按序累积。
- 不允许一个操作的路径是另一个 `add`/`remove`/`replace` 目标的**后代**（返回 `422`），
  数组插入除外（插入不占有子树）。
- 对象成员上的 `add` 若键已存在，按 RFC 6902 规范化为 `replace`。
- 不支持删除文档根（`remove ""`）；`replace ""` 允许整体替换文档。

## 测试

```bash
npm test
```

覆盖：指针转义、索引漂移重定位、同缝隙 A/B 定序、去重规则、全部冲突类型、
非法补丁（`422`）、schema 校验（`400`）、存储的增删查、健康检查等。

## 项目结构

```
.
├── server.js                  # 进程入口：读取环境变量、启动与优雅退出
├── src/
│   ├── app.js                 # Fastify 应用：路由、schema 校验、错误处理
│   ├── merge.js               # 合并引擎：规范化 → 补丁内解析 → 跨补丁冲突检测 → 应用
│   ├── store.js               # 内存存储（FIFO 淘汰）
│   └── example.js             # 内置示例请求
├── test/                      # node:test 单元 + 集成测试
├── examples/                  # 可直接 curl 的示例请求体
├── Dockerfile                 # 多阶段构建（npm ci 在构建期完成）
└── docker-compose.yml         # 单服务编排 + 健康检查
```

## 说明与限制

- 存储为进程内存，重启即清空；如需持久化可在 `src/store.js` 替换实现。
- 合并是确定性的：同一输入永远产生同一输出（冲突列表按路径与原因排序）。
- 单补丁内操作按基准坐标解释，不做补丁内顺序重放；同路径多操作按 last-wins 处理（见上）。
