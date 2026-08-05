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
# NEXT_PUBLIC_API_URL はローカル開発なら既定値のままでよい

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

Web が参照する API の URL (`NEXT_PUBLIC_API_URL`) はシークレットではないため、
設定ファイルに直接書いています。デプロイ先を変えたときは **2 箇所**を更新してください:

- `.github/workflows/deploy.yml` — ビルド時。Client Component のバンドルに埋め込まれる
- `apps/web/wrangler.jsonc` の `vars` — 実行時。Server Component が `process.env` から読む

`NEXT_PUBLIC_` の値がバンドルへ埋め込まれるのは Client Component だけです。
一覧を取得する Server Component（`app/page.tsx`、`app/issues/page.tsx`）は
Workers 上で `process.env` を評価するため、`vars` が無いと既定値の
`http://localhost:8787` へ fetch して一覧が取得できなくなります。
片方だけ更新すると値がズレるので、両者の一致は
`apps/api/test/node/web-runtime-env.test.ts` で検査しています。

D1 のマイグレーションは、API のデプロイに先立って自動で適用されます
(`.github/workflows/deploy.yml` の `Apply D1 migrations`)。
新しいテーブルを前提にしたコードが先に本番へ出ないよう、順序を入れ替えないでください。

### 手動デプロイ

```bash
# API
# マイグレーションを先に適用する。`--remote` を忘れるとローカルの
# .wrangler に当たるだけで、本番の D1 は変わらないまま成功扱いになる
cd apps/api
bun wrangler d1 migrations apply world-issue-tracker --remote
bun wrangler deploy
cd ../..

# Web
# NEXT_PUBLIC_API_URL を明示すること。指定しないと .env.local の値
# （ローカル開発では http://localhost:8787）がバンドルに焼き付き、
# 本番サイトが利用者のブラウザから localhost へ投げて起票が全件失敗する。
# 一覧側（Server Component）は wrangler.jsonc の vars が使われる
cd apps/web && NEXT_PUBLIC_API_URL=https://world-issue-tracker-api.mktoho.workers.dev bun run deploy
```

## ライセンス

[MIT](LICENSE)
