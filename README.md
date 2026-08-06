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

### 手動デプロイ

```bash
# API
cd apps/api && bun wrangler deploy

# Web
# NEXT_PUBLIC_API_URL を明示すること。指定しないと .env.local の値
# （ローカル開発では http://localhost:8787）がバンドルに焼き付き、
# 本番サイトが利用者のブラウザから localhost へ投げて起票が全件失敗する。
# 一覧側（Server Component）は wrangler.jsonc の vars が使われる
cd apps/web && NEXT_PUBLIC_API_URL=https://world-issue-tracker-api.mktoho.workers.dev bun run deploy
```

### デプロイ後の確認

**本番環境には確認用の Issue を起票しないでください。**
投稿された Issue はトップページの「最近の Issue」にそのまま並びます。件数が少ないうちは
テストデータがトップの大半を占め、初回訪問者には「運用されていないサービス」に見えます。
実際に「テスト Issue — デプロイ確認用」が本番トップに残り続けていました（#69）。

デプロイが成功したかどうかは、書き込みをせずに次の 2 つで確認できます。

```bash
# API が起動していて D1 にも繋がっているか（health は D1 に SELECT を投げている）
# 異常時は 500 + {"status":"unhealthy"} なので、-f で終了コードに出す
curl -fs https://world-issue-tracker-api.mktoho.workers.dev/health
# => {"status":"healthy"}

# 一覧が取得できるか（GET /issues は公開エンドポイント。認証不要）
curl -fs "https://world-issue-tracker-api.mktoho.workers.dev/issues?limit=1"

# Web から API へ実際に到達できているか（Server Component の fetch 経路の確認）
curl -fs https://world-issue-tracker-web.mktoho.workers.dev/ | grep -q "最近の Issue" && echo OK
```

起票・更新まで含めて確かめたい場合は、本番ではなくローカル（`bun dev`）か、
`--local` の D1 に対して行ってください。

### 本番に入れてしまったデータを消す

やむを得ず本番へ書き込んでしまった場合は、その場で消してください。
`DELETE /issues/:id` は所有者本人しか実行できず、確認用のアカウントが違ったり
`user_id` が入っていない行だと 403 になるため、確実なのは D1 を直接操作する経路です。

```bash
cd apps/api

# 1. 消す対象を先に特定する（id を確認せずに DELETE を打たない）
bun wrangler d1 execute world-issue-tracker --remote \
  --command "SELECT id, title, user_id, created_at FROM issues ORDER BY created_at DESC LIMIT 10"

# 2. id を指定して 1 件だけ消す
bun wrangler d1 execute world-issue-tracker --remote \
  --command "DELETE FROM issues WHERE id = '<上で確認した id>'"

# 3. 消えたことを確認する（公開 API 側にも反映されているか）
curl -fs "https://world-issue-tracker-api.mktoho.workers.dev/issues?limit=50"
```

`--remote` を付けないとローカルの D1 が対象になり、本番のデータは残ったままになります。
逆に `WHERE` を省いたり条件を緩めたりすると実データを巻き込むため、
**必ず `id` で 1 件を指定**してください。

## ライセンス

[MIT](LICENSE)
