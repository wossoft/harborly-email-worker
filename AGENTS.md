# Agent 说明

改动本仓库代码后必须执行并通过：

```bash
pnpm exec prettier --write <改动的文件>
pnpm lint
pnpm typecheck
```

commit 时由 pre-commit hook 自动格式化暂存文件；lint 存在无法自动修复的错误时提交会被中止。

依赖变更用 `pnpm add` / `pnpm remove`，不要手改 `pnpm-lock.yaml`。

部署步骤、安全与隐私禁令见 README；未经明确要求不要执行 `wrangler deploy`。
