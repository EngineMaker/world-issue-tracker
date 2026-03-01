# World Issue Tracker

> 地球のバグを、みんなで可視化して、みんなで直す

ソフトウェア開発の Issue Tracker を現実世界に適用し、個人の困りごとから国際問題まで、あらゆるスコープの課題を一つのプラットフォームで可視化・解決に導くサービスです。

**裏テーマ**: 隣り合う Issue が視野を広げる。blame ではなく fix。対立ではなく issue。

## コアコンセプト

- **Issue のスコープ階層**: 個人 → 近隣・コミュニティ → 自治体 → 国 → 世界
- **ライフサイクル**: `Open → Triaged → In Progress → Review → Resolved → Closed`

## 技術スタック

| レイヤー | 技術 |
|---------|------|
| モノレポ | Turborepo |
| API サーバー | Hono (TypeScript) → Cloudflare Workers |
| フロントエンド | Next.js (App Router) → Cloudflare Pages (OpenNext) |
| データベース | Cloudflare D1 (SQLite 互換) |
| 認証 | Clerk |
| 共有型定義 | Zod スキーマ (`packages/shared`) |
| リンター/フォーマッター | Biome |
| テスト | Vitest |
| IaC | wrangler.jsonc |
| 言語 | TypeScript 統一 |

## ディレクトリ構成

```
world-issue-tracker/
├── apps/
│   ├── api/          # Hono API (Cloudflare Workers)
│   └── web/          # Next.js フロントエンド (Cloudflare Pages)
├── packages/
│   └── shared/       # Zod スキーマ、型定義、バリデーション
├── turbo.json
├── package.json
└── CLAUDE.md
```

## ローカル開発セットアップ

### 前提条件

- [Bun](https://bun.sh/) v1.3.8+
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/) (bun install で自動インストール)

### 手順

```bash
# 依存関係をインストール
bun install

# API 用の環境変数を設定
cp apps/api/.dev.vars.example apps/api/.dev.vars
# apps/api/.dev.vars に Clerk のシークレットキーを記入

# Web 用の環境変数を設定
cp apps/web/.env.local.example apps/web/.env.local
# apps/web/.env.local に Clerk のキーを記入

# D1 のローカルマイグレーションを適用
cd apps/api && bun wrangler d1 migrations apply world-issue-tracker --local && cd ../..

# 開発サーバーを起動
bun dev
```

API は `http://localhost:8787`、Web は `http://localhost:3000` で起動します。

## デプロイ

本番環境は Cloudflare にデプロイされています:

| サービス | URL |
|---------|-----|
| API | https://world-issue-tracker-api.mktoho.workers.dev |
| Web | https://world-issue-tracker-web.mktoho.workers.dev |

### GitHub Actions による自動デプロイ

`main` ブランチへの push 時に自動デプロイが実行されます。

以下のシークレットを GitHub リポジトリの Settings > Secrets に設定してください:

- `CLOUDFLARE_API_TOKEN` — Cloudflare API トークン（Workers + D1 の編集権限）
- `CLOUDFLARE_ACCOUNT_ID` — Cloudflare アカウント ID
- `CLERK_SECRET_KEY` — Clerk シークレットキー（Web ビルド用）
- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` — Clerk パブリッシャブルキー（Web ビルド用）

### 手動デプロイ

```bash
# API
cd apps/api && bun wrangler deploy

# Web
cd apps/web && bun run deploy
```

## ライセンス

[MIT](LICENSE)
